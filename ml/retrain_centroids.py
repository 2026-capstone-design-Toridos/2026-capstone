"""
retrain_centroids.py
---------------------
MongoDB 실데이터로 클러스터 centroid 재계산

작동 방식:
  1. MongoDB events 컬렉션에서 세션별 token 시퀀스 추출
  2. TransformerMLM 모델로 각 세션 임베딩 생성
  3. 기존 centroid에 실데이터 반영 (Exponential Moving Average)
     또는 --full 옵션으로 HDBSCAN 전체 재클러스터링
  4. cluster_meta.json 업데이트

사용법:
  python retrain_centroids.py               # EMA 업데이트 (기존 클러스터 유지)
  python retrain_centroids.py --full        # HDBSCAN 전체 재클러스터링
  python retrain_centroids.py --dry-run     # 임베딩만 하고 저장 안 함
"""

import argparse, csv, json, os, sys, shutil
from collections import defaultdict
from datetime import datetime
import numpy as np
import torch
from build_session_sequences import build_semantic_sequence_for_session, event_sort_key
from train_transformer_encoder import SessionTransformerEncoder

# ── 경로 ───────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
META_PATH  = os.path.join(BASE_DIR, 'output/unsupervised_semantic/cluster_meta.json')
MODEL_PATH = os.path.join(BASE_DIR, 'output/unsupervised_semantic/bert_encoder.pt')
CENT_PATH  = os.path.join(BASE_DIR, 'output/unsupervised_semantic/cluster_centroids.npy')
RESULT_PATH = os.path.join(BASE_DIR, 'output/clustering/cluster_results.csv')
MONGO_URI = os.environ.get('MONGODB_URI', '').strip()

DIGNOLUCIR_ORIGINS = {
    'https://hshh2020.cafe24.com',
    'https://hshh2020.cafe24api.com',
    'https://dignolucir.co.kr',
    'https://www.dignolucir.co.kr',
}


def expand_origins(origins):
    normalized = {str(origin).strip().lower().rstrip('/') for origin in (origins or [])}
    if normalized & DIGNOLUCIR_ORIGINS:
        normalized |= DIGNOLUCIR_ORIGINS
    return sorted({variant for origin in normalized for variant in (origin, f'{origin}/')})


# ── 모델 로드 ──────────────────────────────────────────────────────────────────
# cluster_meta.json 하이퍼파라미터로 TransformerMLM을 복원하고 학습된 가중치를 로드한다
def load_model(meta: dict, device: str = 'cpu') -> SessionTransformerEncoder:
    checkpoint = torch.load(MODEL_PATH, map_location=device, weights_only=False)
    state = checkpoint.get('model_state_dict', checkpoint.get('encoder_state'))
    cfg = checkpoint.get('model_config')
    if state is None or not cfg:
        raise RuntimeError('체크포인트에 model_state_dict/model_config가 없습니다.')
    if cfg['vocab_size'] != len(meta['vocab']):
        raise RuntimeError('체크포인트와 cluster_meta.json의 vocab이 다릅니다.')

    model = SessionTransformerEncoder(
        vocab_size=cfg['vocab_size'], max_len=cfg['max_len'], pad_id=cfg['pad_id'],
        embed_dim=cfg['embed_dim'], num_heads=cfg['num_heads'],
        num_layers=cfg['num_layers'], ff_dim=cfg['ff_dim'], dropout=0.0,
    )
    model.load_state_dict(state, strict=True)
    model.to(device)
    model.eval()
    model._gt_max_len = cfg['max_len']
    model._gt_pooling = checkpoint.get('pooling', meta.get('pooling', 'mean'))
    return model


