# event_type + data + 현재 page/section/subsection
# → PAGE|SEMANTIC|CONTEXTUAL 토큰으로 변환

"""
semantic_event_mapper.py  (v2 — 스펙 확정판)
---------------------------------------------
Raw SDK event → PAGE|SEMANTIC|CONTEXTUAL 형태의 semantic token 변환.

[contextual token 적용 원칙]
  contextual token (dwell / scroll / hover / revisit)은
  의미 차이가 명확한 7개 semantic action에만 붙인다.

    ┌──────────────────┬─────────────────────────────────────────┐
    │ Semantic         │ Contextual                               │
    ├──────────────────┼─────────────────────────────────────────┤
    │ VIEW_PRODUCT     │ DWELL_SHORT / DWELL_MEDIUM / DWELL_LONG │
    │                  │ REVISIT_ONCE / REVISIT_MULTI            │
    │ SCROLL_PRODUCT   │ SCROLL_LOW / SCROLL_MID / SCROLL_HIGH   │
    │ VIEW_REVIEW      │ DWELL_SHORT / DWELL_MEDIUM / DWELL_LONG │
    │                  │ REVISIT_ONCE / REVISIT_MULTI            │
    │ SCROLL_REVIEW    │ SCROLL_LOW / SCROLL_MID / SCROLL_HIGH   │
    │ CHECK_SHIPPING   │ DWELL_SHORT / DWELL_MEDIUM / DWELL_LONG │
    │ CHECK_SIZE       │ DWELL_SHORT / DWELL_MEDIUM / DWELL_LONG │
    │                  │ HOVER_SHORT / HOVER_LONG                │
    │ CHECK_PRICE      │ DWELL_SHORT / DWELL_MEDIUM / DWELL_LONG │
    └──────────────────┴─────────────────────────────────────────┘

  그 외 모든 semantic token → CONTEXTUAL = NONE

[bucket 기준]
  dwell   SHORT ≤ 5s < MEDIUM ≤ 20s < LONG
  scroll  LOW ≤ 30% < MID ≤ 70% < HIGH
  hover   SHORT ≤ 5s < LONG
  gap     SHORT ≤ 3s < MEDIUM ≤ 10s < LONG   (TAB_RETURN / INACTIVE용)

[현재 수집 이벤트 — 44개]
  세션/페이지  : session_start, session_end, navigation, bounce
  클릭         : click, rage_click
  마우스/호버  : mouse_move(*skip), hover_dwell
  탭           : tab_exit, tab_return
  폼/입력      : input_change, field_focus, field_blur,
                 input_abandon, paste_event, search_use
  미디어       : image_slide, image_zoom, video_play, video_watch_pct
  스크롤       : scroll_depth, scroll_milestone, scroll_stop(*skip),
                 scroll_direction_change(*skip), scroll_speed(*skip)
  섹션         : section_enter, section_exit(*skip), section_revisit,
                 section_transition(*skip), subsection_enter,
                 subsection_exit(*skip), subsection_revisit
  이커머스     : product_click, option_select, add_to_cart,
                 remove_from_cart, purchase_click, cart_abandon_flag,
                 quantity_change, option_change
  리뷰         : review_click, review_page_change,
                 review_image_click, review_scroll, review_area_scroll
  A파생/전용   : inactivity, time_to_first_click(*skip),
                 subsection_dwell, screen_resize(*skip)
"""

from __future__ import annotations

from typing import Any, Dict, Optional


Event = Dict[str, Any]


# =========================================================
# Bucket Rules
# =========================================================

def dwell_bucket(ms: Optional[float]) -> str:
    """체류 시간 bucket. 입력: ms"""
    if ms is None:
        return "DWELL_MEDIUM"   # 알 수 없으면 중간값
    sec = ms / 1000
    if sec <= 5:
        return "DWELL_SHORT"
    if sec <= 20:
        return "DWELL_MEDIUM"
    return "DWELL_LONG"


def scroll_bucket(depth_pct: Optional[float]) -> str:
    """스크롤 깊이 bucket. 입력: percent"""
    if depth_pct is None:
        return "SCROLL_MID"
    if depth_pct <= 30:
        return "SCROLL_LOW"
    if depth_pct <= 70:
        return "SCROLL_MID"
    return "SCROLL_HIGH"


def hover_bucket(ms: Optional[float]) -> str:
    """hover 체류 시간 bucket. 입력: ms"""
    if ms is None:
        return "HOVER_SHORT"
    sec = ms / 1000
    if sec <= 5:
        return "HOVER_SHORT"
    return "HOVER_LONG"


