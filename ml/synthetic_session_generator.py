"""
synthetic_session_generator.py
-------------------------------
페르소나 기반 합성 세션 생성기 (v2 — 12 페르소나)

페르소나 목록
--------------
기존 (5개)
  1. price_sensitive    — 가격 비교 후 결정
  2. review_focused     — 리뷰 꼼꼼히 보고 결정
  3. impulsive          — 짧은 탐색 후 즉시 구매
  4. distracted         — 산만 이탈형
  5. comparison_heavy   — 다상품 비교형

신규 (7개)
  6. bounce_visitor     — 즉시 이탈형 (홈/상품 보자마자 나감)
  7. wishlist_browser   — 긴 탐색, 구매 의사 없음
  8. cart_abandoner     — 장바구니 담고 결제 포기
  9. size_obsessed      — 사이즈/옵션 반복 확인형
 10. search_driven      — 검색 중심 탐색형
 11. media_explorer     — 이미지/영상 집중 탐색형
 12. checkout_hesitant  — 결제 직전 망설임형

Usage
-----
  cd ml/
  python synthetic_session_generator.py --n 2400 --seed 42
  python synthetic_session_generator.py --n 2400 --include_persona
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import time
import uuid
from typing import List


# ═══════════════════════════════════════════════════════════════════
# 토큰 풀
# ═══════════════════════════════════════════════════════════════════

SESSION_START = [
    "HOME|START_SESSION|NONE",
    "HOME|ENTER_HOME|NONE",
]

HOME_BROWSE = [
    "HOME|SCROLL_HOME|SCROLL_LOW",
    "HOME|SCROLL_HOME|SCROLL_MID",
    "HOME|SCROLL_HOME|SCROLL_HIGH",
    "HOME|HOVER_ELEMENT|HOVER_SHORT",
    "HOME|CLICK_ELEMENT|NONE",
    "HOME|CHECK_PRICE|DWELL_SHORT",
]

HOME_EXIT = ["HOME|EXIT_SESSION|NONE"]
HOME_BOUNCE = ["HOME|EXIT_BOUNCE|NONE"]

CATEGORY_BROWSE = [
    "CATEGORY|ENTER_CATEGORY|NONE",
    "CATEGORY|SCROLL_PAGE|SCROLL_LOW",
    "CATEGORY|SCROLL_PAGE|SCROLL_MID",
    "CATEGORY|SCROLL_PAGE|SCROLL_HIGH",
    "CATEGORY|CLICK_ELEMENT|NONE",
    "CATEGORY|HOVER_ELEMENT|HOVER_SHORT",
    "CATEGORY|SEARCH_USE|NONE",
]

SEARCH_TOKENS = [
    "HOME|SEARCH_USE|NONE",
    "CATEGORY|SEARCH_USE|NONE",
    "CATEGORY|ENTER_CATEGORY|NONE",
    "CATEGORY|SCROLL_PAGE|SCROLL_MID",
    "CATEGORY|SCROLL_PAGE|SCROLL_HIGH",
    "CATEGORY|CLICK_ELEMENT|NONE",
]

PRODUCT_ENTER = ["PRODUCT|ENTER_PRODUCT|NONE"]

PRODUCT_BROWSE = [
    "PRODUCT|VIEW_PRODUCT|DWELL_SHORT",
    "PRODUCT|VIEW_PRODUCT|DWELL_MEDIUM",
    "PRODUCT|VIEW_PRODUCT|DWELL_LONG",
    "PRODUCT|SCROLL_PRODUCT|SCROLL_LOW",
    "PRODUCT|SCROLL_PRODUCT|SCROLL_MID",
    "PRODUCT|SCROLL_PRODUCT|SCROLL_HIGH",
    "PRODUCT|HOVER_ELEMENT|HOVER_SHORT",
    "PRODUCT|HOVER_ELEMENT|HOVER_LONG",
    "PRODUCT|CLICK_ELEMENT|NONE",
]

PRODUCT_MEDIA = [
    "PRODUCT|ZOOM_IMAGE|NONE",
    "PRODUCT|VIEW_IMAGE|NONE",
    "PRODUCT|WATCH_VIDEO|NONE",
    "PRODUCT|ZOOM_IMAGE|NONE",
    "PRODUCT|VIEW_IMAGE|NONE",
    "PRODUCT|ZOOM_IMAGE|NONE",  # zoom 빈도 높게
]

PRODUCT_PRICE = [
    "PRODUCT|CHECK_PRICE|DWELL_SHORT",
    "PRODUCT|CHECK_PRICE|DWELL_MEDIUM",
    "PRODUCT|CHECK_PRICE|DWELL_LONG",
    "PRODUCT|CHECK_SHIPPING|DWELL_SHORT",
    "PRODUCT|CHECK_SHIPPING|DWELL_MEDIUM",
    "PRODUCT|TAB_OUT|NONE",
    "PRODUCT|TAB_RETURN|NONE",
]

PRODUCT_REVIEW = [
    "PRODUCT|VIEW_REVIEW|DWELL_SHORT",
    "PRODUCT|VIEW_REVIEW|DWELL_MEDIUM",
    "PRODUCT|VIEW_REVIEW|DWELL_LONG",
    "PRODUCT|VIEW_REVIEW|REVISIT_ONCE",
    "PRODUCT|VIEW_REVIEW|REVISIT_MULTI",
    "PRODUCT|SCROLL_REVIEW|SCROLL_LOW",
    "PRODUCT|SCROLL_REVIEW|SCROLL_MID",
    "PRODUCT|SCROLL_REVIEW|SCROLL_HIGH",
    "PRODUCT|EXPAND_REVIEW|NONE",
]

PRODUCT_SIZE = [
    "PRODUCT|CHECK_SIZE|DWELL_SHORT",
    "PRODUCT|CHECK_SIZE|DWELL_MEDIUM",
    "PRODUCT|CHECK_SIZE|DWELL_LONG",
    "PRODUCT|CHECK_SIZE|HOVER_SHORT",
    "PRODUCT|CHECK_SIZE|HOVER_LONG",
    "PRODUCT|CHANGE_OPTION|NONE",
    "PRODUCT|CHANGE_QUANTITY|NONE",
]

PRODUCT_ADD = [
    "PRODUCT|ADD_CART|NONE",
]
PRODUCT_REMOVE = [
    "PRODUCT|REMOVE_CART|NONE",
]

PRODUCT_EXIT = ["PRODUCT|EXIT_SESSION|NONE"]
PRODUCT_BOUNCE = ["PRODUCT|EXIT_BOUNCE|NONE"]

TAB_SEQUENCE = [
    "PRODUCT|TAB_OUT|NONE",
    "PRODUCT|TAB_RETURN|NONE",
]

INACTIVE_TOKENS = [
    "PRODUCT|INACTIVE|NONE",
    "HOME|INACTIVE|NONE",
    "CART|INACTIVE|NONE",
]

CART_BROWSE = [
    "CART|ENTER_CART|NONE",
    "CART|VIEW_PRODUCT|DWELL_SHORT",
    "CART|CHECK_PRICE|DWELL_SHORT",
    "CART|CHECK_SHIPPING|DWELL_SHORT",
    "CART|SCROLL_PAGE|SCROLL_MID",
]

CART_MODIFY = [
    "CART|REMOVE_CART|NONE",
    "CART|CHANGE_QUANTITY|NONE",
    "CART|CHANGE_OPTION|NONE",
]

CART_TO_CHECKOUT = [
    "CART|ENTER_CART|NONE",
    "CART|CHECK_SHIPPING|DWELL_SHORT",
    "CART|CLICK_BUY|NONE",
]

CHECKOUT_SEQUENCE = [
    "CHECKOUT|ENTER_CHECKOUT|NONE",
    "CHECKOUT|START_INPUT|NONE",
    "CHECKOUT|EDIT_INPUT|NONE",
    "CHECKOUT|CLICK_BUY|NONE",
]

CHECKOUT_HESITATE = [
    "CHECKOUT|ENTER_CHECKOUT|NONE",
    "CHECKOUT|START_INPUT|NONE",
    "CHECKOUT|EDIT_INPUT|NONE",
    "CHECKOUT|CHECK_PRICE|DWELL_MEDIUM",
    "CHECKOUT|SCROLL_PAGE|SCROLL_MID",
    "CHECKOUT|REMOVE_CART|NONE",
    "CHECKOUT|TAB_OUT|NONE",
    "CHECKOUT|TAB_RETURN|NONE",
    "CHECKOUT|INACTIVE|NONE",
]

NOISE_TOKENS = [
    "PRODUCT|INACTIVE|NONE",
    "HOME|INACTIVE|NONE",
    "PRODUCT|RAGE_CLICK|NONE",
]


# ═══════════════════════════════════════════════════════════════════
# 헬퍼
# ═══════════════════════════════════════════════════════════════════

def _noise(rng: random.Random, tokens: List[str], prob: float = 0.1) -> List[str]:
    result = []
    for t in tokens:
        result.append(t)
        if rng.random() < prob:
            result.append(rng.choice(NOISE_TOKENS))
    return result


# ═══════════════════════════════════════════════════════════════════
# 기존 5개 페르소나
# ═══════════════════════════════════════════════════════════════════

def gen_price_sensitive(rng: random.Random) -> List[str]:
    """가격 비교 후 결정형: CHECK_PRICE / TAB_OUT 반복, 느린 결정."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(2, 4))

    for _ in range(rng.randint(1, 3)):
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(2, 4))
        tokens += rng.sample(PRODUCT_PRICE, k=rng.randint(3, 5))
        if rng.random() < 0.7:
            tokens += TAB_SEQUENCE
            tokens += rng.sample(PRODUCT_PRICE, k=rng.randint(1, 3))

    if rng.random() < 0.5:
        tokens += PRODUCT_ADD
        tokens += CART_TO_CHECKOUT
        if rng.random() < 0.6:
            tokens += CHECKOUT_SEQUENCE
    else:
        tokens += PRODUCT_EXIT

    return _noise(rng, tokens, prob=0.10)


