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

import argparse, json, os, sys, shutil
from collections import defaultdict
from datetime import datetime
import numpy as np
import torch

# ── 경로 ───────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
META_PATH  = os.path.join(BASE_DIR, 'output/unsupervised_semantic/cluster_meta.json')
MODEL_PATH = os.path.join(BASE_DIR, 'output/unsupervised_semantic/bert_encoder.pt')
CENT_PATH  = os.path.join(BASE_DIR, 'output/unsupervised_semantic/cluster_centroids.npy')
MONGO_URI  = os.environ.get(
    'MONGODB_URI',
    'mongodb+srv://Toridos:1234@capstone.dsph0ff.mongodb.net/ghosttracker?retryWrites=true&w=majority&appName=Capstone'
)

# ── TransformerMLM (cluster_server.py 와 동일 아키텍처) ─────────────────────────
import torch.nn as nn

class TransformerMLM(nn.Module):
    def __init__(self, vocab_size, embed_dim=64, nhead=4, num_layers=2,
                 max_len=60, dim_feedforward=128, dropout=0.1):
        super().__init__()
        self.token_emb = nn.Embedding(vocab_size, embed_dim)
        self.pos_emb   = nn.Embedding(max_len + 5, embed_dim)
        self.norm      = nn.LayerNorm(embed_dim)
        enc_layer = nn.TransformerEncoderLayer(
            d_model=embed_dim, nhead=nhead,
            dim_feedforward=dim_feedforward,
            dropout=dropout, batch_first=True)
        self.encoder = nn.TransformerEncoder(enc_layer, num_layers=num_layers)
        self.head    = nn.Linear(embed_dim, vocab_size)

    def forward(self, input_ids, attention_mask):
        B, L = input_ids.shape
        pos  = torch.arange(L, device=input_ids.device).unsqueeze(0)
        x    = self.token_emb(input_ids) + self.pos_emb(pos)
        x    = self.norm(x)
        mask = (attention_mask == 0)
        x    = self.encoder(x, src_key_padding_mask=mask)
        return x[:, 0, :]   # [CLS] 임베딩


# ── 모델 로드 ──────────────────────────────────────────────────────────────────
# cluster_meta.json 하이퍼파라미터로 TransformerMLM을 복원하고 학습된 가중치를 로드한다
def load_model(meta: dict, device: str = 'cpu') -> TransformerMLM:
    state = torch.load(MODEL_PATH, map_location=device, weights_only=True)
    if 'model_state_dict' in state:
        state = state['model_state_dict']

    # 구조 자동 감지
    vocab_size      = meta['vocab_size']
    embed_dim       = meta.get('embedding_dim', 64)
    pos_key         = 'pos_emb.weight'
    max_len         = state[pos_key].shape[0] - 5 if pos_key in state else meta.get('max_len', 60)
    num_layers_keys = [k for k in state if k.startswith('encoder.layers.') and k.endswith('.self_attn.in_proj_weight')]
    num_layers      = len(num_layers_keys)
    ff_key          = 'encoder.layers.0.linear1.weight'
    dim_feedforward = state[ff_key].shape[0] if ff_key in state else 128

    model = TransformerMLM(vocab_size, embed_dim, num_layers=num_layers,
                           max_len=max_len, dim_feedforward=dim_feedforward)
    model.load_state_dict(state)
    model.to(device)
    model.eval()
    return model


# ── 세션 임베딩 ────────────────────────────────────────────────────────────────
# 토큰 ID 시퀀스 하나를 BERT 모델로 임베딩해 numpy 벡터로 반환한다
def embed_session(model: TransformerMLM, token_ids: list,
                  meta: dict, device: str = 'cpu') -> np.ndarray:
    PAD = meta['special_tokens']['PAD_ID']
    CLS = meta['special_tokens']['CLS_ID']
    UNK = meta['special_tokens'].get('UNK_ID', 1)
    vocab_size = int(meta.get('vocab_size', 0))
    max_len = meta.get('max_len', 60)

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
        emb = model(id_t, mask)
    return emb[0].cpu().numpy()