# ── 세션 임베딩 ────────────────────────────────────────────────────────────────
# 토큰 ID 시퀀스 하나를 BERT 모델로 임베딩해 numpy 벡터로 반환한다
def embed_session(model: SessionTransformerEncoder, token_ids: list,
                  meta: dict, device: str = 'cpu') -> np.ndarray:
    PAD = meta['vocab'].get('[PAD]', 0)
    CLS = meta['vocab'].get('[CLS]', 3)
    UNK = meta['vocab'].get('[UNK]', 1)
    vocab_size = int(meta.get('vocab_size', 0))
    max_len = model._gt_max_len

    safe_tokens = [
        tok if isinstance(tok, int) and 0 <= tok < vocab_size else UNK
        for tok in token_ids[-(max_len - 1):]
    ]
    ids     = [CLS] + safe_tokens
    pad_len = max_len - len(ids)
    ids     = ids + [PAD] * pad_len

    id_t = torch.tensor([ids], dtype=torch.long, device=device)
    mask = (id_t != PAD).long()
    with torch.no_grad():
        emb = model.encode(id_t, mask, pooling=model._gt_pooling)
    return emb[0].cpu().numpy()


# ── MongoDB에서 세션 토큰 시퀀스 불러오기 ─────────────────────────────────────
# MongoDB raw event를 학습과 동일한 semantic mapper로 변환한다.
def load_sessions_from_mongo(
    meta: dict, origins=None, min_tokens: int = 3, max_duplicate_sequences: int = 5,
) -> dict:
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit('pymongo 설치 필요: pip install pymongo')

    if not MONGO_URI:
        sys.exit('MONGODB_URI 환경변수가 필요합니다.')

    print("MongoDB 연결 중...")
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000)
    col = client['ghosttracker']['events']

    query = {'origin': {'$in': origins}} if origins else {}
    sessions = defaultdict(list)
    projection = {
        '_id': 0, 'session_id': 1, 'event_type': 1, 'timestamp': 1,
        'received_at': 1, 'event_seq': 1, 'inter_event_gap': 1,
        'pathname': 1, 'page_url': 1, 'page_type': 1, 'data': 1,
    }
    cursor = col.find(query, projection)
    for doc in cursor:
        sid = doc.get('session_id')
        if not sid:
            continue
        if doc.get('timestamp') is None and doc.get('received_at') is not None:
            doc['timestamp'] = doc['received_at'].timestamp() * 1000
        sessions[str(sid)].append(doc)

    vocab = meta['vocab']
    unk = vocab.get('[UNK]', 1)
    result = {}
    duplicate_counts = defaultdict(int)
    duplicate_dropped = 0
    for sid, events in sessions.items():
        events.sort(key=event_sort_key)
        sequence = build_semantic_sequence_for_session(events)['sequence']
        if len(sequence) < min_tokens:
            continue
        token_ids = [vocab.get(token, unk) for token in sequence]
        if token_ids.count(unk) / len(token_ids) > 0.20:
            continue
        signature = tuple(token_ids)
        if duplicate_counts[signature] >= max_duplicate_sequences:
            duplicate_dropped += 1
            continue
        duplicate_counts[signature] += 1
        result[sid] = token_ids

    print(f"  → {len(result)}개 세션 로드 완료 "
          f"(평균 {np.mean([len(v) for v in result.values()]):.0f}개 semantic token)")
    print(f"  → 동일 시퀀스 상한 초과 제외: {duplicate_dropped}개")
    return result


# ── 클러스터 프로파일 재계산 ───────────────────────────────────────────────────
def compute_profiles(sessions: dict, assignments: dict, meta: dict) -> dict:
    """assignments: {session_id: cluster_id}"""
    from collections import Counter

    id2tok = {v: k for k, v in meta['vocab'].items()}
    profiles = defaultdict(lambda: {'count': 0, 'top_actions': [], 'page_dist': {}})

    cluster_actions = defaultdict(list)
    cluster_pages   = defaultdict(list)

    for sid, tokens in sessions.items():
        cid = str(assignments.get(sid, -1))
        if cid == '-1':
            continue
        profiles[cid]['count'] += 1
        for tok in tokens:
            token_str = id2tok.get(tok, '')
            if '|' in token_str:
                parts = token_str.split('|')
                if len(parts) >= 2:
                    cluster_pages[cid].append(parts[0])
                    cluster_actions[cid].append(parts[1])

    result = {}
    for cid in profiles:
        act_cnt  = Counter(cluster_actions[cid])
        page_cnt = Counter(cluster_pages[cid])
        result[cid] = {
            'count':      profiles[cid]['count'],
            'top_actions': [{'action': a, 'count': c}
                            for a, c in act_cnt.most_common(10)],
            'page_dist':  dict(page_cnt.most_common(6)),
        }
    return result


