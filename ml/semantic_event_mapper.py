# event_type + data + 현재 page/section/subsection
# → PAGE|SEMANTIC|CONTEXTUAL 토큰으로 변환

# 예)
# scroll_depth=75
# + page=PRODUCT
# + subsection=review
# → PRODUCT|SCROLL_REVIEW|SCROLL_HIGH

"""
semantic_event_mapper.py

Raw SDK event를 PAGE|SEMANTIC|CONTEXTUAL 형태의 semantic token으로 변환한다.

예:
  review_scroll + pathname=/products/1 + depth_pct=82
  -> PRODUCT|SCROLL_REVIEW|SCROLL_HIGH

  subsection_dwell + subsection_id=shipping + dwell_ms=18000
  -> PRODUCT|CHECK_SHIPPING|DWELL_MEDIUM
"""

from __future__ import annotations

from typing import Any, Dict, Optional


Event = Dict[str, Any]


# =========================================================
# Bucket Rules
# =========================================================

def dwell_bucket(ms: Optional[float]) -> str:
    """체류 시간 bucket. 입력 단위: ms"""
    if ms is None:
        return "DWELL_UNKNOWN"

    sec = ms / 1000

    if 0 < sec <= 5:
        return "DWELL_SHORT"
    if sec <= 20:
        return "DWELL_MEDIUM"
    return "DWELL_LONG"


def scroll_bucket(depth_pct: Optional[float]) -> str:
    """스크롤 깊이 bucket. 입력 단위: percent"""
    if depth_pct is None:
        return "SCROLL_UNKNOWN"

    if 0 < depth_pct <= 30:
        return "SCROLL_LOW"
    if depth_pct <= 70:
        return "SCROLL_MID"
    return "SCROLL_HIGH"


def hover_bucket(ms: Optional[float]) -> str:
    """hover 시간 bucket. 입력 단위: ms"""
    if ms is None:
        return "HOVER_UNKNOWN"

    sec = ms / 1000

    if 0 < sec <= 5:
        return "HOVER_SHORT"
    return "HOVER_LONG"


def gap_bucket(ms: Optional[float]) -> str:
    """이전 이벤트와의 간격 bucket. 입력 단위: ms"""
    if ms is None:
        return "GAP_UNKNOWN"

    sec = ms / 1000

    if 0 < sec <= 3:
        return "GAP_SHORT"
    if sec <= 10:
        return "GAP_MEDIUM"
    return "GAP_LONG"


# =========================================================
# Basic Helpers
# =========================================================

def normalize_text(value: Any) -> str:
    if value is None:
        return ""

    return str(value).strip().lower()


def get_data(event: Event) -> Dict[str, Any]:
    data = event.get("data", {})
    return data if isinstance(data, dict) else {}


