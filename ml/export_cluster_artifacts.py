"""
새 파이프라인 출력 → cluster_server.py 가 읽는 artifacts 로 변환.

입력 (기본 경로)
  output/transformer/transformer_encoder.pt      학습된 인코더
  output/transformer/vocab.json                  토큰 → id
  output/transformer/session_embeddings.npy      세션 임베딩
  output/clustering/cluster_results.csv          세션별 클러스터 배정
  output/clustering/cluster_metrics.json         품질 지표 (선택)

출력 (--out-dir, 기본 output/unsupervised_semantic)
  bert_encoder.pt        인코더 체크포인트 (그대로 복사)
  cluster_centroids.npy  (n_clusters, embed_dim) 클러스터 중심
  cluster_meta.json      vocab + 라벨 + 프로파일 + 품질 지표

주의
  cluster_server.py 는 centroid 배열의 **행 인덱스를 cluster_id 로 그대로** 쓴다.
  따라서 클러스터 id 가 0..n-1 로 연속이어야 한다. 아니면 여기서 실패시킨다.

사용법
  python export_cluster_artifacts.py
  python export_cluster_artifacts.py --dry-run      # 파일 쓰지 않고 점검만
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
from collections import Counter, defaultdict
from datetime import datetime
from typing import Dict, List

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def p(*parts: str) -> str:
    return os.path.join(HERE, *parts)


# ── 입력 로드 ────────────────────────────────────────────────

def load_cluster_results(path: str) -> List[dict]:
    with open(path, "r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError(f"비어 있음: {path}")
    return rows


def token_parts(token: str):
    """PAGE|SEMANTIC|CONTEXTUAL 분해. 특수토큰은 None."""
    parts = token.split("|")
    if len(parts) != 3:
        return None, None, None
    return parts[0], parts[1], parts[2]


def build_profiles(rows: List[dict], labels: np.ndarray, top_n: int = 8) -> Dict[str, dict]:
    """클러스터별 대표 행동 / 페이지 분포 요약."""
    by_cluster = defaultdict(list)
    for row, lab in zip(rows, labels):
        by_cluster[int(lab)].append(row)

    profiles: Dict[str, dict] = {}
    for cid, group in sorted(by_cluster.items()):
        if cid == -1:
            continue
        actions: Counter = Counter()
        pages: Counter = Counter()
        tokens: Counter = Counter()
        lengths: List[int] = []

        for row in group:
            seq = (row.get("sequence") or "").split()
            lengths.append(int(row.get("used_length") or len(seq)))
            for tok in seq:
                page, action, _ = token_parts(tok)
                tokens[tok] += 1
                if action:
                    actions[action] += 1
                if page:
                    pages[page] += 1

        profiles[str(cid)] = {
            "size": len(group),
            "avg_length": round(float(np.mean(lengths)), 2) if lengths else 0.0,
            "top_actions": [
                {"action": a, "count": c} for a, c in actions.most_common(top_n)
            ],
            "top_tokens": [
                {"token": t, "count": c} for t, c in tokens.most_common(top_n)
            ],
            "page_dist": dict(pages.most_common(top_n)),
        }
    return profiles


def auto_label(profile: dict) -> str:
    """
    NLP 라벨이 없을 때 쓰는 임시 이름.
    상위 행동 2개 + 주요 페이지로 만든다. 사람이 읽을 수 있는 수준이면 충분하다.
    """
    top = [a["action"] for a in profile.get("top_actions", [])[:2]]
    page_dist = profile.get("page_dist", {})
    main_page = max(page_dist, key=lambda k: page_dist[k]) if page_dist else "?"
    if not top:
        return f"{main_page} 세션"
    return f"{main_page}/{'+'.join(top)}"


# ── 메인 ────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoder", default=p("output", "transformer", "transformer_encoder.pt"))
    ap.add_argument("--vocab", default=p("output", "transformer", "vocab.json"))
    ap.add_argument("--embeddings", default=p("output", "transformer", "session_embeddings.npy"))
    ap.add_argument("--cluster-results", default=p("output", "clustering", "cluster_results.csv"))
    ap.add_argument("--cluster-metrics", default=p("output", "clustering", "cluster_metrics.json"))
    ap.add_argument("--out-dir", default=p("output", "unsupervised_semantic"))
    ap.add_argument("--no-backup", action="store_true", help="기존 artifacts 백업을 건너뛴다.")
    ap.add_argument("--dry-run", action="store_true", help="점검만 하고 파일을 쓰지 않는다.")
    args = ap.parse_args()

    for path in (args.encoder, args.vocab, args.embeddings, args.cluster_results):
        if not os.path.exists(path):
            raise FileNotFoundError(f"입력 파일 없음: {path}")

    with open(args.vocab, "r", encoding="utf-8") as f:
        vocab = json.load(f)
    embeddings = np.load(args.embeddings)
    rows = load_cluster_results(args.cluster_results)
    labels = np.array([int(r["cluster"]) for r in rows])

    if len(rows) != embeddings.shape[0]:
        raise ValueError(
            f"행 수 불일치: cluster_results {len(rows)} vs embeddings {embeddings.shape[0]}. "
            "같은 실행에서 나온 파일인지 확인하세요."
        )

    cluster_ids = sorted({int(c) for c in labels if int(c) != -1})
    if cluster_ids != list(range(len(cluster_ids))):
        raise ValueError(
            f"클러스터 id 가 0..n-1 연속이 아닙니다: {cluster_ids}\n"
            "cluster_server.py 는 centroid 행 인덱스를 cluster_id 로 사용합니다."
        )

    # ── centroid: 클러스터별 임베딩 평균 ────────────────────
    # cluster_session_embeddings.py 가 L2 정규화 후 클러스터링하므로
    # centroid 도 정규화된 벡터 위에서 계산해 같은 공간에 둔다.
    normed = embeddings / (np.linalg.norm(embeddings, axis=1, keepdims=True) + 1e-9)
    centroids = np.stack(
        [normed[labels == cid].mean(axis=0) for cid in cluster_ids]
    ).astype(np.float32)

    profiles = build_profiles(rows, labels)
    nlp_labels = {
        str(cid): {"name": auto_label(profiles[str(cid)]), "source": "auto"}
        for cid in cluster_ids
    }

    metrics = {}
    if os.path.exists(args.cluster_metrics):
        with open(args.cluster_metrics, "r", encoding="utf-8") as f:
            metrics = json.load(f)

    meta = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "generated_by": "export_cluster_artifacts.py",
        "model_class": "SessionTransformerEncoder",
        "num_clusters": len(cluster_ids),
        "cluster_ids": cluster_ids,
        "embedding_dim": int(embeddings.shape[1]),
        "vocab": vocab,
        "vocab_size": len(vocab),
        "cluster_counts": {str(cid): int((labels == cid).sum()) for cid in cluster_ids},
        "noise_count": int((labels == -1).sum()),
        "session_count": len(rows),
        "cluster_profiles": profiles,
        "nlp_labels": nlp_labels,
        "silhouette": metrics.get("silhouette"),
        "davies_bouldin": metrics.get("davies_bouldin"),
        "calinski_harabasz": metrics.get("calinski_harabasz"),
        "noise_ratio": metrics.get("noise_ratio"),
        "duplicate_sequence_ratio": metrics.get("duplicate_sequence_ratio"),
        "cluster_quality": metrics,
    }

    print("=== Export 점검 ===")
    print(f"  세션 수        : {len(rows)}")
    print(f"  클러스터       : {len(cluster_ids)}개 {cluster_ids}")
    print(f"  노이즈         : {meta['noise_count']}")
    print(f"  vocab          : {len(vocab)}")
    print(f"  centroid shape : {centroids.shape}")
    print(f"  silhouette     : {meta['silhouette']}")
    print("  자동 라벨:")
    for cid in cluster_ids:
        cnt = meta["cluster_counts"][str(cid)]
        print(f"    {cid}: {nlp_labels[str(cid)]['name']}  ({cnt}세션)")

    if args.dry_run:
        print("\n--dry-run: 파일을 쓰지 않았습니다.")
        return

    os.makedirs(args.out_dir, exist_ok=True)

    # 기존 artifacts 백업 — 되돌릴 수 있어야 한다
    if not args.no_backup:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        for name in ("cluster_meta.json", "cluster_centroids.npy", "bert_encoder.pt"):
            src = os.path.join(args.out_dir, name)
            if os.path.exists(src):
                root, ext = os.path.splitext(name)
                shutil.copy2(src, os.path.join(args.out_dir, f"{root}_backup_{stamp}{ext}"))
        print(f"\n기존 artifacts 백업 완료 (suffix _backup_{stamp})")

    meta_path = os.path.join(args.out_dir, "cluster_meta.json")
    centroids_path = os.path.join(args.out_dir, "cluster_centroids.npy")
    encoder_path = os.path.join(args.out_dir, "bert_encoder.pt")

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    np.save(centroids_path, centroids)
    shutil.copy2(args.encoder, encoder_path)

    print("\nSaved:")
    print(f"  {meta_path}")
    print(f"  {centroids_path}")
    print(f"  {encoder_path}")


if __name__ == "__main__":
    main()