# 실루엣 점수·Davies-Bouldin 지수 등 클러스터링 품질 지표를 계산한다
def compute_quality_metrics(emb_norm: np.ndarray, labels: np.ndarray) -> dict:
    valid = labels >= 0
    n_total = int(len(labels))
    n_valid = int(valid.sum())
    n_noise = int((~valid).sum())
    n_clusters = int(len(set(labels[valid]))) if n_valid else 0
    metrics = {
        'sample_count': n_total,
        'clustered_session_count': n_valid,
        'noise_count': n_noise,
        'noise_rate': round(n_noise / n_total, 4) if n_total else None,
        'silhouette': None,
        'davies_bouldin': None,
        'metrics_note': '',
    }
    if n_clusters < 2 or n_valid < 3:
        metrics['metrics_note'] = '클러스터가 2개 미만이거나 표본이 적어 분리도 지표를 계산하지 않았습니다.'
        return metrics
    try:
        from sklearn.metrics import silhouette_score, davies_bouldin_score
        metrics['silhouette'] = round(float(silhouette_score(emb_norm[valid], labels[valid], metric='euclidean')), 4)
        metrics['davies_bouldin'] = round(float(davies_bouldin_score(emb_norm[valid], labels[valid])), 4)
    except Exception as exc:
        metrics['metrics_note'] = f'품질 지표 계산 실패: {exc}'
    return metrics


# 클러스터 프로파일에서 상위 액션·페이지 집합을 뽑아 비교용 시그니처로 만든다
def profile_signature(profile: dict) -> set:
    actions = [f"A:{a.get('action')}" for a in profile.get('top_actions', [])[:5]]
    pages = [f"P:{p}" for p in list((profile.get('page_dist') or {}).keys())[:5]]
    return set(actions + pages)


# 이전 run과 이번 run의 클러스터 프로파일을 Jaccard 유사도로 비교해 안정성을 평가한다
def compute_profile_stability(old_profiles: dict, new_profiles: dict) -> dict:
    old_signatures = {
        cid: profile_signature(profile)
        for cid, profile in (old_profiles or {}).items()
    }
    per_cluster = {}
    scores = []
    for cid, profile in (new_profiles or {}).items():
      sig = profile_signature(profile)
      if not sig or not old_signatures:
          per_cluster[str(cid)] = None
          continue
      best = 0.0
      for old_sig in old_signatures.values():
          if not old_sig:
              continue
          score = len(sig & old_sig) / len(sig | old_sig)
          best = max(best, score)
      per_cluster[str(cid)] = round(float(best), 4)
      scores.append(best)
    return {
        'avg_profile_stability': round(float(np.mean(scores)), 4) if scores else None,
        'per_cluster': per_cluster,
        'method': 'top_actions/page_dist Jaccard similarity against previous run',
    }


# ── EMA centroid 업데이트 ─────────────────────────────────────────────────────
def ema_update(old_centroids: np.ndarray, new_embeddings: list,
               assignments: list, n_clusters: int, alpha: float = 0.3) -> np.ndarray:
    """
    alpha: 새 데이터 반영 비율 (0.3 = 30% 새 데이터, 70% 기존 centroid)
    """
    updated = old_centroids.copy()
    cluster_embs = defaultdict(list)
    for emb, cid in zip(new_embeddings, assignments):
        cluster_embs[cid].append(emb)

    for cid, embs in cluster_embs.items():
        if 0 <= cid < n_clusters:
            new_c = np.mean(embs, axis=0)
            updated[cid] = (1 - alpha) * old_centroids[cid] + alpha * new_c

    return updated