def gen_review_focused(rng: random.Random) -> List[str]:
    """리뷰 중심형: 리뷰·상세 정보를 꼼꼼히 읽고 결정."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(2, 3))
    tokens += PRODUCT_ENTER
    tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(3, 5))
    tokens += rng.sample(PRODUCT_REVIEW, k=rng.randint(4, 7))
    tokens += rng.sample(PRODUCT_SIZE, k=rng.randint(1, 2))

    if rng.random() < 0.6:
        tokens += ["PRODUCT|CHECK_SHIPPING|DWELL_SHORT", "PRODUCT|CHECK_SHIPPING|DWELL_MEDIUM"]
    if rng.random() < 0.5:
        tokens += rng.sample(PRODUCT_REVIEW, k=rng.randint(2, 4))

    if rng.random() < 0.65:
        tokens += PRODUCT_ADD
        tokens += CART_TO_CHECKOUT
        if rng.random() < 0.7:
            tokens += CHECKOUT_SEQUENCE
    else:
        tokens += PRODUCT_EXIT

    return _noise(rng, tokens, prob=0.08)


def gen_impulsive(rng: random.Random) -> List[str]:
    """즉흥 구매형: 짧은 탐색 후 바로 구매."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 2))
    tokens += PRODUCT_ENTER
    tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(1, 3))
    tokens += PRODUCT_ADD
    tokens += CART_TO_CHECKOUT
    if rng.random() < 0.85:
        tokens += CHECKOUT_SEQUENCE

    return _noise(rng, tokens, prob=0.05)