def safe_number(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


# =========================================================
# PAGE Inference
# =========================================================

def infer_page(event: Event) -> str:
    """
    pathname/page_url 기반 PAGE 추론.
    필요하면 프로젝트 쇼핑몰 URL 패턴에 맞게 계속 추가하면 됨.
    """
    pathname = normalize_text(event.get("pathname"))
    page_url = normalize_text(event.get("page_url"))
    path = pathname or page_url

    if not path:
        return "UNKNOWN"

    if path in ["/", "/home", "/main"]:
        return "HOME"

    if any(key in path for key in ["/category", "/categories", "/collections", "/collection"]):
        return "CATEGORY"

    if any(key in path for key in ["/product", "/products", "/item", "/items", "/goods", "/shop"]):
        return "PRODUCT"

    if any(key in path for key in ["/cart", "/basket", "/bag"]):
        return "CART"

    if any(key in path for key in ["/checkout", "/order", "/payment", "/pay"]):
        return "CHECKOUT"

    if any(key in path for key in ["/search"]):
        return "SEARCH"

    return "UNKNOWN"


# =========================================================
# Section/Subsection Semantic Inference
# =========================================================

REVIEW_KEYS = {"review", "reviews", "리뷰", "후기", "product_review", "user_review"}
SHIPPING_KEYS = {"shipping", "delivery", "배송", "배송정보", "delivery_info"}
SIZE_KEYS = {"size", "sizes", "사이즈", "size_chart", "option_size"}
PRICE_KEYS = {"price", "가격", "discount", "coupon", "benefit"}
IMAGE_KEYS = {"image", "images", "photo", "gallery", "thumbnail", "product_image"}
PRODUCT_DETAIL_KEYS = {"product", "detail", "description", "상품정보", "상세정보", "product_detail"}


def classify_area(section: Optional[str], subsection: Optional[str]) -> str:
    """
    section/subsection 문자열을 의미 영역으로 추론.
    """
    raw = normalize_text(subsection) or normalize_text(section)

    if not raw:
        return "UNKNOWN_AREA"

    for key in REVIEW_KEYS:
        if key in raw:
            return "REVIEW"

    for key in SHIPPING_KEYS:
        if key in raw:
            return "SHIPPING"

    for key in SIZE_KEYS:
        if key in raw:
            return "SIZE"

    for key in PRICE_KEYS:
        if key in raw:
            return "PRICE"

    for key in IMAGE_KEYS:
        if key in raw:
            return "IMAGE"

    for key in PRODUCT_DETAIL_KEYS:
        if key in raw:
            return "PRODUCT_DETAIL"

    return "UNKNOWN_AREA"


# =========================================================
# Target/Text Semantic Inference
# =========================================================

def infer_semantic_from_text(text: str) -> Optional[str]:
    """
    click_text, hover_text, target label 등을 이용한 semantic 추론.
    너무 공격적으로 하면 오탐이 늘어서 핵심 키워드만 사용.
    """
    t = normalize_text(text)

    if not t:
        return None

    if any(key in t for key in ["리뷰", "후기", "review"]):
        return "VIEW_REVIEW"

    if any(key in t for key in ["배송", "delivery", "shipping"]):
        return "CHECK_SHIPPING"

    if any(key in t for key in ["사이즈", "size"]):
        return "CHECK_SIZE"

    if any(key in t for key in ["가격", "price", "할인", "쿠폰", "discount", "coupon"]):
        return "CHECK_PRICE"

    if any(key in t for key in ["장바구니", "cart", "bag", "basket", "담기"]):
        return "ADD_CART"

    if any(key in t for key in ["구매", "결제", "buy", "checkout", "purchase"]):
        return "CLICK_BUY"

    return None


# =========================================================
# Main Mapper
# =========================================================

def map_event_to_semantic_token(
    event: Event,
    *,
    current_page: Optional[str] = None,
    current_section: Optional[str] = None,
    current_subsection: Optional[str] = None,
) -> Optional[str]:
    """
    단일 raw event + 현재 세션 맥락을 PAGE|SEMANTIC|CONTEXTUAL로 변환.

    current_section/current_subsection은 build_session_sequences.py가
    세션을 시간순으로 읽으면서 유지해 전달한다.
    """
    event_type = event.get("event_type")
    data = get_data(event)

    page = current_page or infer_page(event)
    area = classify_area(current_section, current_subsection)

    # -----------------------------------------------------
    # Session / Page
    # -----------------------------------------------------
    if event_type == "session_start":
        return f"{page}|START_SESSION|NONE"

    if event_type == "session_end":
        if data.get("bounce_flag") is True:
            return f"{page}|EXIT_BOUNCE|NONE"
        return f"{page}|EXIT_SESSION|NONE"

    if event_type == "navigation":
        target_page = infer_page(event)
        return f"{target_page}|ENTER_{target_page}|NONE"

    # -----------------------------------------------------
    # Scroll
    # -----------------------------------------------------
    if event_type in {"scroll_depth", "scroll_milestone"}:
        depth = safe_number(data.get("depth_pct") or data.get("milestone"))
        bucket = scroll_bucket(depth)

        if area == "REVIEW":
            return f"{page}|SCROLL_REVIEW|{bucket}"

        if area == "PRODUCT_DETAIL" or page == "PRODUCT":
            return f"{page}|SCROLL_PRODUCT|{bucket}"

        if page == "HOME":
            return f"{page}|SCROLL_HOME|{bucket}"

        if page == "CATEGORY":
            return f"{page}|SCROLL_CATEGORY|{bucket}"

        return f"{page}|SCROLL_PAGE|{bucket}"

    if event_type in {"review_scroll", "review_area_scroll"}:
        depth = safe_number(data.get("depth_pct"))
        return f"{page}|SCROLL_REVIEW|{scroll_bucket(depth)}"

    # -----------------------------------------------------
    # Subsection dwell
    # -----------------------------------------------------
    if event_type == "subsection_dwell":
        subsection_id = (
            data.get("subsection_id")
            or data.get("subsection")
            or current_subsection
        )
        dwell_ms = safe_number(data.get("dwell_ms") or data.get("dwell_time_ms"))
        subsection_area = classify_area(current_section, subsection_id)
        bucket = dwell_bucket(dwell_ms)

        if subsection_area == "REVIEW":
            return f"{page}|VIEW_REVIEW|{bucket}"

        if subsection_area == "SHIPPING":
            return f"{page}|CHECK_SHIPPING|{bucket}"

        if subsection_area == "SIZE":
            return f"{page}|CHECK_SIZE|{bucket}"

        if subsection_area == "PRICE":
            return f"{page}|CHECK_PRICE|{bucket}"

        if subsection_area == "IMAGE":
            return f"{page}|VIEW_IMAGE|{bucket}"

        if subsection_area == "PRODUCT_DETAIL":
            return f"{page}|VIEW_PRODUCT|{bucket}"

        return f"{page}|VIEW_SECTION|{bucket}"

    # -----------------------------------------------------
    # Review
    # -----------------------------------------------------
    if event_type == "review_click":
        return f"{page}|VIEW_REVIEW|CLICK"

    if event_type == "review_page_change":
        direction = normalize_text(data.get("direction")) or "PAGE_CHANGE"
        return f"{page}|EXPAND_REVIEW|{direction.upper()}"

    if event_type == "review_image_click":
        return f"{page}|VIEW_REVIEW_IMAGE|CLICK"

    # -----------------------------------------------------
    # Product / Ecommerce
    # -----------------------------------------------------
    if event_type == "product_click":
        return f"{page}|VIEW_PRODUCT|CLICK"

    if event_type == "add_to_cart":
        return f"{page}|ADD_CART|CLICK"

    if event_type == "remove_from_cart":
        return f"{page}|REMOVE_CART|CLICK"

    if event_type == "purchase_click":
        return f"{page}|CLICK_BUY|CLICK"

    if event_type == "option_select":
        return f"{page}|CHECK_SIZE|SELECT"

    if event_type == "option_change":
        count = safe_number(data.get("change_count"), 1)
        contextual = "CHANGE_MULTI" if count and count >= 2 else "CHANGE_ONCE"
        return f"{page}|CHANGE_OPTION|{contextual}"

    if event_type == "quantity_change":
        return f"{page}|CHANGE_QUANTITY|CHANGE"

    # -----------------------------------------------------
    # Image / Video
    # -----------------------------------------------------
    if event_type == "image_zoom":
        return f"{page}|ZOOM_IMAGE|ZOOM"

    if event_type == "image_slide":
        direction = normalize_text(data.get("direction")).upper() or "SLIDE"
        return f"{page}|VIEW_IMAGE|{direction}"

    if event_type == "video_play":
        return f"{page}|WATCH_VIDEO|PLAY"

    if event_type == "video_watch_pct":
        pct = safe_number(data.get("watch_pct"), 0)
        contextual = f"WATCH_{int(pct)}PCT" if pct is not None else "WATCH_PROGRESS"
        return f"{page}|WATCH_VIDEO|{contextual}"

    # -----------------------------------------------------
    # Search / Form
    # -----------------------------------------------------
    if event_type == "search_use":
        return f"{page}|SEARCH_USE|INPUT"

    if event_type == "field_focus":
        return f"{page}|START_INPUT|FOCUS"

    if event_type == "input_change":
        return f"{page}|EDIT_INPUT|CHANGE"

    if event_type == "field_blur":
        return f"{page}|EDIT_INPUT|BLUR"

    if event_type == "input_abandon":
        return f"{page}|ABANDON_INPUT|EMPTY"

    if event_type == "paste_event":
        return f"{page}|EDIT_INPUT|PASTE"

    # -----------------------------------------------------
    # Hover / Click
    # -----------------------------------------------------
    if event_type == "hover_dwell":
        hover_ms = safe_number(data.get("hover_dwell_time_ms"))
        bucket = hover_bucket(hover_ms)

        semantic_from_text = infer_semantic_from_text(
            data.get("hover_text") or data.get("hover_target") or ""
        )

        if semantic_from_text:
            return f"{page}|{semantic_from_text}|{bucket}"

        if area == "REVIEW":
            return f"{page}|VIEW_REVIEW|{bucket}"

        if area == "SHIPPING":
            return f"{page}|CHECK_SHIPPING|{bucket}"

        if area == "SIZE":
            return f"{page}|CHECK_SIZE|{bucket}"

        if area == "PRICE":
            return f"{page}|CHECK_PRICE|{bucket}"

        return f"{page}|HOVER_ELEMENT|{bucket}"

    if event_type == "click":
        semantic_from_text = infer_semantic_from_text(
            data.get("click_text") or data.get("click_target") or ""
        )

        if semantic_from_text:
            return f"{page}|{semantic_from_text}|CLICK"

        if area == "REVIEW":
            return f"{page}|VIEW_REVIEW|CLICK"

        if area == "SHIPPING":
            return f"{page}|CHECK_SHIPPING|CLICK"

        if area == "SIZE":
            return f"{page}|CHECK_SIZE|CLICK"

        if area == "PRICE":
            return f"{page}|CHECK_PRICE|CLICK"

        return f"{page}|CLICK_ELEMENT|CLICK"

    if event_type == "rage_click":
        return f"{page}|RAGE_CLICK|REPEAT"

    # -----------------------------------------------------
    # Tab / Inactivity / Risk
    # -----------------------------------------------------
    if event_type == "tab_exit":
        return f"{page}|TAB_OUT|NONE"

    if event_type == "tab_return":
        duration_ms = safe_number(data.get("tab_exit_duration_ms"))
        return f"{page}|TAB_RETURN|{gap_bucket(duration_ms)}"

    if event_type == "inactivity":
        duration_ms = safe_number(data.get("inactivity_duration"))
        return f"{page}|INACTIVE|{gap_bucket(duration_ms)}"

    if event_type == "cart_abandon_flag":
        return f"{page}|CART_ABANDON|RISK"

    # -----------------------------------------------------
    # Unknown / ignored
    # -----------------------------------------------------
    return None