def save_cluster_results(path, sids, sessions, labels, probabilities, points, meta, max_len):
    """재학습에 실제 사용된 세션과 최종 배정을 표준 CSV 형식으로 저장한다."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    id2tok = {value: token for token, value in meta['vocab'].items()}
    with open(path, 'w', encoding='utf-8-sig', newline='') as file:
        fieldnames = [
            'session_id', 'cluster', 'probability', 'pca_x', 'pca_y',
            'original_length', 'used_length', 'sequence',
        ]
        writer = csv.DictWriter(file, fieldnames=fieldnames, lineterminator='\n')
        writer.writeheader()
        for index, sid in enumerate(sids):
            tokens = [id2tok.get(token_id, '[UNK]') for token_id in sessions[sid]]
            used_tokens = tokens[-(max_len - 1):]
            writer.writerow({
                'session_id': sid,
                'cluster': int(labels[index]),
                'probability': round(float(probabilities[index]), 6),
                'pca_x': round(float(points[index, 0]), 8),
                'pca_y': round(float(points[index, 1]), 8),
                'original_length': len(tokens),
                'used_length': len(used_tokens) + 1,
                'sequence': ' '.join(['[CLS]', *used_tokens]),
            })


def calibrate_inference_gate(similarities, density_labels, target_precision=0.95):
    """HDBSCAN의 정상/노이즈 판정을 교사로 삼아 centroid gate를 보정한다."""
    best_similarity = similarities.max(axis=1)
    sorted_similarity = np.sort(similarities, axis=1)
    margins = (
        sorted_similarity[:, -1] - sorted_similarity[:, -2]
        if similarities.shape[1] > 1 else np.ones(len(similarities))
    )
    positives = density_labels >= 0
    positive_count = int(positives.sum())
    best = None

    for similarity_threshold in np.arange(0.55, 0.991, 0.005):
        for margin_threshold in np.arange(0.0, 0.301, 0.005):
            predicted = (
                (best_similarity >= similarity_threshold)
                & (margins >= margin_threshold)
            )
            accepted_count = int(predicted.sum())
            if accepted_count == 0:
                continue
            true_positive = int((predicted & positives).sum())
            precision = true_positive / accepted_count
            recall = true_positive / positive_count if positive_count else 0.0
            if precision < target_precision:
                continue
            candidate = (recall, precision, -similarity_threshold, -margin_threshold)
            if best is None or candidate > best[0]:
                best = (candidate, similarity_threshold, margin_threshold, accepted_count)

    if best is None:
        return {
            'min_similarity': 0.95, 'min_margin': 0.05,
            'target_precision': target_precision, 'estimated_precision': None,
            'estimated_recall': None, 'calibration': 'conservative_fallback',
        }

    score, similarity_threshold, margin_threshold, accepted_count = best
    return {
        'min_similarity': round(float(similarity_threshold), 4),
        'min_margin': round(float(margin_threshold), 4),
        'target_precision': target_precision,
        'estimated_precision': round(float(score[1]), 4),
        'estimated_recall': round(float(score[0]), 4),
        'accepted_training_samples': accepted_count,
        'calibration': 'grid_search_against_hdbscan_noise_labels',
    }


# ── 메인 ──────────────────────────────────────────────────────────────────────
# 전체 retrain 파이프라인 실행 — 로드 → 임베딩 → EMA 또는 HDBSCAN 업데이트 → 저장
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--full',    action='store_true', help='HDBSCAN 전체 재클러스터링')
    parser.add_argument('--dry-run', action='store_true', help='저장 없이 임베딩만 실행')
    parser.add_argument('--alpha',   type=float, default=0.3, help='EMA 반영 비율 (기본 0.3)')
    parser.add_argument('--origin', action='append', help='대상 origin. 여러 번 지정 가능')
    parser.add_argument('--min-tokens', type=int, default=3, help='최소 semantic token 수')
    parser.add_argument('--min-similarity', type=float, default=0.55, help='EMA 배정 최소 cosine 유사도')
    parser.add_argument('--min-margin', type=float, default=0.02, help='EMA용 1·2순위 centroid 최소 거리 차이')
    parser.add_argument('--min-cluster-size', type=int, default=8, help='HDBSCAN 최소 클러스터 크기')
    parser.add_argument('--min-samples', type=int, default=3, help='HDBSCAN 밀도 최소 표본')
    parser.add_argument('--max-duplicates', type=int, default=5, help='동일 시퀀스 최대 학습 수')
    args = parser.parse_args()

    device = 'cpu'
    print(f"\n디바이스: {device}")

    # 1. 메타 & 모델 로드
    print("\n[1/4] 모델 로드 중...")
    with open(META_PATH, encoding='utf-8') as f:
        meta = json.load(f)
    old_profiles = meta.get('cluster_profiles', {})
    model = load_model(meta, device)
    print(f"  → TransformerMLM 로드 완료 (vocab={meta['vocab_size']}, dim={meta['embedding_dim']})")

    # 기존 centroids 로드 (cluster_centroids.npy)
    if not os.path.exists(CENT_PATH):
        sys.exit(f"cluster_centroids.npy 없음: {CENT_PATH}")
    old_centroids = np.load(CENT_PATH).astype(np.float32)
    n_clusters = len(old_centroids)
    print(f"  → 기존 centroids: {n_clusters}개 클러스터")

    # 2. MongoDB 세션 로드
    print("\n[2/4] MongoDB 세션 데이터 로드 중...")
    origins = expand_origins(args.origin)
    if origins:
        print(f"  대상 origin: {', '.join(origins)}")
    sessions = load_sessions_from_mongo(meta, origins, args.min_tokens, args.max_duplicates)
    if not sessions:
        sys.exit("세션 데이터 없음.")

    # 3. 임베딩
    print("\n[3/4] 세션 임베딩 생성 중...")
    sids       = list(sessions.keys())
    embeddings = []
    for i, sid in enumerate(sids):
        emb = embed_session(model, sessions[sid], meta, device)
        embeddings.append(emb)
        if (i + 1) % 20 == 0:
            print(f"  {i+1}/{len(sids)} 완료...")
    embeddings = np.array(embeddings)
    print(f"  → 임베딩 완료: shape={embeddings.shape}")

    # cosine 정규화
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    emb_norm = embeddings / (norms + 1e-8)
    cent_norm = old_centroids / (np.linalg.norm(old_centroids, axis=1, keepdims=True) + 1e-8)

    # 기존 centroid 기준 클러스터 배정 (cosine similarity)
    sims        = emb_norm @ cent_norm.T          # (N, K)
    assignments = sims.argmax(axis=1)             # (N,)
    confidences = sims.max(axis=1)
    sorted_sims = np.sort(sims, axis=1)
    margins = sorted_sims[:, -1] - sorted_sims[:, -2] if n_clusters > 1 else np.ones(len(sims))
    accepted = (confidences >= args.min_similarity) & (margins >= args.min_margin)
    assignments = np.where(accepted, assignments, -1)

    # 배정 통계
    from collections import Counter
    dist = Counter(assignments.tolist())
    print("\n  클러스터 배정 결과:")
    for cid in sorted(cid for cid in dist.keys() if cid >= 0):
        print(f"    C{cid}: {dist[cid]}개 세션  (평균 신뢰도 "
              f"{confidences[assignments==cid].mean():.3f})")
    print(f"    noise: {(assignments < 0).sum()}개 세션")
    print(f"  전체 평균 신뢰도: {confidences.mean():.4f}")

    if args.dry_run:
        print("\n[dry-run] 저장 생략.")
        return

    # 4. centroid 업데이트
    print(f"\n[4/4] Centroid 업데이트 중...")

    if args.full:
        try:
            import hdbscan
        except ImportError:
            sys.exit("hdbscan 설치 필요: pip install hdbscan")
        print("  HDBSCAN 전체 재클러스터링...")
        clusterer = hdbscan.HDBSCAN(min_cluster_size=args.min_cluster_size,
                                    min_samples=args.min_samples,
                                    metric='euclidean')
        labels = clusterer.fit_predict(emb_norm)
        valid  = labels >= 0
        n_new  = len(set(labels[valid]))
        print(f"  → 새 클러스터: {n_new}개 "
              f"({(~valid).sum()}개 노이즈 포인트 제외)")
        if n_new < 2:
            sys.exit('신뢰 가능한 클러스터가 2개 미만입니다. 파라미터나 표본 수를 점검하세요.')

        # 새 centroids 계산
        new_centroids = np.array([
            embeddings[labels == c].mean(axis=0)
            for c in range(n_new)
        ])
        new_assignments = {sids[i]: int(labels[i]) for i in range(len(sids))}
        final_centroids = new_centroids
        final_n         = n_new
        quality_metrics = compute_quality_metrics(emb_norm, labels)
        result_labels = labels.astype(int)
        result_probabilities = np.where(valid, clusterer.probabilities_, 0.0)
    else:
        # EMA 업데이트
        print(f"  EMA 업데이트 (alpha={args.alpha})...")
        final_centroids = ema_update(old_centroids, list(embeddings),
                                     list(assignments), n_clusters, args.alpha)
        new_assignments = {sids[i]: int(assignments[i]) for i in range(len(sids))}
        final_n         = n_clusters
        quality_metrics = compute_quality_metrics(emb_norm, assignments.astype(int))
        result_labels = assignments.astype(int)
        result_probabilities = np.where(accepted, np.clip(confidences, 0.0, 1.0), 0.0)

    # 클러스터 프로파일 재계산
    new_profiles = compute_profiles(sessions, new_assignments, meta)
    stability_metrics = compute_profile_stability(old_profiles, new_profiles)

    final_cent_norm = final_centroids / (
        np.linalg.norm(final_centroids, axis=1, keepdims=True) + 1e-8
    )
    final_sims = emb_norm @ final_cent_norm.T
    if args.full:
        gate_calibration = calibrate_inference_gate(final_sims, result_labels)
    else:
        gate_calibration = {
            'min_similarity': args.min_similarity,
            'min_margin': args.min_margin,
            'target_precision': None,
            'estimated_precision': None,
            'estimated_recall': None,
            'calibration': 'configured_ema_gate',
        }

    # 백업
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy(META_PATH,  META_PATH.replace('.json', f'_backup_{ts}.json'))
    shutil.copy(CENT_PATH,  CENT_PATH.replace('.npy',  f'_backup_{ts}.npy'))
    if os.path.exists(RESULT_PATH):
        shutil.copy(RESULT_PATH, RESULT_PATH.replace('.csv', f'_backup_{ts}.csv'))
    print(f"  → 백업 완료 (_{ts})")

    from sklearn.decomposition import PCA
    pca_points = PCA(n_components=2, random_state=42).fit_transform(emb_norm)
    save_cluster_results(
        RESULT_PATH, sids, sessions, result_labels, result_probabilities,
        pca_points, meta, model._gt_max_len,
    )

    # cluster_centroids.npy 저장
    np.save(CENT_PATH, final_centroids.astype(np.float32))

    # cluster_meta.json 업데이트
    meta['num_clusters']          = final_n
    meta['cluster_ids']           = list(range(final_n))
    meta['cluster_profiles']      = new_profiles
    meta['cluster_counts']        = {
        str(cid): int((result_labels == cid).sum()) for cid in range(final_n)
    }
    meta['last_retrain']          = datetime.now().isoformat()
    meta['retrain_session_count'] = len(sessions)
    meta['silhouette']            = quality_metrics.get('silhouette')
    meta['davies_bouldin']        = quality_metrics.get('davies_bouldin')
    meta['noise_count']           = quality_metrics.get('noise_count')
    meta['cluster_quality']       = {
        **quality_metrics,
        'stability': stability_metrics,
    }
    meta['inference_quality_gate'] = {
        'min_tokens': args.min_tokens,
        'max_unknown_ratio': 0.20,
        **gate_calibration,
    }
    meta['retrain_origins'] = origins or ['*']
    if args.full:
        # 새 클러스터 ID에 예전 ID의 이름을 재사용하면 의미가 뒤바뀐다.
        meta.pop('nlp_labels', None)
        meta.pop('cluster_labels', None)
    with open(META_PATH, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print("\n완료!")
    print(f"   cluster_meta.json 업데이트 ({final_n}개 클러스터)")
    print(f"   cluster_results.csv 저장: {RESULT_PATH}")
    print(f"   평균 신뢰도: {confidences.mean():.4f}")
    print(f"   cluster_server.py 재시작 시 자동 반영됩니다.")


if __name__ == '__main__':
    main()
