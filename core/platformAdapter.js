/**
 * platformAdapter.js — Layer 0 플랫폼 어댑터
 *
 * 역할: 쇼핑몰 솔루션이 표준으로 노출하는 메타데이터를 읽어
 *      페이지 타입과 상품 정보를 "추론"이 아니라 "확정값"으로 얻는다.
 *
 * ── 감지 계층 구조 ──────────────────────────────────────────────
 *   Layer 0  플랫폼 어댑터 (이 파일)        ← 확정값. 스킨이 바뀌어도 안 깨짐
 *   Layer 1  data-ghost-role 명시 마킹      ← 우리가 심은 마킹
 *   Layer 2  휴리스틱 추론 (텍스트/클래스)  ← 마지막 fallback
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────
 *  Cafe24 실측 결과, 휴리스틱만으로는 상품 ID를 제대로 못 잡았다.
 *
 *  상품 상세 경로: /product/레이스-디테일-미디-원피스/45/category/1/display/6/
 *  브라우저의 pathname은 퍼센트 인코딩된 상태라, sdk-C의 정규식이 뽑아내는 값은
 *    "%EB%A0%88%EC%9D%B4%EC%8A%A4-%EB%94%94%ED%85%8C%EC%9D%BC-..."
 *  진짜 상품번호 45는 바로 다음 세그먼트에 있는데 못 잡는다.
 *  fallback인 params.get('product_id')도 Cafe24는 파라미터명이 product_no라 null이다.
 *
 *  그런데 Cafe24는 head에 표준 메타를 내보낸다:
 *    <meta name="path_role" content="PRODUCT_DETAIL">
 *    <meta property="product:productId" content="45">
 *    <meta name="design_html_path" content="/product/detail.html">
 *
 *  URL을 추론할 이유가 없다. 플랫폼이 정답을 알려준다.
 *
 * ── 확장 ───────────────────────────────────────────────────────
 *  ADAPTERS 배열에 { name, detect, resolve }를 추가하면 다른 솔루션도 붙는다.
 *  어느 것도 감지되지 않으면 null을 반환하고, sdk-C는 기존 Layer 1/2로 동작한다.
 *  즉 Cafe24가 아닌 사이트의 동작은 전혀 바뀌지 않는다.
 * ────────────────────────────────────────────────────────────────
 */

// 우리 시스템이 쓰는 페이지 타입.
// ml/semantic_event_mapper.py의 PAGE 어휘와 맞춰야 한다 (4단계에서 정식 반영).
const PAGE = Object.freeze({
  HOME:          'HOME',
  PRODUCT:       'PRODUCT',
  CATEGORY:      'CATEGORY',
  SEARCH:        'SEARCH',
  CART:          'CART',
  CHECKOUT:      'CHECKOUT',
  ORDER_SUCCESS: 'ORDER_SUCCESS',   // 신설 — 전환 판정의 기준점
  REVIEW:        'REVIEW',
  BOARD:         'BOARD',
  MYPAGE:        'MYPAGE',
  MEMBER:        'MEMBER',
  UNKNOWN:       'UNKNOWN',
});

// ── DOM 메타 읽기 헬퍼 ─────────────────────────────────────────

function _meta(selector) {
  try {
    const el = document.querySelector(selector);
    return el ? String(el.getAttribute('content') || '').trim() : '';
  } catch {
    return '';
  }
}

function _metaByName(name) {
  return _meta(`meta[name="${name}"]`);
}

function _metaByProperty(property) {
  return _meta(`meta[property="${property}"]`);
}

// ══════════════════════════════════════════════════════════════
//  Cafe24 어댑터
// ══════════════════════════════════════════════════════════════

// path_role → 우리 페이지 타입
// 실측 확인: MAIN(홈), PRODUCT_DETAIL(상품 상세)
// 나머지는 Cafe24 표준 값 기준이며, 못 맞히면 design_html_path로 한 번 더 시도한다.
const CAFE24_PATH_ROLE = Object.freeze({
  MAIN:           PAGE.HOME,
  INDEX:          PAGE.HOME,
  PRODUCT_DETAIL: PAGE.PRODUCT,
  PRODUCT_LIST:   PAGE.CATEGORY,
  CATEGORY:       PAGE.CATEGORY,
  PRODUCT_SEARCH: PAGE.SEARCH,
  SEARCH:         PAGE.SEARCH,
  ORDER_BASKET:   PAGE.CART,
  BASKET:         PAGE.CART,
  ORDER_FORM:     PAGE.CHECKOUT,
  ORDER_RESULT:   PAGE.ORDER_SUCCESS,
  BOARD_LIST:     PAGE.BOARD,
  BOARD_READ:     PAGE.BOARD,
  BOARD:          PAGE.BOARD,
  MYSHOP:         PAGE.MYPAGE,
  MEMBER:         PAGE.MEMBER,
  LOGIN:          PAGE.MEMBER,
});

