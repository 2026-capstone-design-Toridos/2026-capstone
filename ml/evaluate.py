"""
GhostTracker 모델 평가 스크립트 (feature/semantic-mapper 브랜치 전용)
=======================================================================
클러스터링 결과 + 세션 임베딩 → 평가 지표 출력

[클러스터링 지표]
  - Silhouette Score       (높을수록 좋음, -1~1)
  - Davies-Bouldin Index   (낮을수록 좋음)
  - Calinski-Harabasz      (높을수록 좋음)
  - 클러스터별 해석 가능성  (세션 수, 이탈율, top tokens)

[분류 지표] — 클러스터를 이탈/전환 예측으로 변환 후 계산
  - Accuracy, Precision, Recall, F1
  - ROC-AUC, PR-AUC

사용법:
  python ml/evaluate.py
  python ml/evaluate.py --mongo-uri "mongodb+srv://..." --cluster ml/output/clustering/cluster_results.csv
"""

import os, sys, argparse, warnings
import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EMB  = os.path.join(BASE_DIR, 'output/transformer/session_embeddings.npy')
DEFAULT_META = os.path.join(BASE_DIR, 'output/transformer/session_embedding_meta.csv')
DEFAULT_CL   = os.path.join(BASE_DIR, 'output/clustering/cluster_results.csv')
MONGO_URI    = "mongodb+srv://Toridos:1234@capstone.dsph0ff.mongodb.net/ghosttracker?retryWrites=true&w=majority&appName=Capstone"


# ── 유틸 ─────────────────────────────────────────────────────────────

def divider(title: str):
    print(f'\n{"─"*60}')
    print(f'  {title}')
    print('─'*60)


def fetch_churn_labels(mongo_uri: str, session_ids: list[str]) -> dict[str, int]:
    """MongoDB에서 세션별 is_churned 라벨 계산 (add_to_cart/purchase_click 기준)"""
    try:
        from pymongo import MongoClient
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
        db = client['ghosttracker']
        events = list(db.events.find(
            {'session_id': {'$in': session_ids},
             'event_type': {'$in': ['add_to_cart', 'purchase_click']}},
            {'session_id': 1, 'event_type': 1}
        ))
        client.close()

        converted = {e['session_id'] for e in events}
        return {sid: int(sid not in converted) for sid in session_ids}
    except Exception as ex:
        print(f'  [경고] MongoDB 연결 실패: {ex}')
        return {}


# ── 클러스터링 평가 ───────────────────────────────────────────────────

def evaluate_clustering(embeddings: np.ndarray, cluster_df: pd.DataFrame):
    from sklearn.metrics import silhouette_score, davies_bouldin_score, calinski_harabasz_score
    from sklearn.preprocessing import normalize

    divider('🔵 클러스터링 지표 (Clustering Metrics)')

    labels = cluster_df['cluster'].values
    emb_norm = normalize(embeddings)

    n_noise  = int((labels == -1).sum())
    n_valid  = int((labels >= 0).sum())
    n_unique = len(set(labels) - {-1})

    print(f'  전체 세션   : {len(labels)}')
    print(f'  클러스터 수 : {n_unique}')
    print(f'  노이즈(-1)  : {n_noise}  ({n_noise/len(labels)*100:.1f}%)')

    if n_valid >= 2 and n_unique >= 2:
        mask = labels >= 0
        sil = silhouette_score(emb_norm[mask], labels[mask])
        db  = davies_bouldin_score(emb_norm[mask], labels[mask])
        ch  = calinski_harabasz_score(emb_norm[mask], labels[mask])
        print(f'\n  Silhouette Score     : {sil:+.4f}  ↑ 높을수록 좋음 (-1~1)')
        print(f'  Davies-Bouldin Index : {db:.4f}   ↓ 낮을수록 좋음')
        print(f'  Calinski-Harabasz    : {ch:.2f}  ↑ 높을수록 좋음')
    else:
        print('  [경고] 유효 세션 부족 — 지표 계산 불가')


# ── 해석 가능성 평가 ──────────────────────────────────────────────────

def evaluate_interpretability(cluster_df: pd.DataFrame, churn_map: dict):
    divider('📖 해석 가능성 (Interpretability)')

    if churn_map:
        cluster_df = cluster_df.copy()
        cluster_df['is_churned'] = cluster_df['session_id'].map(churn_map)

    for cl in sorted(cluster_df['cluster'].unique()):
        sub = cluster_df[cluster_df['cluster'] == cl]
        tag = '(노이즈)' if cl == -1 else f'Cluster {cl}'
        print(f'\n  [{tag}]  세션 수: {len(sub)}  /  avg_len: {sub["used_length"].mean():.1f}')

        if 'is_churned' in cluster_df.columns and not sub['is_churned'].isna().all():
            churn_r = sub['is_churned'].mean()
            print(f'    이탈율: {churn_r:.0%}  ({"⚠️ 이탈 위험" if churn_r > 0.6 else "✅ 전환 가능성"})')

        # top tokens
        if 'sequence' in sub.columns:
            from collections import Counter
            tokens = []
            for seq in sub['sequence'].dropna():
                tokens.extend(str(seq).split())
            top = Counter(t for t in tokens if '|' in t).most_common(5)
            if top:
                print('    Top tokens:')
                for tok, cnt in top:
                    print(f'      {tok}: {cnt}')


