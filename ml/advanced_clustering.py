"""Offline, reproducible clustering audit. Never reads MongoDB or overwrites live artifacts.

Run with Python plus numpy, pandas, scipy, scikit-learn, hdbscan, torch, matplotlib.
Optional local dependencies: --deps C:/ghostTracker/.analysis-deps
Outputs are restricted to --output-dir (default output/clustering/advanced_analysis).
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import sys
import warnings

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--deps', type=Path)
parser.add_argument('--output-dir', type=Path)
args = parser.parse_args()
if args.deps:
    sys.path.insert(0, str(args.deps.resolve()))
os.environ['OMP_NUM_THREADS'] = '2'
os.environ['OPENBLAS_NUM_THREADS'] = '2'
sys.dont_write_bytecode = True

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.cluster import KMeans, AgglomerativeClustering, DBSCAN
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize
from sklearn.metrics import (silhouette_score, silhouette_samples, davies_bouldin_score,
                             calinski_harabasz_score, adjusted_rand_score, pairwise_distances)
from sklearn.model_selection import GroupShuffleSplit
from sklearn.decomposition import PCA
from threadpoolctl import threadpool_limits
import hdbscan

warnings.filterwarnings('ignore', category=FutureWarning)
HERE = Path(__file__).resolve().parent
OUT = args.output_dir or HERE / 'output/clustering/advanced_analysis'
OUT.mkdir(parents=True, exist_ok=True)
BASE_FILE = HERE / 'output/clustering/cluster_results.csv'
ALL_FILE = HERE / 'output/clustering/dignolucir_all_sessions.csv'
META_FILE = HERE / 'output/unsupervised_semantic/cluster_meta.json'
MODEL_FILE = HERE / 'output/unsupervised_semantic/bert_encoder.pt'
SEED = 20260910
LIFECYCLE = {'START_SESSION', 'EXIT_SESSION', 'EXIT_BOUNCE', 'INACTIVE',
             'TAB_OUT', 'TAB_RETURN', 'DISTRACTED_EPISODE'}
PASSIVE = {'HOVER_ELEMENT', 'CLICK_ELEMENT'}


def dump(name, value):
    def convert(x):
        if isinstance(x, np.ndarray): return x.tolist()
        if isinstance(x, np.generic): return x.item()
        if isinstance(x, Path): return str(x)
        raise TypeError(type(x).__name__)
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                     default=convert, allow_nan=False), encoding='utf-8')


def parse_tokens(sequence):
    return [tuple(t.split('|')) for t in str(sequence).split() if len(t.split('|')) == 3]


def token_documents(sequence, kind):
    tokens = parse_tokens(sequence)
    if kind == 'atomic':
        return ' '.join('|'.join(t) for t in tokens)
    # Factorized representations retain unseen page/action combinations. Do not truncate.
    actions = [t[1] for t in tokens if t[1] not in LIFECYCLE]
    if kind == 'actions':
        return ' '.join(actions) or 'NO_ACTION'
    if kind == 'pages':
        pages = [t[0] for t in tokens if t[1] not in LIFECYCLE] or [t[0] for t in tokens]
        return ' '.join(pages) or 'UNKNOWN'
    if kind == 'transitions':
        # Consecutive repetitions add no new ordering information.
        actions = [a for i, a in enumerate(actions) if i == 0 or a != actions[i-1]]
        return ' '.join(a+'>'+b for a, b in zip(actions, actions[1:])) or 'NO_TRANSITION'
    raise ValueError(kind)


def informative(sequence):
    tokens = parse_tokens(sequence)
    return len(tokens) >= 3 and any(t[1] not in LIFECYCLE for t in tokens)


class Features:
    def __init__(self, mode):
        self.mode = mode
        self.vectorizers = []

    def fit_transform(self, rows):
        specs = [('atomic', 1.0)] if self.mode == 'atomic' else [
            ('actions', 0.65), ('pages', 0.15), ('transitions', 0.20)]
        arrays = []
        for kind, weight in specs:
            v = TfidfVectorizer(tokenizer=str.split, token_pattern=None, lowercase=False,
                                sublinear_tf=True, norm='l2', min_df=1)
            docs = [token_documents(s, kind) for s in rows.semantic_sequence]
            arrays.append(v.fit_transform(docs).toarray() * np.sqrt(weight))
            self.vectorizers.append((kind, weight, v))
        return normalize(np.hstack(arrays))

    def transform(self, rows):
        arrays = [v.transform([token_documents(s, kind) for s in rows.semantic_sequence]).toarray()
                  * np.sqrt(weight) for kind, weight, v in self.vectorizers]
        return normalize(np.hstack(arrays))


def score(X, labels):
    labels = np.asarray(labels)
    valid = labels >= 0
    counts = collections.Counter(labels[valid].tolist())
    result = dict(n=len(labels), assigned=int(valid.sum()), coverage=float(valid.mean()),
                  k=len(counts), noise=int((~valid).sum()), counts=dict(sorted(counts.items())))
    if len(counts) >= 2 and valid.sum() > len(counts):
        xv, yv = X[valid], labels[valid]
        sv = silhouette_samples(xv, yv, metric='euclidean')
        result.update(silhouette=float(sv.mean()), silhouette_cosine=float(silhouette_score(xv, yv, metric='cosine')),
                      db=float(davies_bouldin_score(xv, yv)), ch=float(calinski_harabasz_score(xv, yv)),
                      negative_fraction=float((sv < 0).mean()),
                      macro_silhouette=float(np.mean([sv[yv == k].mean() for k in counts])),
                      min_cluster=int(min(counts.values())), largest_share=float(max(counts.values())/valid.sum()))
    else:
        result.update(silhouette=None, silhouette_cosine=None, db=None, ch=None,
                      negative_fraction=None, macro_silhouette=None, min_cluster=0, largest_share=1.0)
    return result


def fit_model(X, spec):
    alg = spec['algorithm']
    if alg == 'kmeans':
        return KMeans(n_clusters=spec['k'], random_state=SEED, n_init=30).fit_predict(X)
    if alg in ('ward', 'average'):
        return AgglomerativeClustering(n_clusters=spec['k'], linkage=alg).fit_predict(X)
    if alg == 'hdbscan':
        return hdbscan.HDBSCAN(min_cluster_size=spec['min_cluster_size'],
                              min_samples=spec['min_samples'], core_dist_n_jobs=1).fit_predict(X)
    if alg == 'dbscan':
        return DBSCAN(eps=spec['eps'], min_samples=spec['min_samples']).fit_predict(X)
    raise ValueError(alg)


def nearest_centroid(X, train_x, train_y):
    ids = sorted(set(train_y) - {-1})
    if not ids: return np.full(len(X), -1)
    centers = np.array([train_x[train_y == cid].mean(axis=0) for cid in ids])
    return np.asarray(ids)[pairwise_distances(X, centers).argmin(axis=1)]


def stability(X, spec, labels, repeats=20):
    rng = np.random.default_rng(SEED + 1)
    scores = []
    for _ in range(repeats):
        ix = np.sort(rng.choice(len(X), int(len(X)*0.8), replace=False))
        y = fit_model(X[ix], spec)
        # Noise is retained here, so the stability figure includes abstention changes.
        scores.append(adjusted_rand_score(labels[ix], y))
    return dict(mean=float(np.mean(scores)), p10=float(np.quantile(scores, .1)),
                p90=float(np.quantile(scores, .9)), values=scores,
                method='80% unique-pattern subsampling; fixed representation; ARI including noise')


def embed_baseline(base, meta):
    import torch
    from train_transformer_encoder import SessionTransformerEncoder
    torch.set_num_threads(2)
    checkpoint = torch.load(MODEL_FILE, map_location='cpu', weights_only=False)
    cfg = checkpoint['model_config']
    model = SessionTransformerEncoder(**cfg)
    model.load_state_dict(checkpoint.get('model_state_dict', checkpoint.get('encoder_state')), strict=True)
    model.eval()
    vocab = meta['vocab']
    max_len = cfg['max_len']
    pooling = checkpoint.get('pooling', meta.get('pooling', 'mean'))
    embeds = []
    with torch.no_grad():
        for seq in base.sequence:
            ids = [vocab.get(t, vocab['[UNK]']) for t in seq.split()]
            ids += [cfg['pad_id']] * (max_len-len(ids))
            t = torch.tensor([ids], dtype=torch.long)
            embeds.append(model.encode(t, (t != cfg['pad_id']).long(), pooling=pooling)[0].numpy())
    return normalize(np.array(embeds)), dict(config=cfg, pooling=pooling,
                                           checkpoint_keys=list(checkpoint))


def audit_data(all_rows, base, meta):
    assert all_rows.session_id.is_unique and base.session_id.is_unique
    assert set(base.session_id) <= set(all_rows.session_id)
    joined = all_rows.set_index('session_id').loc[base.session_id].reset_index()
    assert np.array_equal(joined.cluster.to_numpy(dtype=int), base.cluster.to_numpy())
    events = collections.Counter()
    for s in all_rows.event_type_counts: events.update(json.loads(s))
    tokens = [parse_tokens(s) for s in all_rows.semantic_sequence]
    quality = all_rows.quality_eligible
    oov = collections.Counter(t for seq in all_rows.semantic_sequence for t in seq.split() if t not in meta['vocab'])
    projected = all_rows.semantic_sequence.map(lambda s: ' '.join(t if t in meta['vocab'] else '[UNK]' for t in s.split()))
    eligible_counts = projected[quality].value_counts()
    cap_expected = int(eligible_counts.clip(upper=5).sum())
    truncated = base.original_length > base.used_length-1
    mismatches = []
    for i, row in joined.iterrows():
        expected = ['[CLS]'] + projected[all_rows.session_id == row.session_id].iloc[0].split()[-127:]
        if ' '.join(expected) != base.iloc[i].sequence: mismatches.append(row.session_id)
    return joined, dict(
        sessions=len(all_rows), events=int(all_rows.event_count.sum()),
        start=all_rows.first_received_at_kst.min(), end=all_rows.last_received_at_kst.max(),
        baseline_count=len(base), assigned=int((base.cluster>=0).sum()),
        eligibility=all_rows.groupby(['quality_eligible','clustering_input']).size().to_string(),
        exclusion_reasons=all_rows.quality_exclusion_reasons.value_counts().to_dict(),
        quality_eligible=int(quality.sum()), duplicate_cap_expected=cap_expected,
        eligible_unique_patterns=int(len(eligible_counts)), all_unique_patterns=int(all_rows.semantic_sequence.nunique()),
        baseline_unique_patterns=int(joined.semantic_sequence.nunique()),
        zeros_received_duration=int((all_rows.duration_seconds==0).sum()),
        multiple_starts=int(sum(sum(t[1]=='START_SESSION' for t in seq)>1 for seq in tokens)),
        duration_gt_30m=int((all_rows.duration_seconds>1800).sum()), max_duration=float(all_rows.duration_seconds.max()),
        truncation_sessions=int(truncated.sum()), lost_tokens=int((base.original_length-(base.used_length-1)).sum()),
        sequence_mismatches=mismatches, raw_event_counts=dict(events), top_oov=oov.most_common(15),
        source_sha256={str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in [ALL_FILE, BASE_FILE, META_FILE, MODEL_FILE]},
        source_quality=meta.get('cluster_quality'), legacy_noise_ratio=meta.get('noise_ratio'))


def main():
    all_rows = pd.read_csv(ALL_FILE).fillna({'semantic_sequence':''})
    base = pd.read_csv(BASE_FILE)
    meta = json.loads(META_FILE.read_text(encoding='utf-8'))
    joined, audit = audit_data(all_rows, base, meta)
    dump('data_audit.json', audit)
    print('AUDIT', json.dumps({k: audit[k] for k in ['sessions','quality_eligible','duplicate_cap_expected','baseline_unique_patterns','sequence_mismatches']}, ensure_ascii=False), flush=True)
    B, checkpoint = embed_baseline(base, meta)
    np.save(OUT/'baseline_embeddings.npy', B)
    baseline = score(B, base.cluster.to_numpy())
    reproduced = fit_model(B, dict(algorithm='hdbscan', min_cluster_size=8, min_samples=3))
    baseline['reproduction_ari'] = adjusted_rand_score(base.cluster, reproduced)
    baseline['checkpoint'] = checkpoint
    dump('baseline_metrics.json', baseline)
    print('BASELINE', json.dumps(baseline, ensure_ascii=False), flush=True)

    # Development/holdout use distinct complete semantic sequences, never random duplicate rows.
    reference_informative = joined.semantic_sequence.map(informative)
    unique = joined[reference_informative].drop_duplicates('semantic_sequence').sort_values('semantic_sequence').reset_index(drop=True)
    splitter = GroupShuffleSplit(n_splits=1, test_size=.25, random_state=SEED)
    dev_i, hold_i = next(splitter.split(unique, groups=unique.semantic_sequence))
    dev, hold = unique.iloc[dev_i], unique.iloc[hold_i]
    dump('split.json', dict(seed=SEED, development_ids=dev.session_id.tolist(), holdout_ids=hold.session_id.tolist(),
                           development_patterns=len(dev), holdout_patterns=len(hold)))
    b_lookup = {sid: B[i] for i,sid in enumerate(base.session_id)}
    # 운영자가 한눈에 비교할 수 있도록 해석 가능한 유형 수를 최대 5개로 제한한다.
    specs = [dict(algorithm=alg,k=k) for alg in ('kmeans','ward','average') for k in range(2,6)]
    specs += [dict(algorithm='hdbscan',min_cluster_size=m,min_samples=s) for m in (5,8,12) for s in (2,4)]
    specs += [dict(algorithm='dbscan',eps=e,min_samples=3) for e in (.3,.5,.7,.9)]
    results = []
    models = {}
    for mode in ('bert','atomic','factorized'):
        fe = None
        X = np.array([b_lookup[s] for s in dev.session_id]) if mode=='bert' else (fe := Features(mode)).fit_transform(dev)
        models[mode] = (fe, X)
        for spec in specs:
            y = fit_model(X, spec)
            q = score(X,y)
            # Explicit minimum usable coverage and cluster-size conditions; no composite quality score.
            eligible = q['coverage'] >= .85 and q['k'] >= 2 and q['min_cluster'] >= 5 and q['largest_share'] <= .8
            row = dict(mode=mode, spec=spec, development=q, eligible=eligible)
            if eligible:
                row['stability'] = stability(X,spec,y,10)
            results.append(row)
        print('SEARCH',mode,'done',flush=True)
    valid = [r for r in results if r['eligible'] and r['stability']['mean'] >= .75]
    if not valid: raise RuntimeError('No candidate meets prespecified coverage/stability constraints')
    # Representation-specific silhouettes cannot be compared as proof of improvement.
    # Select the best model within each representation; use factorized interpretable features as the proposed design.
    winners = {mode: max([r for r in valid if r['mode']==mode],key=lambda r:r['development']['silhouette'])
               for mode in models if any(r['mode']==mode for r in valid)}
    selected = winners.get('factorized', winners.get('atomic',winners.get('bert')))
    for mode, winner in winners.items():
        fe, X = models[mode]
        H = np.array([b_lookup[s] for s in hold.session_id]) if mode=='bert' else fe.transform(hold)
        y = fit_model(X,winner['spec'])
        yh = nearest_centroid(H,X,y)
        winner['holdout'] = score(H,yh)
        winner['holdout_method'] = 'nearest development centroid, unique unseen patterns, no abstention'
    dump('experiments.json',dict(candidates=results,winners=winners,selected=selected))
    print('WINNERS',json.dumps(winners,ensure_ascii=False),flush=True)

    # Fit selected parameters on all unique reference patterns; propagate exact duplicates.
    mode, spec = selected['mode'],selected['spec']
    fe = Features(mode)
    U = fe.fit_transform(unique) if mode!='bert' else np.array([b_lookup[s] for s in unique.session_id])
    yu = fit_model(U,spec)
    pattern_labels = dict(zip(unique.semantic_sequence,yu))
    advanced_y = joined.semantic_sequence.map(pattern_labels).fillna(-2).to_numpy(dtype=int)
    F = fe.transform(joined) if mode!='bert' else B
    final = dict(selected=selected, baseline_in_bert=baseline,
                 advanced_in_bert=score(B,advanced_y), baseline_in_advanced=score(F,base.cluster.to_numpy()),
                 advanced_in_advanced=score(F,advanced_y), unique_pattern_metrics=score(U,yu),
                 unique_pattern_stability=stability(U,spec,yu,30),
                 common_assigned_baseline_bert=score(B[base.cluster>=0],base.cluster[base.cluster>=0].to_numpy()),
                 common_assigned_advanced_bert=score(B[base.cluster>=0],advanced_y[base.cluster>=0]),
                 common_assigned_baseline_features=score(F[base.cluster>=0],base.cluster[base.cluster>=0].to_numpy()),
                 common_assigned_advanced_features=score(F[base.cluster>=0],advanced_y[base.cluster>=0]))
    # Random label null uses the same cluster sizes; descriptive reference, not a post-search p-value.
    rng = np.random.default_rng(SEED)
    null = [silhouette_score(F[advanced_y>=0],rng.permutation(advanced_y[advanced_y>=0])) for _ in range(100)]
    final['permutation_reference'] = dict(mean=float(np.mean(null)),p95=float(np.quantile(null,.95)),repeats=100)

    # Full-population output retains every source row. Low-information rows are explicit abstentions.
    AA = fe.transform(all_rows) if mode!='bert' else None
    if AA is None: raise RuntimeError('Full population export needs a factorized or atomic model')
    prediction = nearest_centroid(AA,U,yu)
    cluster_ids = sorted(set(yu)-{-1})
    centers = np.array([U[yu==c].mean(axis=0) for c in cluster_ids])
    dist = pairwise_distances(AA,centers)
    order = np.sort(dist,axis=1)
    margin = (order[:,1]-order[:,0])/np.maximum(order[:,1],1e-12)
    # Radius gate is descriptive extrapolation control, not calibrated membership probability.
    radii = {int(c):float(np.quantile(np.linalg.norm(U[yu==c]-centers[j],axis=1),.95)) for j,c in enumerate(cluster_ids)}
    rows = all_rows.copy()
    rows = rows.rename(columns={'cluster':'original_cluster','cluster_probability':'original_cluster_probability'})
    statuses, labels = [], []
    original_ids = set(base.session_id)
    for i,r in rows.iterrows():
        seq = parse_tokens(r.semantic_sequence)
        meaningful = sum(t[1] not in LIFECYCLE for t in seq)
        if not informative(r.semantic_sequence):
            labels.append(-2); statuses.append('insufficient_behavior')
        elif r.session_id in original_ids:
            labels.append(pattern_labels[r.semantic_sequence]); statuses.append('reference_fit')
        elif r.semantic_sequence in pattern_labels:
            labels.append(pattern_labels[r.semantic_sequence]); statuses.append('exact_pattern_transfer')
        elif dist[i].min()>radii[int(prediction[i])] or margin[i]<.05:
            labels.append(-1); statuses.append('out_of_reference_or_ambiguous')
        else:
            labels.append(int(prediction[i])); statuses.append('new_pattern_assignment')
    rows['cluster'] = labels
    rows['assignment_status'] = statuses
    rows['centroid_distance'] = dist.min(axis=1)
    rows['distance_margin'] = margin
    # Distances describe centroid geometry even for exact pattern transfers; they are not probabilities.
    rows['cluster_algorithm'] = mode+'_'+spec['algorithm']
    rows['sequence'] = rows.semantic_sequence
    rows['original_length'] = rows.semantic_token_count
    rows['used_length'] = rows.semantic_token_count
    pca = PCA(n_components=2,random_state=SEED).fit(U)
    points = pca.transform(AA)
    rows['pca_x'],rows['pca_y'] = points[:,0],points[:,1]
    final['pca_variance_ratio'] = pca.explained_variance_ratio_.tolist()
    final['full_status_counts'] = rows.assignment_status.value_counts().to_dict()
    final['full_cluster_counts'] = rows.cluster.value_counts().sort_index().to_dict()
    final['full_metrics'] = score(AA,rows.cluster.to_numpy())
    final['centroid_radii'] = radii
    dump('final_metrics.json',final)
    rows.to_csv(OUT/'advanced_results_intermediate.csv',index=False,encoding='utf-8-sig')
    np.savez_compressed(OUT/'advanced_features.npz',reference=F,unique=U,full=AA,reference_labels=advanced_y,unique_labels=yu)
    # Transparent model configuration; no pickle or modification of serving artifacts.
    dump('advanced_model.json',dict(mode=mode,spec=spec,cluster_ids=cluster_ids,centroids=centers,
         radii=radii,vectorizers=[dict(kind=k,weight=w,vocabulary=v.vocabulary_,idf=v.idf_) for k,w,v in fe.vectorizers]))
    known_patterns = {
        hashlib.sha256(sequence.encode('utf-8')).hexdigest(): int(label)
        for sequence, label in pattern_labels.items()
    }
    dump('known_pattern_labels.json', known_patterns)
    print('FINAL',json.dumps({k:final[k] for k in ['advanced_in_bert','advanced_in_advanced','full_status_counts','full_cluster_counts','unique_pattern_stability']},ensure_ascii=False),flush=True)


if __name__ == '__main__':
    with threadpool_limits(limits=2):
        main()