def revisit_bucket(count: Optional[int]) -> str:
    """재방문 횟수 bucket"""
    if count is None or count <= 1:
        return "REVISIT_ONCE"
    return "REVISIT_MULTI"


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
    """pathname / page_url 기반 PAGE 추론."""
    pathname = normalize_text(event.get("pathname"))
    page_url = normalize_text(event.get("page_url"))
    raw = pathname or page_url

    if not raw:
        return "UNKNOWN"

    if "://" in raw:
        try:
            from urllib.parse import urlparse
            parsed = urlparse(raw)
            path = parsed.path.rstrip("/") or "/"
            query = parsed.query
        except Exception:
            path = raw
            query = ""
    else:
        path = raw.split("?")[0].rstrip("/") or "/"
        query = raw[len(path):]

    if path in ("", "/", "/home", "/main"):
        return "HOME"

    if any(k in path for k in ("/checkout", "/order", "/payment", "/pay", "/결제", "/주문")):
        return "CHECKOUT"

    if any(k in path for k in ("/cart", "/basket", "/bag", "/장바구니")):
        return "CART"

    if any(k in path for k in ("/product", "/products", "/item", "/items",
                                "/goods", "/shop", "/상품", "/detail")):
        return "PRODUCT"

    if any(k in query for k in ("product_id=", "item_id=", "goods_id=")):
        return "PRODUCT"

    if any(k in path for k in ("/category", "/categories", "/collections",
                                "/collection", "/search", "/카테고리")):
        return "CATEGORY"

    if any(k in path for k in ("/review", "/reviews", "/후기", "/리뷰")):
        return "REVIEW"

    return "UNKNOWN"


# =========================================================
# Area Inference  (section/subsection → 의미 영역)
# =========================================================

REVIEW_KEYS         = {"review", "reviews", "리뷰", "후기", "product_review", "user_review"}
SHIPPING_KEYS       = {"shipping", "delivery", "배송", "배송정보", "delivery_info"}
SIZE_KEYS           = {"size", "sizes", "사이즈", "size_chart", "option_size"}
PRICE_KEYS          = {"price", "가격", "discount", "coupon", "benefit", "할인"}
IMAGE_KEYS          = {"image", "images", "photo", "gallery", "thumbnail", "product_image"}
PRODUCT_DETAIL_KEYS = {"product", "detail", "description", "상품정보", "상세정보", "product_detail"}


def classify_area(section: Optional[str], subsection: Optional[str]) -> str:
    """section/subsection 문자열을 의미 영역으로 분류."""
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
# Text → Semantic Inference  (click/hover 텍스트 활용)
# =========================================================

def infer_semantic_from_text(text: str) -> Optional[str]:
    """click_text / hover_text에서 semantic action 추론. 핵심 키워드만."""
    t = normalize_text(text)
    if not t:
        return None

    if any(k in t for k in ("리뷰", "후기", "review")):
        return "VIEW_REVIEW"
    if any(k in t for k in ("배송", "delivery", "shipping")):
        return "CHECK_SHIPPING"
    if any(k in t for k in ("사이즈", "size")):
        return "CHECK_SIZE"
    if any(k in t for k in ("가격", "price", "할인", "쿠폰", "discount", "coupon")):
        return "CHECK_PRICE"
    if any(k in t for k in ("장바구니", "cart", "bag", "basket", "담기")):
        return "ADD_CART"
    if any(k in t for k in ("구매", "결제", "buy", "checkout", "purchase")):
        return "CLICK_BUY"

    return None


# =========================================================
# Token Factory
# =========================================================

# contextual token을 허용하는 semantic action (7개)
_CONTEXTUAL_SEMANTICS = frozenset({
    "VIEW_PRODUCT",   "SCROLL_PRODUCT",
    "VIEW_REVIEW",    "SCROLL_REVIEW",
    "CHECK_SHIPPING", "CHECK_SIZE", "CHECK_PRICE",
})


def make_token(page: str, semantic: str, contextual: str = "NONE") -> str:
    """
    PAGE|SEMANTIC|CONTEXTUAL 토큰 생성.
    허가된 semantic에만 contextual을 붙이고, 나머지는 NONE으로 강제.
    """
    if semantic not in _CONTEXTUAL_SEMANTICS:
        contextual = "NONE"
    return f"{page}|{semantic}|{contextual}"


# =========================================================
# Page-forcing Helper
# =========================================================

_FORCE_PRODUCT_EVENTS = frozenset({
    "product_click", "add_to_cart", "remove_from_cart",
    "purchase_click", "option_select", "option_change", "quantity_change",
    "review_click", "review_page_change", "review_image_click",
    "review_scroll", "review_area_scroll",
    "image_zoom", "image_slide", "video_play", "video_watch_pct",
    "cart_abandon_flag",
})