def gen_distracted(rng: random.Random) -> List[str]:
    """산만 이탈형: INACTIVE / TAB_OUT 많고 조기 이탈."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 3))
    tokens.append(rng.choice(INACTIVE_TOKENS))

    if rng.random() < 0.5:
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(1, 3))
        tokens.append("PRODUCT|INACTIVE|NONE")
        if rng.random() < 0.6:
            tokens += TAB_SEQUENCE
        tokens += PRODUCT_EXIT
    else:
        tokens += HOME_EXIT

    return _noise(rng, tokens, prob=0.25)


def gen_comparison_heavy(rng: random.Random) -> List[str]:
    """다상품 비교형: 여러 상품 반복 탐색, HOVER 많음."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(2, 4))

    for i in range(rng.randint(2, 4)):
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(3, 6))
        if i > 0:
            tokens += rng.sample(PRODUCT_PRICE, k=rng.randint(1, 3))
        tokens += rng.sample(PRODUCT_REVIEW, k=rng.randint(1, 3))
        if i < 3 and rng.random() < 0.6:
            tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 2))

    if rng.random() < 0.45:
        tokens += PRODUCT_ADD
        tokens += CART_TO_CHECKOUT
        if rng.random() < 0.6:
            tokens += CHECKOUT_SEQUENCE
    else:
        tokens += PRODUCT_EXIT

    return _noise(rng, tokens, prob=0.12)


# ═══════════════════════════════════════════════════════════════════
# 신규 7개 페르소나
# ═══════════════════════════════════════════════════════════════════

