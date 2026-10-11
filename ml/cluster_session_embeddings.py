"""
cluster_session_embeddings.py — 세션 임베딩 클러스터링

역할: train_transformer_encoder.py가 생성한 session_embeddings.npy를 읽어
     L2 정규화, PCA 시각화, HDBSCAN 클러스터링을 수행하고
     클러스터별 행동 요약을 사람이 읽을 수 있는 파일로 저장한다.

입력:
  output/transformer/session_embeddings.npy
  output/transformer/session_embedding_meta.csv

출력:
  output/clustering/cluster_results.csv
  output/clustering/cluster_plot_pca.png
  output/clustering/cluster_summary.txt
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter, defaultdict
from datetime import datetime

import numpy as np
import matplotlib.pyplot as plt

from sklearn.decomposition import PCA
from sklearn.preprocessing import normalize

try:
    import hdbscan
except ImportError:
    hdbscan = None


# ── 파일/토큰 헬퍼 ────────────────────────────────────────────

# 출력 디렉토리가 없으면 생성한다
def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


# session_embedding_meta.csv를 읽어 행 목록으로 반환한다
def load_meta(path: str):
    rows = []

    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    return rows


# PAGE|SEMANTIC|CONTEXTUAL 형태의 토큰을 세 파트로 분리한다
def token_parts(token: str):
    if not token or "|" not in token:
        return "UNKNOWN", "UNKNOWN", "UNKNOWN"

    parts = token.split("|")
    page = parts[0] if len(parts) > 0 else "UNKNOWN"
    semantic = parts[1] if len(parts) > 1 else "UNKNOWN"
    contextual = parts[2] if len(parts) > 2 else "UNKNOWN"

    return page, semantic, contextual


# 세션 row에서 sequence를 공백 구분 토큰 리스트로 추출한다
def get_tokens(row):
    seq = row.get("sequence", "") or ""
    return seq.split()


# ── 차원 축소 / 클러스터링 ────────────────────────────────────

# 임베딩을 PCA로 2차원으로 축소해 시각화용 좌표를 반환한다
def run_pca(embeddings: np.ndarray, n_components: int = 2):
    pca = PCA(n_components=n_components, random_state=42)
    points = pca.fit_transform(embeddings)
    return points, pca


# HDBSCAN으로 임베딩을 클러스터링하고 레이블·확률을 반환한다
def run_hdbscan(embeddings: np.ndarray, min_cluster_size: int, min_samples: int):
    if hdbscan is None:
        raise ImportError(
            "hdbscan이 설치되어 있지 않습니다. pip install hdbscan 후 다시 실행하세요."
        )

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="euclidean",
    )

    labels = clusterer.fit_predict(embeddings)

    probs = getattr(clusterer, "probabilities_", np.ones(len(labels)))

    return labels, probs, clusterer


# ── 품질 지표 ────────────────────────────────────────────────

def evaluate_clusters(x: np.ndarray, labels: np.ndarray, meta_rows) -> dict:
    """
    클러스터링 결과의 품질을 수치로 산출한다.

    silhouette / davies_bouldin 은 노이즈(-1)를 제외하고 계산한다.
    노이즈를 하나의 클러스터로 넣으면 흩어진 점들이 한 덩어리로 취급돼
    지표가 실제보다 나쁘게 나온다.
    """
    labels = np.asarray(labels)
    mask = labels != -1
    n_total = len(labels)
    n_noise = int((~mask).sum())
    clustered = labels[mask]
    sizes = Counter(clustered.tolist())

    metrics: dict = {
        "n_sessions": n_total,
        "n_clusters": len(sizes),
        "n_noise": n_noise,
        "noise_ratio": round(n_noise / n_total, 4) if n_total else None,
        "cluster_sizes": {str(k): v for k, v in sorted(sizes.items())},
        "min_cluster_size_observed": min(sizes.values()) if sizes else None,
        "max_cluster_size_observed": max(sizes.values()) if sizes else None,
        "silhouette": None,
        "davies_bouldin": None,
        "calinski_harabasz": None,
        "duplicate_sequence_ratio": None,
    }

    # 동일 토큰 시퀀스 비율 — 높으면 입력이 서로 구분되지 않는다는 뜻이므로
    # 지표가 좋게 나와도 신뢰할 수 없다. (레이아웃 재생 버그 재발 감지용)
    try:
        seqs = [tuple(get_tokens(r)) for r in meta_rows]
        counts = Counter(seqs)
        dup = sum(c for c in counts.values() if c > 1)
        metrics["duplicate_sequence_ratio"] = round(dup / len(seqs), 4) if seqs else None
        metrics["unique_sequences"] = len(counts)
    except Exception:
        pass

    if len(sizes) >= 2 and mask.sum() > len(sizes):
        try:
            from sklearn.metrics import (
                silhouette_score,
                davies_bouldin_score,
                calinski_harabasz_score,
            )
            metrics["silhouette"] = round(float(silhouette_score(x[mask], clustered)), 4)
            metrics["davies_bouldin"] = round(float(davies_bouldin_score(x[mask], clustered)), 4)
            metrics["calinski_harabasz"] = round(float(calinski_harabasz_score(x[mask], clustered)), 2)
        except Exception as exc:  # sklearn 미설치 등
            metrics["metric_error"] = str(exc)

    return metrics


def format_metrics(m: dict) -> str:
    def fmt(v, nd=3):
        return "n/a" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))

    lines = [
        "=== Cluster Quality Metrics ===",
        f"  세션 수            : {m['n_sessions']}",
        f"  클러스터 수        : {m['n_clusters']}  (크기 {m['min_cluster_size_observed']}~{m['max_cluster_size_observed']})",
        f"  노이즈(미분류)     : {m['n_noise']} ({fmt((m['noise_ratio'] or 0) * 100, 1)}%)   낮을수록 좋음 / 30% 넘으면 재검토",
        f"  silhouette         : {fmt(m['silhouette'])}   -1~1, 높을수록 좋음 / 0.5 이상 양호",
        f"  davies_bouldin     : {fmt(m['davies_bouldin'])}   낮을수록 좋음 / 1.0 이하 양호",
        f"  calinski_harabasz  : {fmt(m['calinski_harabasz'], 1)}   높을수록 좋음",
    ]
    if m.get("duplicate_sequence_ratio") is not None:
        ratio = m["duplicate_sequence_ratio"] * 100
        warn = "   ⚠ 입력이 서로 구분되지 않음 — 지표 신뢰 불가" if ratio >= 30 else ""
        lines.append(
            f"  동일 시퀀스 비율   : {fmt(ratio, 1)}%  (고유 {m.get('unique_sequences', '?')}개){warn}"
        )
    if m.get("metric_error"):
        lines.append(f"  ! 지표 계산 실패: {m['metric_error']}")
    return "\n".join(lines)


# ── 결과 저장 / 리포트 ───────────────────────────────────────

# 클러스터 레이블·확률·PCA 좌표를 CSV로 저장한다
def save_cluster_results(meta_rows, labels, probs, pca_points, output_path):
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        fieldnames = [
            "session_id",
            "cluster",
            "probability",
            "pca_x",
            "pca_y",
            "original_length",
            "used_length",
            "sequence",
        ]

        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for row, label, prob, point in zip(meta_rows, labels, probs, pca_points):
            writer.writerow({
                "session_id": row.get("session_id"),
                "cluster": int(label),
                "probability": float(prob),
                "pca_x": float(point[0]),
                "pca_y": float(point[1]),
                "original_length": row.get("original_length"),
                "used_length": row.get("used_length"),
                "sequence": row.get("sequence"),
            })


# PCA 2D 좌표에 클러스터별 색상을 입혀 PNG로 저장한다
def plot_clusters(pca_points, labels, output_path):
    plt.figure(figsize=(10, 7))

    unique_labels = sorted(set(labels))

    for label in unique_labels:
        idx = labels == label

        if label == -1:
            label_name = "noise(-1)"
        else:
            label_name = f"cluster {label}"

        plt.scatter(
            pca_points[idx, 0],
            pca_points[idx, 1],
            label=label_name,
            alpha=0.8,
            s=80,
        )

    plt.title("Session Embedding Clusters (PCA 2D)")
    plt.xlabel("PCA 1")
    plt.ylabel("PCA 2")
    plt.legend()
    plt.tight_layout()
    plt.savefig(output_path, dpi=160)
    plt.close()


# 클러스터별 세션 수·상위 토큰·페이지 분포를 텍스트 파일로 요약한다
def summarize_clusters(meta_rows, labels, output_path, top_n: int = 10):
    ensure_dir(os.path.dirname(output_path) or ".")

    cluster_rows = defaultdict(list)

    for row, label in zip(meta_rows, labels):
        cluster_rows[int(label)].append(row)

    lines = []

    lines.append("=== Cluster Summary ===")
    lines.append(f"Total sessions: {len(meta_rows)}")
    lines.append("Cluster counts:")
    lines.append("")

    count = Counter(labels)
    for label, n in sorted(count.items(), key=lambda x: x[0]):
        lines.append(f"  cluster {label}: {n}")

    lines.append("")

    for label, rows in sorted(cluster_rows.items(), key=lambda x: x[0]):
        lines.append("=" * 60)
        lines.append(f"Cluster {label}")
        lines.append("=" * 60)
        lines.append(f"Session count: {len(rows)}")

        lengths = []
        token_counter = Counter()
        semantic_counter = Counter()
        page_counter = Counter()

        for row in rows:
            try:
                lengths.append(int(float(row.get("used_length") or 0)))
            except ValueError:
                pass

            tokens = get_tokens(row)
            token_counter.update(tokens)

            for token in tokens:
                page, semantic, contextual = token_parts(token)
                semantic_counter[semantic] += 1
                page_counter[page] += 1

        if lengths:
            lines.append(f"Avg used length: {sum(lengths) / len(lengths):.2f}")
            lines.append(f"Min/Max length: {min(lengths)} / {max(lengths)}")

        lines.append("")
        lines.append("Top tokens:")
        for token, c in token_counter.most_common(top_n):
            lines.append(f"  {token}: {c}")

        lines.append("")
        lines.append("Top semantic actions:")
        for semantic, c in semantic_counter.most_common(top_n):
            lines.append(f"  {semantic}: {c}")

        lines.append("")
        lines.append("Page distribution:")
        for page, c in page_counter.most_common(top_n):
            lines.append(f"  {page}: {c}")

        lines.append("")
        lines.append("Representative sessions:")
        for row in rows[:3]:
            lines.append(f"  - {row.get('session_id')} | len={row.get('used_length')}")
            seq = row.get("sequence", "")
            if len(seq) > 300:
                seq = seq[:300] + " ..."
            lines.append(f"    {seq}")

        lines.append("")

    report = "\n".join(lines)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    return report


# CLI 진입점 — 임베딩 로드 → L2 정규화 → PCA → HDBSCAN → CSV·차트·요약 저장
def main():
    parser = argparse.ArgumentParser(
        description="Cluster GhostTracker session embeddings."
    )

    parser.add_argument(
        "--embeddings",
        default="output/transformer/session_embeddings.npy",
        help="Path to session_embeddings.npy",
    )

    parser.add_argument(
        "--meta",
        default="output/transformer/session_embedding_meta.csv",
        help="Path to session_embedding_meta.csv",
    )

    parser.add_argument(
        "--output-dir",
        default="output/clustering",
        help="Output directory",
    )

    parser.add_argument(
        "--min-cluster-size",
        type=int,
        default=3,
    )

    parser.add_argument(
        "--min-samples",
        type=int,
        default=2,
    )

    parser.add_argument(
        "--no-normalize",
        action="store_true",
        help="Do not L2 normalize embeddings before clustering.",
    )

    args = parser.parse_args()

    ensure_dir(args.output_dir)

    embeddings = np.load(args.embeddings)
    meta_rows = load_meta(args.meta)

    if len(meta_rows) != embeddings.shape[0]:
        raise ValueError(
            f"meta rows({len(meta_rows)}) != embeddings rows({embeddings.shape[0]})"
        )

    print("\n=== Loaded Embeddings ===")
    print(f"Embedding shape: {embeddings.shape}")
    print(f"Meta rows      : {len(meta_rows)}")

    x = embeddings

    if not args.no_normalize:
        x = normalize(x, norm="l2")
        print("Applied L2 normalization")

    pca_points, pca = run_pca(x, n_components=2)

    # HDBSCAN은 노이즈를 -1로 표시하므로 이후 요약에서도 별도 클러스터처럼 다룬다
    labels, probs, clusterer = run_hdbscan(
        x,
        min_cluster_size=args.min_cluster_size,
        min_samples=args.min_samples,
    )

    print("\n=== Clustering Result ===")
    print(f"Labels: {sorted(set(labels))}")
    print("Cluster counts:")
    for label, c in sorted(Counter(labels).items(), key=lambda x: x[0]):
        print(f"  {label}: {c}")

    metrics = evaluate_clusters(x, labels, meta_rows)
    print("\n" + format_metrics(metrics))

    result_csv = os.path.join(args.output_dir, "cluster_results.csv")
    plot_path = os.path.join(args.output_dir, "cluster_plot_pca.png")
    summary_path = os.path.join(args.output_dir, "cluster_summary.txt")
    metrics_path = os.path.join(args.output_dir, "cluster_metrics.json")

    metrics_out = dict(metrics)
    metrics_out["generated_at"] = datetime.now().isoformat(timespec="seconds")
    metrics_out["params"] = {
        "min_cluster_size": args.min_cluster_size,
        "min_samples": args.min_samples,
        "l2_normalized": not args.no_normalize,
    }
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(metrics_out, f, ensure_ascii=False, indent=2)

    save_cluster_results(meta_rows, labels, probs, pca_points, result_csv)
    plot_clusters(pca_points, labels, plot_path)

    report = summarize_clusters(
        meta_rows,
        labels,
        summary_path,
        top_n=10,
    )

    print("\n" + report)

    print("\nSaved:")
    print(f"  Results CSV : {result_csv}")
    print(f"  PCA Plot    : {plot_path}")
    print(f"  Summary     : {summary_path}")
    print(f"  Metrics     : {metrics_path}")


if __name__ == "__main__":
    main()