_FORCE_PRODUCT_AREAS = frozenset({
    "REVIEW", "SHIPPING", "SIZE", "PRICE", "IMAGE", "PRODUCT_DETAIL",
})


def resolve_page(page: str, event_type: str, area: str) -> str:
    """HOME 페이지에서 상품 관련 이벤트가 오면 PRODUCT로 교정."""
    if page == "HOME" and (
        event_type in _FORCE_PRODUCT_EVENTS or area in _FORCE_PRODUCT_AREAS
    ):
        return "PRODUCT"
    return page


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
    단일 raw event + 현재 세션 맥락 → PAGE|SEMANTIC|CONTEXTUAL 토큰.
    None 반환 시 해당 이벤트는 시퀀스에서 제외된다.
    """
    event_type = event.get("event_type", "")
    data = get_data(event)

    page = current_page or infer_page(event)
    area = classify_area(current_section, current_subsection)
    page = resolve_page(page, event_type, area)

    # ── 1. 세션 / 페이지 이동 ──────────────────────────────────────────

    if event_type == "session_start":
        return make_token(page, "START_SESSION")

    if event_type in ("session_end", "bounce"):
        if data.get("bounce_flag") is True or event_type == "bounce":
            return make_token(page, "EXIT_BOUNCE")
        return make_token(page, "EXIT_SESSION")

    if event_type == "navigation":
        target_page = infer_page(event)
        _nav_map = {
            "HOME":     "ENTER_HOME",
            "PRODUCT":  "ENTER_PRODUCT",
            "CART":     "ENTER_CART",
            "CATEGORY": "ENTER_CATEGORY",
            "CHECKOUT": "ENTER_CHECKOUT",
        }
        semantic = _nav_map.get(target_page, f"ENTER_{target_page}")
        return make_token(target_page, semantic)

    # ── 2. 이커머스 ────────────────────────────────────────────────────

    if event_type == "add_to_cart":
        return make_token(page, "ADD_CART")

    if event_type == "remove_from_cart":
        return make_token(page, "REMOVE_CART")

    if event_type == "purchase_click":
        return make_token(page, "CLICK_BUY")

    if event_type == "cart_abandon_flag":
        return make_token(page, "CART_ABANDON")

    if event_type == "product_click":
        # 맥락 없는 상품 클릭 → NONE
        return make_token(page, "VIEW_PRODUCT", "NONE")

    if event_type == "option_select":
        # 사이즈/옵션 선택 = CHECK_SIZE 범주 (contextual은 dwell/hover로만)
        return make_token(page, "CHECK_SIZE", "NONE")

    if event_type == "option_change":
        return make_token(page, "CHANGE_OPTION")

    if event_type == "quantity_change":
        return make_token(page, "CHANGE_QUANTITY")

    # ── 3. 리뷰 전용 이벤트 ────────────────────────────────────────────

    if event_type == "review_click":
        return make_token(page, "VIEW_REVIEW", "NONE")

    if event_type == "review_image_click":
        return make_token(page, "VIEW_REVIEW", "NONE")

    if event_type == "review_page_change":
        return make_token(page, "EXPAND_REVIEW")

    if event_type in ("review_scroll", "review_area_scroll"):
        depth = safe_number(
            data.get("depth_pct") or data.get("scroll_depth_pct")
        )
        return make_token(page, "SCROLL_REVIEW", scroll_bucket(depth))

    # ── 4. 스크롤 ──────────────────────────────────────────────────────

    if event_type in ("scroll_depth", "scroll_milestone"):
        depth = safe_number(
            data.get("depth_pct")
            or data.get("milestone")
            or data.get("scroll_depth_pct")
            or data.get("max_scroll_depth")
        )
        bucket = scroll_bucket(depth)

        # ── intent 영역 우선 매핑 (generic SCROLL_PRODUCT보다 먼저) ────────
        # 리뷰 섹션 → SCROLL_REVIEW
        if area == "REVIEW":
            return make_token(page, "SCROLL_REVIEW", bucket)

        # 가격 섹션 스크롤 → CHECK_PRICE (scroll bucket 재활용)
        if area == "PRICE":
            return make_token(page, "CHECK_PRICE", bucket)

        # 사이즈 섹션 스크롤 → CHECK_SIZE (scroll bucket 재활용)
        if area == "SIZE":
            return make_token(page, "CHECK_SIZE", bucket)

        # 배송 섹션 스크롤 → CHECK_SHIPPING
        if area == "SHIPPING":
            return make_token(page, "CHECK_SHIPPING", "NONE")

        # 상품 페이지 / 상세 섹션 → SCROLL_PRODUCT
        if page == "PRODUCT" or area in ("PRODUCT_DETAIL", "IMAGE"):
            return make_token(page, "SCROLL_PRODUCT", bucket)

        # 그 외 → contextual NONE
        _page_scroll = {
            "HOME":     "SCROLL_HOME",
            "CATEGORY": "SCROLL_CATEGORY",
        }
        semantic = _page_scroll.get(page, "SCROLL_PAGE")
        return make_token(page, semantic)

    # scroll_stop / scroll_direction_change / scroll_speed → skip
    if event_type in ("scroll_stop", "scroll_direction_change", "scroll_speed"):
        return None

    # ── 5. Subsection dwell  (핵심 contextual 이벤트) ──────────────────

    if event_type == "subsection_dwell":
        subsection_id = (
            data.get("subsection_id")
            or data.get("subsection")
            or current_subsection
        )
        dwell_ms = safe_number(
            data.get("dwell_ms") or data.get("dwell_time_ms")
        )
        sub_area = classify_area(current_section, subsection_id)
        bucket   = dwell_bucket(dwell_ms)

        _area_map = {
            "REVIEW":         "VIEW_REVIEW",
            "SHIPPING":       "CHECK_SHIPPING",
            "SIZE":           "CHECK_SIZE",
            "PRICE":          "CHECK_PRICE",
            "IMAGE":          "VIEW_PRODUCT",
            "PRODUCT_DETAIL": "VIEW_PRODUCT",
        }
        semantic = _area_map.get(sub_area)
        if semantic:
            return make_token(page, semantic, bucket)

        return make_token(page, "VIEW_SECTION")

    # ── 6. 섹션 enter / revisit ────────────────────────────────────────

    if event_type in ("section_enter", "subsection_enter"):
        _area_map = {
            "REVIEW":         "VIEW_REVIEW",
            "SHIPPING":       "CHECK_SHIPPING",
            "SIZE":           "CHECK_SIZE",
            "PRICE":          "CHECK_PRICE",
            "IMAGE":          "VIEW_IMAGE",
            "PRODUCT_DETAIL": "VIEW_PRODUCT",
        }
        semantic = _area_map.get(area)
        if semantic:
            return make_token(page, semantic, "NONE")
        # 의미 불명확 → skip
        return None

    if event_type in ("section_revisit", "subsection_revisit"):
        count     = int(safe_number(data.get("revisit_count"), 1))
        rev_ctx   = revisit_bucket(count)

        if area == "REVIEW":
            return make_token(page, "VIEW_REVIEW", rev_ctx)
        if area in ("PRODUCT_DETAIL", "IMAGE"):
            return make_token(page, "VIEW_PRODUCT", rev_ctx)
        # 그 외 재방문 → skip
        return None

    # section_exit / section_transition / subsection_exit → skip
    if event_type in ("section_exit", "section_transition", "subsection_exit"):
        return None

    # ── 7. 미디어 ──────────────────────────────────────────────────────

    if event_type == "image_zoom":
        return make_token(page, "ZOOM_IMAGE")

    if event_type == "image_slide":
        return make_token(page, "VIEW_IMAGE")

    if event_type in ("video_play", "video_watch_pct"):
        return make_token(page, "WATCH_VIDEO")

    # ── 8. 검색 / 폼 / 입력 ────────────────────────────────────────────

    if event_type == "search_use":
        return make_token(page, "SEARCH_USE")

    if event_type == "field_focus":
        return make_token(page, "START_INPUT")

    if event_type in ("input_change", "field_blur", "paste_event"):
        return make_token(page, "EDIT_INPUT")

    if event_type == "input_abandon":
        return make_token(page, "ABANDON_INPUT")

    # ── 9. 호버 ────────────────────────────────────────────────────────

    if event_type == "hover":
        # dwell 시간 없는 일반 hover — section/area 기반 우선 매핑
        semantic_from_text = infer_semantic_from_text(
            data.get("hover_text") or data.get("hover_target") or ""
        )
        if semantic_from_text:
            return make_token(page, semantic_from_text, "NONE")

        # 이벤트 payload의 section 필드 직접 확인 (context 추적보다 직접적 신호)
        event_section = normalize_text(data.get("section") or data.get("element_section") or "")
        if event_section:
            for key in PRICE_KEYS:
                if key in event_section:
                    return make_token(page, "CHECK_PRICE", "NONE")
            for key in REVIEW_KEYS:
                if key in event_section:
                    return make_token(page, "VIEW_REVIEW", "NONE")
            for key in SHIPPING_KEYS:
                if key in event_section:
                    return make_token(page, "CHECK_SHIPPING", "NONE")
            for key in SIZE_KEYS:
                if key in event_section:
                    return make_token(page, "CHECK_SIZE", "NONE")

        # 영역 context 기반 매핑
        _hover_area_map = {
            "REVIEW":   "VIEW_REVIEW",
            "SHIPPING": "CHECK_SHIPPING",
            "SIZE":     "CHECK_SIZE",
            "PRICE":    "CHECK_PRICE",
        }
        semantic = _hover_area_map.get(area)
        if semantic:
            return make_token(page, semantic, "NONE")

        return make_token(page, "HOVER_ELEMENT")

    if event_type == "hover_dwell":
        hover_ms = safe_number(data.get("hover_dwell_time_ms"))
        h_bucket = hover_bucket(hover_ms)
        # hover_ms를 dwell bucket으로도 변환 (PRICE/SHIPPING/REVIEW 등에 사용)
        d_bucket = dwell_bucket(hover_ms)

        # 텍스트 기반 추론 (area보다 먼저: 더 직접적인 신호)
        semantic_from_text = infer_semantic_from_text(
            data.get("hover_text") or data.get("hover_target") or ""
        )

        # CHECK_SIZE: hover contextual 허용
        if semantic_from_text == "CHECK_SIZE" or area == "SIZE":
            return make_token(page, "CHECK_SIZE", h_bucket)

        # 텍스트로 intent 확인됐으나 area가 다른 경우 → dwell bucket 적용
        if semantic_from_text:
            if semantic_from_text == "CHECK_PRICE":
                return make_token(page, "CHECK_PRICE", d_bucket)
            if semantic_from_text == "CHECK_SHIPPING":
                return make_token(page, "CHECK_SHIPPING", d_bucket)
            if semantic_from_text == "VIEW_REVIEW":
                return make_token(page, "VIEW_REVIEW", d_bucket)
            return make_token(page, semantic_from_text, "NONE")

        # ── 영역 기반 매핑: NONE → dwell bucket으로 교체 ──────────────────
        # generic HOVER_ELEMENT보다 section이 더 직접적인 신호
        if area == "PRICE":
            return make_token(page, "CHECK_PRICE", d_bucket)
        if area == "SHIPPING":
            return make_token(page, "CHECK_SHIPPING", d_bucket)
        if area == "REVIEW":
            return make_token(page, "VIEW_REVIEW", d_bucket)

        return make_token(page, "HOVER_ELEMENT")

    # ── 10. 클릭 ───────────────────────────────────────────────────────

    if event_type == "click":
        semantic_from_text = infer_semantic_from_text(
            data.get("click_text") or data.get("click_target") or ""
        )
        if semantic_from_text:
            return make_token(page, semantic_from_text, "NONE")

        # 이벤트 payload의 section 필드 직접 확인 (context 추적보다 직접적 신호)
        event_section = normalize_text(data.get("section") or data.get("element_section") or "")
        if event_section:
            for key in PRICE_KEYS:
                if key in event_section:
                    return make_token(page, "CHECK_PRICE", "NONE")
            for key in REVIEW_KEYS:
                if key in event_section:
                    return make_token(page, "VIEW_REVIEW", "NONE")
            for key in SHIPPING_KEYS:
                if key in event_section:
                    return make_token(page, "CHECK_SHIPPING", "NONE")
            for key in SIZE_KEYS:
                if key in event_section:
                    return make_token(page, "CHECK_SIZE", "NONE")

        # 영역 context 기반 매핑
        _area_map = {
            "REVIEW":   "VIEW_REVIEW",
            "SHIPPING": "CHECK_SHIPPING",
            "SIZE":     "CHECK_SIZE",
            "PRICE":    "CHECK_PRICE",
        }
        semantic = _area_map.get(area)
        if semantic:
            return make_token(page, semantic, "NONE")

        return make_token(page, "CLICK_ELEMENT")

    if event_type == "rage_click":
        return make_token(page, "RAGE_CLICK")

    # ── 11. 탭 / 비활동 ────────────────────────────────────────────────

    if event_type == "tab_exit":
        return make_token(page, "TAB_OUT")

    if event_type == "tab_return":
        return make_token(page, "TAB_RETURN")

    if event_type == "inactivity":
        return make_token(page, "INACTIVE")

    # ── 12. skip 이벤트 ────────────────────────────────────────────────

    if event_type in ("mouse_move", "time_to_first_click", "screen_resize"):
        return None

    # ── 13. Fallback ───────────────────────────────────────────────────

    return None