def gen_bounce_visitor(rng: random.Random) -> List[str]:
    """즉시 이탈형: 홈 또는 상품 페이지 잠깐 보고 바로 이탈.
    짧은 세션, EXIT_BOUNCE 또는 EXIT_SESSION 위주."""
    tokens = list(SESSION_START)

    if rng.random() < 0.5:
        # 홈에서 바로 이탈
        tokens += rng.sample(HOME_BROWSE, k=rng.randint(0, 2))
        tokens += HOME_BOUNCE
    else:
        # 상품 한 개 보고 이탈
        tokens += rng.sample(HOME_BROWSE, k=rng.randint(0, 1))
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(1, 2))
        tokens += PRODUCT_BOUNCE

    return _noise(rng, tokens, prob=0.03)


def gen_wishlist_browser(rng: random.Random) -> List[str]:
    """긴 탐색·구매 의사 없음형: 여러 상품 깊게 보지만 장바구니 없음.
    VIEW_PRODUCT DWELL_LONG, SCROLL_HIGH, ZOOM_IMAGE 많음."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(2, 4))

    for _ in range(rng.randint(3, 6)):
        tokens += PRODUCT_ENTER
        # 상품을 오래, 깊게 봄
        tokens += [
            rng.choice(["PRODUCT|VIEW_PRODUCT|DWELL_LONG", "PRODUCT|VIEW_PRODUCT|DWELL_MEDIUM"]),
            rng.choice(["PRODUCT|SCROLL_PRODUCT|SCROLL_HIGH", "PRODUCT|SCROLL_PRODUCT|SCROLL_MID"]),
        ]
        tokens += rng.sample(PRODUCT_REVIEW, k=rng.randint(2, 4))
        tokens += rng.sample(PRODUCT_MEDIA, k=rng.randint(1, 3))
        # 사이즈 확인은 하지만 구매로 이어지지 않음
        if rng.random() < 0.4:
            tokens += rng.sample(PRODUCT_SIZE, k=rng.randint(1, 2))
        # 홈으로 돌아가서 다음 상품
        if rng.random() < 0.7:
            tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 2))

    # 절대 장바구니 안 담음
    tokens += PRODUCT_EXIT
    return _noise(rng, tokens, prob=0.08)


def gen_cart_abandoner(rng: random.Random) -> List[str]:
    """장바구니 포기형: ADD_CART까지 하지만 결제 포기.
    CART 페이지에서 REMOVE_CART 또는 탭 이탈."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 3))

    for _ in range(rng.randint(1, 2)):
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(2, 4))
        tokens += rng.sample(PRODUCT_PRICE, k=rng.randint(1, 3))
        tokens += PRODUCT_ADD

    # 장바구니 진입
    tokens += [
        "CART|ENTER_CART|NONE",
        "CART|CHECK_PRICE|DWELL_MEDIUM",
        "CART|CHECK_SHIPPING|DWELL_MEDIUM",
    ]
    tokens += rng.sample(CART_MODIFY, k=rng.randint(0, 2))

    # 포기 방식
    if rng.random() < 0.5:
        tokens += ["CART|TAB_OUT|NONE"]       # 탭 이탈
    elif rng.random() < 0.5:
        tokens += ["CART|REMOVE_CART|NONE", "CART|EXIT_SESSION|NONE"]  # 담은 거 빼고 이탈
    else:
        tokens += ["CART|INACTIVE|NONE", "CART|EXIT_SESSION|NONE"]     # 비활성 후 이탈

    return _noise(rng, tokens, prob=0.10)