# ── 분류 지표 평가 ────────────────────────────────────────────────────

def evaluate_classification(cluster_df: pd.DataFrame, churn_map: dict):
    from sklearn.metrics import (
        accuracy_score, precision_score, recall_score, f1_score,
        roc_auc_score, average_precision_score, confusion_matrix,
        classification_report,
    )

    divider('📊 분류 지표 (Classification Metrics)')

    if not churn_map:
        print('  [스킵] MongoDB 라벨 없음')
        return

    df = cluster_df.copy()
    df['is_churned'] = df['session_id'].map(churn_map)
    df = df.dropna(subset=['is_churned'])

    if len(df) < 5:
        print('  [스킵] 라벨 있는 세션 부족')
        return

    y_true = df['is_churned'].astype(int).values

    # 클러스터별 이탈율로 예측값 생성 (다수결)
    cluster_churn_rate = df.groupby('cluster')['is_churned'].mean()

    # 노이즈(-1)는 이탈로 간주
    def predict_churn(cl):
        if cl == -1:
            return 1
        return int(cluster_churn_rate.get(cl, 0.5) >= 0.5)

    df['y_pred'] = df['cluster'].apply(predict_churn)
    # 확률: 클러스터 이탈율 사용
    df['y_prob'] = df['cluster'].apply(
        lambda c: cluster_churn_rate.get(c, 0.5) if c != -1 else 1.0
    )

    y_pred = df['y_pred'].values
    y_prob = df['y_prob'].values

    acc  = accuracy_score(y_true, y_pred)
    prec = precision_score(y_true, y_pred, zero_division=0)
    rec  = recall_score(y_true, y_pred, zero_division=0)
    f1   = f1_score(y_true, y_pred, zero_division=0)
    f1w  = f1_score(y_true, y_pred, average='weighted', zero_division=0)

    print(f'  ※ 클러스터 다수결 → 이탈/전환 예측으로 변환')
    print(f'\n  Accuracy          : {acc:.4f}')
    print(f'  Precision (binary): {prec:.4f}')
    print(f'  Recall    (binary): {rec:.4f}')
    print(f'  F1        (binary): {f1:.4f}')
    print(f'  F1        (weighted): {f1w:.4f}')

    try:
        roc = roc_auc_score(y_true, y_prob)
        pr  = average_precision_score(y_true, y_prob)
        print(f'  ROC-AUC           : {roc:.4f}')
        print(f'  PR-AUC            : {pr:.4f}')
    except Exception:
        print('  [경고] ROC/PR-AUC 계산 불가 (클래스 불균형)')

    print('\n  [Confusion Matrix]  (행=실제, 열=예측)')
    cm = confusion_matrix(y_true, y_pred)
    labels = ['전환(0)', '이탈(1)']
    cm_df = pd.DataFrame(cm, index=labels, columns=[f'예측_{l}' for l in labels])
    print(cm_df.to_string(col_space=10))

    print('\n  [Classification Report]')
    print(classification_report(y_true, y_pred,
                                target_names=['전환(0)', '이탈(1)'],
                                zero_division=0))


# ── 메인 ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='GhostTracker 클러스터링 평가')
    parser.add_argument('--cluster',    default=DEFAULT_CL,   help='cluster_results.csv 경로')
    parser.add_argument('--embeddings', default=DEFAULT_EMB,  help='session_embeddings.npy 경로')
    parser.add_argument('--mongo-uri',  default=MONGO_URI,    help='MongoDB URI')
    parser.add_argument('--no-mongo',   action='store_true',  help='MongoDB 연결 없이 클러스터 지표만')
    args = parser.parse_args()

    # 파일 로드
    if not os.path.exists(args.cluster):
        print(f'[Eval] ❌ cluster_results.csv 없음: {args.cluster}')
        sys.exit(1)
    if not os.path.exists(args.embeddings):
        print(f'[Eval] ❌ session_embeddings.npy 없음: {args.embeddings}')
        sys.exit(1)

    cluster_df  = pd.read_csv(args.cluster)
    embeddings  = np.load(args.embeddings)
    session_ids = cluster_df['session_id'].tolist()

    print(f'[Eval] 클러스터 결과: {len(cluster_df)}세션')
    print(f'[Eval] 임베딩 shape: {embeddings.shape}')

    # MongoDB에서 라벨 가져오기
    churn_map = {}
    if not args.no_mongo:
        print('[Eval] MongoDB에서 이탈 라벨 조회 중...')
        churn_map = fetch_churn_labels(args.mongo_uri, session_ids)
        if churn_map:
            churned = sum(churn_map.values())
            print(f'[Eval] 라벨 조회 완료: 이탈={churned} / 전환={len(churn_map)-churned}')

    # 평가 실행
    evaluate_clustering(embeddings, cluster_df)
    evaluate_interpretability(cluster_df, churn_map)
    evaluate_classification(cluster_df, churn_map)

    print('\n=== 평가 완료 ===')


if __name__ == '__main__':
    main()