# ── MongoDB에서 세션 토큰 시퀀스 불러오기 ─────────────────────────────────────
# MongoDB events 컬렉션에서 세션별 토큰 ID 시퀀스를 읽어온다
def load_sessions_from_mongo() -> dict:
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit('pymongo 설치 필요: pip install pymongo')

    print("MongoDB 연결 중...")
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=10000,
                         tlsAllowInvalidCertificates=True)
    col = client['ghosttracker']['events']

    sessions = defaultdict(list)
    cursor   = col.find({}, {'session_id': 1, 'event_token': 1, 'event_seq': 1})
    for doc in cursor:
        tok = doc.get('event_token')
        if tok and isinstance(tok, int) and tok > 0:   # 0=PAD 제외
            sessions[doc['session_id']].append(
                (doc.get('event_seq', 0), tok)
            )

    # event_seq 기준 정렬, token만 추출
    result = {}
    for sid, events in sessions.items():
        events.sort(key=lambda x: x[0])
        result[sid] = [tok for _, tok in events]

    print(f"  → {len(result)}개 세션 로드 완료 "
          f"(평균 {np.mean([len(v) for v in result.values()]):.0f}개 이벤트)")
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
        if cid < n_clusters:
            new_c = np.mean(embs, axis=0)
            updated[cid] = (1 - alpha) * old_centroids[cid] + alpha * new_c

    return updated


# ── 메인 ──────────────────────────────────────────────────────────────────────
# 전체 retrain 파이프라인 실행 — 로드 → 임베딩 → EMA 또는 HDBSCAN 업데이트 → 저장
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--full',    action='store_true', help='HDBSCAN 전체 재클러스터링')
    parser.add_argument('--dry-run', action='store_true', help='저장 없이 임베딩만 실행')
    parser.add_argument('--alpha',   type=float, default=0.3, help='EMA 반영 비율 (기본 0.3)')
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
    sessions = load_sessions_from_mongo()
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

    # 배정 통계
    from collections import Counter
    dist = Counter(assignments.tolist())
    print("\n  클러스터 배정 결과:")
    for cid in sorted(dist.keys()):
        print(f"    C{cid}: {dist[cid]}개 세션  (평균 신뢰도 "
              f"{confidences[assignments==cid].mean():.3f})")
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
        clusterer = hdbscan.HDBSCAN(min_cluster_size=3, min_samples=2,
                                    metric='euclidean')
        labels = clusterer.fit_predict(emb_norm)
        valid  = labels >= 0
        n_new  = len(set(labels[valid]))
        print(f"  → 새 클러스터: {n_new}개 "
              f"({(~valid).sum()}개 노이즈 포인트 제외)")

        # 새 centroids 계산
        new_centroids = np.array([
            embeddings[labels == c].mean(axis=0)
            for c in range(n_new)
        ])
        new_assignments = {sids[i]: int(labels[i]) for i in range(len(sids))}
        final_centroids = new_centroids
        final_n         = n_new
        quality_metrics = compute_quality_metrics(emb_norm, labels)
    else:
        # EMA 업데이트
        print(f"  EMA 업데이트 (alpha={args.alpha})...")
        final_centroids = ema_update(old_centroids, list(embeddings),
                                     list(assignments), n_clusters, args.alpha)
        new_assignments = {sids[i]: int(assignments[i]) for i in range(len(sids))}
        final_n         = n_clusters
        quality_metrics = compute_quality_metrics(emb_norm, assignments.astype(int))

    # 클러스터 프로파일 재계산
    new_profiles = compute_profiles(sessions, new_assignments, meta)
    stability_metrics = compute_profile_stability(old_profiles, new_profiles)

    # 백업
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy(META_PATH,  META_PATH.replace('.json', f'_backup_{ts}.json'))
    shutil.copy(CENT_PATH,  CENT_PATH.replace('.npy',  f'_backup_{ts}.npy'))
    print(f"  → 백업 완료 (_{ts})")

    # cluster_centroids.npy 저장
    np.save(CENT_PATH, final_centroids.astype(np.float32))

    # cluster_meta.json 업데이트
    meta['num_clusters']          = final_n
    meta['cluster_ids']           = list(range(final_n))
    meta['cluster_profiles']      = new_profiles
    meta['last_retrain']          = datetime.now().isoformat()
    meta['retrain_session_count'] = len(sessions)
    meta['silhouette']            = quality_metrics.get('silhouette')
    meta['davies_bouldin']        = quality_metrics.get('davies_bouldin')
    meta['noise_count']           = quality_metrics.get('noise_count')
    meta['cluster_quality']       = {
        **quality_metrics,
        'stability': stability_metrics,
    }
    with open(META_PATH, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print("\n완료!")
    print(f"   cluster_meta.json 업데이트 ({final_n}개 클러스터)")
    print(f"   평균 신뢰도: {confidences.mean():.4f}")
    print(f"   cluster_server.py 재시작 시 자동 반영됩니다.")


if __name__ == '__main__':
    main()