def gen_size_obsessed(rng: random.Random) -> List[str]:
    """사이즈·옵션 집착형: CHECK_SIZE / CHANGE_OPTION 반복.
    결정 못 하고 옵션 계속 바꾸다가 이탈하거나 구매."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 2))

    for _ in range(rng.randint(1, 3)):
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(2, 3))
        # 사이즈 반복 확인 (핵심 패턴)
        for _ in range(rng.randint(3, 6)):
            tokens += rng.sample(PRODUCT_SIZE, k=rng.randint(2, 3))
        tokens += rng.sample(PRODUCT_REVIEW, k=rng.randint(1, 2))

    if rng.random() < 0.45:
        tokens += PRODUCT_ADD
        tokens += CART_TO_CHECKOUT
        if rng.random() < 0.5:
            tokens += CHECKOUT_SEQUENCE
    else:
        tokens += PRODUCT_EXIT

    return _noise(rng, tokens, prob=0.08)


def gen_search_driven(rng: random.Random) -> List[str]:
    """검색 중심형: SEARCH_USE → 카테고리 탐색 → 상품 진입 반복.
    CATEGORY 페이지 비중이 높음."""
    tokens = list(SESSION_START)

    # 검색으로 시작
    tokens += rng.sample(SEARCH_TOKENS, k=rng.randint(3, 5))

    for _ in range(rng.randint(2, 4)):
        # 카테고리 → 상품 진입
        tokens += rng.sample(CATEGORY_BROWSE, k=rng.randint(2, 4))
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(2, 4))
        tokens += rng.sample(PRODUCT_PRICE, k=rng.randint(1, 2))
        # 다시 검색
        if rng.random() < 0.6:
            tokens += rng.sample(SEARCH_TOKENS, k=rng.randint(1, 3))

    if rng.random() < 0.4:
        tokens += PRODUCT_ADD
        tokens += CART_TO_CHECKOUT
        if rng.random() < 0.55:
            tokens += CHECKOUT_SEQUENCE
    else:
        tokens += PRODUCT_EXIT

    return _noise(rng, tokens, prob=0.10)


def gen_media_explorer(rng: random.Random) -> List[str]:
    """이미지·영상 집중형: ZOOM_IMAGE / VIEW_IMAGE / WATCH_VIDEO 위주.
    비주얼로 상품을 판단하는 유형."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 3))

    for _ in range(rng.randint(2, 4)):
        tokens += PRODUCT_ENTER
        tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(1, 2))
        # 미디어 집중 (핵심 패턴)
        tokens += rng.choices(PRODUCT_MEDIA, k=rng.randint(4, 7))
        # 리뷰 이미지도 확인
        if rng.random() < 0.5:
            tokens += rng.sample(PRODUCT_REVIEW, k=rng.randint(1, 3))
        if rng.random() < 0.5:
            tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 2))

    if rng.random() < 0.40:
        tokens += PRODUCT_ADD
        tokens += CART_TO_CHECKOUT
        if rng.random() < 0.6:
            tokens += CHECKOUT_SEQUENCE
    else:
        tokens += PRODUCT_EXIT

    return _noise(rng, tokens, prob=0.08)


def gen_checkout_hesitant(rng: random.Random) -> List[str]:
    """결제 직전 망설임형: 결제 페이지에서 REMOVE_CART / 옵션 수정 반복.
    CHECKOUT + TAB_OUT + INACTIVE 패턴."""
    tokens = list(SESSION_START)
    tokens += rng.sample(HOME_BROWSE, k=rng.randint(1, 2))
    tokens += PRODUCT_ENTER
    tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(2, 4))
    tokens += rng.sample(PRODUCT_PRICE, k=rng.randint(2, 3))

    # 장바구니에 여러 개 담음
    for _ in range(rng.randint(1, 3)):
        tokens += PRODUCT_ADD
        if rng.random() < 0.3:
            tokens += PRODUCT_ENTER
            tokens += rng.sample(PRODUCT_BROWSE, k=rng.randint(1, 2))

    tokens += ["CART|ENTER_CART|NONE"]
    tokens += rng.sample(CART_MODIFY, k=rng.randint(1, 2))

    # 결제 페이지 진입 후 망설임 (핵심 패턴)
    tokens += rng.sample(CHECKOUT_HESITATE, k=rng.randint(4, 7))

    # 최종 결과: 30% 구매 완료, 70% 이탈
    if rng.random() < 0.30:
        tokens += ["CHECKOUT|EDIT_INPUT|NONE", "CHECKOUT|CLICK_BUY|NONE"]
    else:
        tokens += ["CHECKOUT|TAB_OUT|NONE", "CHECKOUT|EXIT_SESSION|NONE"]

    return _noise(rng, tokens, prob=0.12)


# ═══════════════════════════════════════════════════════════════════
# 페르소나 레지스트리 (이름: (생성함수, 비율))
# ═══════════════════════════════════════════════════════════════════

