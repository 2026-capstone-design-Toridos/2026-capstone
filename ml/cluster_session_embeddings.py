"""
cluster_session_embeddings.py

Transformer로 생성한 session_embeddings.npy를 읽어서
PCA/UMAP 시각화 + HDBSCAN 클러스터링을 수행한다.

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
import os
from collections import Counter, defaultdict

import numpy as np
import matplotlib.pyplot as plt

from sklearn.decomposition import PCA
from sklearn.preprocessing import normalize

try:
    import hdbscan
except ImportError:
    hdbscan = None


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def load_meta(path: str):
    rows = []

    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    return rows


def token_parts(token: str):
    if not token or "|" not in token:
        return "UNKNOWN", "UNKNOWN", "UNKNOWN"

    parts = token.split("|")
    page = parts[0] if len(parts) > 0 else "UNKNOWN"
    semantic = parts[1] if len(parts) > 1 else "UNKNOWN"
    contextual = parts[2] if len(parts) > 2 else "UNKNOWN"

    return page, semantic, contextual


def get_tokens(row):
    seq = row.get("sequence", "") or ""
    return seq.split()


def run_pca(embeddings: np.ndarray, n_components: int = 2):
    pca = PCA(n_components=n_components, random_state=42)
    points = pca.fit_transform(embeddings)
    return points, pca


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

    result_csv = os.path.join(args.output_dir, "cluster_results.csv")
    plot_path = os.path.join(args.output_dir, "cluster_plot_pca.png")
    summary_path = os.path.join(args.output_dir, "cluster_summary.txt")

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


if __name__ == "__main__":
    main()