/**
 * 스킨 파일 경로 → 페이지 타입
 *
 * design_html_path는 URL이 아니라 Cafe24 스킨 파일 경로다.
 * SEO URL을 어떻게 꾸미든 이 값은 고정이라 URL 추론보다 안정적이다.
 *
 * 순서가 중요하다: order_result를 order보다 먼저, basket을 order보다 먼저 본다.
 * Cafe24 장바구니 경로가 /order/basket.html이라, order를 먼저 검사하면
 * 장바구니가 결제 화면으로 잘못 분류된다. (기존 코드의 실제 버그)
 */
function _fromDesignPath(path) {
  const p = String(path || '').toLowerCase();
  if (!p) return null;

  if (p.includes('order_result') || p.includes('orderresult')) return PAGE.ORDER_SUCCESS;
  if (p.includes('basket'))                                    return PAGE.CART;
  if (p.includes('orderform') || p.includes('order_form'))     return PAGE.CHECKOUT;
  if (p.includes('/product/detail'))                           return PAGE.PRODUCT;
  if (p.includes('/product/list') || p.includes('/product/category')) return PAGE.CATEGORY;
  if (p.includes('/product/search'))                           return PAGE.SEARCH;
  if (p.includes('/board/'))                                   return PAGE.BOARD;
  if (p.includes('/myshop/'))                                  return PAGE.MYPAGE;
  if (p.includes('/member/'))                                  return PAGE.MEMBER;
  if (p.includes('/index.html') || p === '/')                  return PAGE.HOME;
  return null;
}

const cafe24Adapter = {
  name: 'cafe24',

  /** path_role 메타가 있으면 Cafe24다 */
  detect() {
    return Boolean(_metaByName('path_role'));
  },

  resolve() {
    const pathRole   = _metaByName('path_role');
    const designPath = _metaByName('design_html_path');

    // 1순위 path_role, 2순위 스킨 파일 경로
    const pageType =
      CAFE24_PATH_ROLE[pathRole.toUpperCase()] ||
      _fromDesignPath(designPath) ||
      PAGE.UNKNOWN;

    // 상품 ID — og:type이 product인 상세 페이지에서만 의미가 있다
    const productId =
      _metaByProperty('product:productId') ||
      _metaByProperty('product:retailer_item_id') ||
      '';

    const priceRaw = _metaByProperty('product:price:amount');
    const price = priceRaw && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;

    return {
      platform:      'cafe24',
      page_type:     pageType,
      platform_role: pathRole || '',      // 원본 값도 남긴다 (매핑 누락 추적용)
      product_id:    productId || null,
      product_price: price,
    };
  },
};

// 등록된 어댑터들 — 위에서부터 detect()가 참인 것을 쓴다
const ADAPTERS = [cafe24Adapter];

// ── 공개 API ──────────────────────────────────────────────────

let _cached = null;
let _resolved = false;

/**
 * 현재 페이지의 플랫폼 정보를 반환한다.
 * 어떤 어댑터도 감지되지 않으면 null (→ 기존 Layer 1/2로 동작).
 *
 * 페이지 로드마다 DOM은 고정이므로 한 번만 계산하고 캐시한다.
 * @returns {{platform, page_type, platform_role, product_id, product_price}|null}
 */
function getPlatformContext() {
  if (_resolved) return _cached;
  _resolved = true;

  try {
    for (const adapter of ADAPTERS) {
      if (adapter.detect()) {
        _cached = adapter.resolve();
        return _cached;
      }
    }
  } catch {
    // 메타 파싱이 실패해도 SDK 전체가 멈추면 안 된다
  }

  _cached = null;
  return null;
}

/** Layer 0이 확정한 상품 ID (없으면 null) */
function getPlatformProductId() {
  const ctx = getPlatformContext();
  return ctx && ctx.product_id ? ctx.product_id : null;
}

/** Layer 0이 확정한 페이지 타입 (없으면 '') */
function getPlatformPageType() {
  const ctx = getPlatformContext();
  return ctx && ctx.page_type ? ctx.page_type : '';
}

/** SPA 이동 등으로 DOM이 바뀌었을 때 캐시를 비운다 */
function resetPlatformContext() {
  _cached = null;
  _resolved = false;
}

export {
  getPlatformContext,
  getPlatformProductId,
  getPlatformPageType,
  resetPlatformContext,
  PAGE,
};