PERSONAS = {
    # 기존
    "price_sensitive":   (gen_price_sensitive,   0.10),
    "review_focused":    (gen_review_focused,     0.10),
    "impulsive":         (gen_impulsive,          0.08),
    "distracted":        (gen_distracted,         0.08),
    "comparison_heavy":  (gen_comparison_heavy,   0.08),
    # 신규
    "bounce_visitor":    (gen_bounce_visitor,     0.10),
    "wishlist_browser":  (gen_wishlist_browser,   0.10),
    "cart_abandoner":    (gen_cart_abandoner,     0.10),
    "size_obsessed":     (gen_size_obsessed,      0.08),
    "search_driven":     (gen_search_driven,      0.08),
    "media_explorer":    (gen_media_explorer,     0.06),
    "checkout_hesitant": (gen_checkout_hesitant,  0.04),
}


# ═══════════════════════════════════════════════════════════════════
# 생성 로직
# ═══════════════════════════════════════════════════════════════════

def generate_sessions(n: int, seed: int = 42) -> List[dict]:
    rng = random.Random(seed)
    persona_names   = list(PERSONAS.keys())
    persona_funcs   = [PERSONAS[p][0] for p in persona_names]
    persona_weights = [PERSONAS[p][1] for p in persona_names]

    sessions = []
    base_ts  = int(time.time() * 1000) - n * 60_000

    for i in range(n):
        persona_name = rng.choices(persona_names, weights=persona_weights, k=1)[0]
        tokens = PERSONAS[persona_name][0](rng)

        if len(tokens) < 3:
            continue

        start_ts = base_ts + i * rng.randint(30_000, 300_000)
        sessions.append({
            "session_id":      f"synth_{persona_name[:4]}_{uuid.uuid4().hex[:8]}",
            "start_timestamp": start_ts,
            "end_timestamp":   start_ts + len(tokens) * rng.randint(3_000, 8_000),
            "length":          len(tokens),
            "sequence":        " ".join(tokens),
            "persona":         persona_name,
        })

    return sessions


def save_sessions(sessions: List[dict], output_path: str, include_persona: bool = False):
    fields = ["session_id", "start_timestamp", "end_timestamp", "length", "sequence"]
    if include_persona:
        fields.append("persona")

    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sessions)
    print(f"[synthetic] 저장 완료 → {output_path}  ({len(sessions):,} 세션)")


def merge_with_real(real_csv: str, synthetic_csv: str, output_path: str):
    rows = []
    for path in [real_csv, synthetic_csv]:
        with open(path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                rows.append({k: row[k] for k in
                              ["session_id","start_timestamp","end_timestamp","length","sequence"]})
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f, fieldnames=["session_id","start_timestamp","end_timestamp","length","sequence"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"[synthetic] 병합 완료 → {output_path}  (총 {len(rows):,} 세션)")


# ═══════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--n",             type=int, default=2400)
    parser.add_argument("--seed",          type=int, default=42)
    parser.add_argument("--output",        default="output/synthetic_sessions.csv")
    parser.add_argument("--real_csv",      default="output/session_sequences_v2_merged.csv")
    parser.add_argument("--merged_output", default="output/session_sequences_augmented.csv")
    parser.add_argument("--include_persona", action="store_true")
    args = parser.parse_args()

    print("=" * 60)
    print("  GhostTracker 합성 세션 생성기  (v2 — 12 페르소나)")
    print("=" * 60)
    print(f"\n페르소나 분포 (총 {args.n}개):")
    for name, (_, w) in PERSONAS.items():
        tag = "★ 신규" if name in ("bounce_visitor","wishlist_browser","cart_abandoner",
                                    "size_obsessed","search_driven","media_explorer",
                                    "checkout_hesitant") else ""
        print(f"  {name:22s}: ~{int(args.n*w):4d}개 ({w*100:.0f}%)  {tag}")

    print(f"\n{args.n}개 생성 중 (seed={args.seed})…")
    t0 = time.time()
    sessions = generate_sessions(args.n, seed=args.seed)
    print(f"완료: {len(sessions):,}개  ({time.time()-t0:.2f}s)")

    from collections import Counter
    lengths = [int(s["length"]) for s in sessions]
    print(f"세션 길이  평균={sum(lengths)/len(lengths):.1f}  최소={min(lengths)}  최대={max(lengths)}")
    print("\n페르소나별 실제 생성 수:")
    for p, c in Counter(s["persona"] for s in sessions).most_common():
        print(f"  {p:22s}: {c}개")

    print()
    save_sessions(sessions, args.output, include_persona=args.include_persona)

    if os.path.exists(args.real_csv):
        merge_with_real(args.real_csv, args.output, args.merged_output)
    else:
        print(f"[warning] 실데이터 없음: {args.real_csv}")


if __name__ == "__main__":
    main()
