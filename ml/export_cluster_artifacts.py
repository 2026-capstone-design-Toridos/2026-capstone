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

        total_actions = sum(actions.values()) or 1
        total_pages = sum(pages.values()) or 1

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
            # 비율은 클러스터 크기와 무관하므로 규칙 판정에 쓴다.
            "action_share": {a: c / total_actions for a, c in actions.items()},
            "page_share": {a: c / total_pages for a, c in pages.items()},
        }
    return profiles


# ── 페르소나 이름 부여 ───────────────────────────────────────
#
# 클러스터 id 는 재실행할 때마다 바뀐다. id 에 이름을 고정하면 다음 학습에서
# 엉뚱한 유형에 붙는다. 따라서 **행동 비율로 판정**한다.
#
# 임계값은 2026-08-19 실측 기준으로 잡았다.
#   C1 CHECK_PRICE 66% / C0 CATEGORY 56%·ADD_CART 0.2% /
#   C3 EDIT_INPUT 6.2%·평균길이 75 / C2 PRODUCT 79%·리뷰+사이즈+확대 17%

PERSONA_RULES = [
    {
        "id": "price_checker",
        "name": "가격을 반복 확인하는 고객",
        "description": "상품 페이지에서 가격 구간을 계속 오가며 확인합니다. 구매 의사는 있으나 가격에서 망설입니다.",
        "suggestion": "할인 조건이나 무료배송 기준을 가격 근처에 함께 보여주세요.",
        "test": lambda a, pg, prof: a.get("CHECK_PRICE", 0) >= 0.25,
    },
    {
        "id": "size_checker",
        "name": "사이즈를 확인하는 고객",
        "description": "사이즈 표를 반복해서 봅니다. 치수 확신이 없어 결정을 미룹니다.",
        "suggestion": "실측 사이즈와 모델 착용 정보를 사이즈 표 옆에 배치하세요.",
        "test": lambda a, pg, prof: a.get("CHECK_SIZE", 0) >= 0.20,
    },
    {
        "id": "review_reader",
        "name": "리뷰를 찾아보는 고객",
        "description": "리뷰 영역에 오래 머무릅니다. 다른 사람의 후기로 확신을 얻으려 합니다.",
        "suggestion": "사진 리뷰를 상단으로 올리고 리뷰 수를 상품명 옆에 표시하세요.",
        "test": lambda a, pg, prof: a.get("VIEW_REVIEW", 0) >= 0.20,
    },
    {
        "id": "list_bouncer",
        "name": "목록만 훑고 나가는 고객",
        "description": "카테고리 목록을 스크롤하다 상품에 들어가지 않고 이탈합니다. 끌리는 상품을 못 찾았습니다.",
        "suggestion": "목록 썸네일과 첫 화면 상품 구성을 점검하세요.",
        "test": lambda a, pg, prof: pg.get("CATEGORY", 0) >= 0.40 and a.get("ADD_CART", 0) < 0.01,
    },
    {
        "id": "active_buyer",
        "name": "구매까지 진행하는 활발한 고객",
        "description": "여러 화면을 오가며 장바구니에 담고 입력까지 진행합니다. 가장 오래 머무는 유형입니다.",
        "suggestion": "이 경로에서 이탈이 생기면 손실이 가장 큽니다. 결제 단계를 우선 점검하세요.",
        "test": lambda a, pg, prof: (
            a.get("EDIT_INPUT", 0) >= 0.04
            or (a.get("ADD_CART", 0) >= 0.03 and prof.get("avg_length", 0) >= 50)
        ),
    },
    {
        "id": "detail_reader",
        "name": "상품 상세를 꼼꼼히 보는 고객",
        "description": "상품 페이지를 천천히 내리며 이미지·리뷰·사이즈를 두루 봅니다.",
        "suggestion": "상세 이미지 하단에 담기 버튼을 한 번 더 두면 이탈을 줄일 수 있습니다.",
        "test": lambda a, pg, prof: (
            pg.get("PRODUCT", 0) >= 0.60
            and (a.get("VIEW_REVIEW", 0) + a.get("CHECK_SIZE", 0) + a.get("ZOOM_IMAGE", 0)) >= 0.10
        ),
    },
]

FALLBACK_PERSONA = {
    "id": "browser",
    "name": "둘러보는 고객",
    "description": "뚜렷한 목적 행동 없이 여러 화면을 이동합니다.",
    "suggestion": "관심을 끌 진입 지점이 있는지 확인하세요.",
}


def auto_label(profile: dict) -> dict:
    """행동 비율 규칙으로 페르소나를 판정한다. 어디에도 안 걸리면 fallback."""
    a = profile.get("action_share", {})
    pg = profile.get("page_share", {})
    for rule in PERSONA_RULES:
        try:
            if rule["test"](a, pg, profile):
                return {
                    "id": rule["id"],
                    "name": rule["name"],
                    "description": rule["description"],
                    "suggestion": rule["suggestion"],
                    "source": "rule",
                }
        except Exception:
            continue
    return {**FALLBACK_PERSONA, "source": "fallback"}


def load_overrides(path: str) -> dict:
    """
    규칙이 틀렸을 때 손으로 덮어쓰는 파일.
    형식: {"1": {"name": "...", "description": "...", "suggestion": "..."}}
    """
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── 메인 ────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoder", default=p("output", "transformer", "transformer_encoder.pt"))
    ap.add_argument("--vocab", default=p("output", "transformer", "vocab.json"))
    ap.add_argument("--embeddings", default=p("output", "transformer", "session_embeddings.npy"))
    ap.add_argument("--cluster-results", default=p("output", "clustering", "cluster_results.csv"))
    ap.add_argument("--cluster-metrics", default=p("output", "clustering", "cluster_metrics.json"))
    ap.add_argument("--out-dir", default=p("output", "unsupervised_semantic"))
    ap.add_argument(
        "--labels",
        default=p("cluster_labels.json"),
        help="페르소나 이름 수동 지정 파일 (규칙 판정보다 우선).",
    )
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
    overrides = load_overrides(args.labels)

    nlp_labels = {}
    for cid in cluster_ids:
        persona = auto_label(profiles[str(cid)])
        ov = overrides.get(str(cid))
        if ov:
            persona = {**persona, **ov, "source": "manual"}
        nlp_labels[str(cid)] = persona

    dup_names = [n for n, c in Counter(
        v["name"] for v in nlp_labels.values()
    ).items() if c > 1]
    if dup_names:
        print(f"  ⚠ 같은 이름이 여러 클러스터에 붙었습니다: {dup_names}")
        print(f"    {args.labels} 로 구분해 주세요.")

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
    print("  페르소나:")
    for cid in cluster_ids:
        cnt = meta["cluster_counts"][str(cid)]
        lab = nlp_labels[str(cid)]
        mark = "수동" if lab.get("source") == "manual" else (
            "규칙" if lab.get("source") == "rule" else "미분류"
        )
        print(f"    {cid}: {lab['name']}  ({cnt}세션, {mark})")
        print(f"       → {lab.get('suggestion', '')}")

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
