/**
 * 상품 탐색 행동을 운영자용 지표로 정리한다.
 *
 * data.source에는 페이지 HTML 전체가 들어올 수 있으므로 절대 키워드 검색에
 * 사용하지 않는다. 실제 event_type과 클릭/호버 payload만 근거로 삼는다.
 */

const ADD_TO_CART_TYPES = new Set(['add_to_cart', 'cart_add', 'basket_add']);
const WISHLIST_TYPES = new Set(['add_to_wishlist', 'wishlist_add', 'favorite_add']);
const ORDER_COMPLETE_TYPES = new Set([
  'order_complete',
  'order_completed',
  'order_success',
  'purchase',
  'purchase_complete',
  'payment_complete',
  'payment_success',
]);
const CHECKOUT_TYPES = new Set(['begin_checkout', 'checkout_start', 'order_start', 'purchase_click']);

function clean(value) {
  return String(value ?? '').trim();
}

function normalizedPath(doc = {}) {
  const raw = clean(doc.pathname || doc.page_url);
  if (!raw) return '/';
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname || '/';
  } catch {
    // 잘못된 URL이면 원문 경로로 계속 처리한다.
  }
  return raw.split('?')[0] || '/';
}

function decoded(value) {
  try {
    return decodeURIComponent(clean(value)).replaceAll('-', ' ').trim();
  } catch {
    return clean(value).replaceAll('-', ' ').trim();
  }
}

function productFromPath(pathname = '') {
  const match = clean(pathname).match(/\/product\/([^/]+)\/(\d+)(?:\/category\/(\d+))?/i);
  if (!match) return null;
  return {
    id: match[2],
    name: decoded(match[1]),
    category_id: match[3] || '',
  };
}

function categoryFromPath(pathname = '') {
  const match = clean(pathname).match(/\/category\/([^/]+)\/(\d+)/i);
  if (!match) return null;
  return { name: decoded(match[1]), id: match[2] };
}

function eventTime(doc = {}) {
  const value = doc.received_at || doc.timestamp || null;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
}

function textIncludes(value, pattern) {
  return pattern.test(clean(value));
}

function buildCommerceSummary(events = []) {
  const productMap = new Map();
  const categoryMap = new Map();
  const cartSessions = new Set();
  const checkoutSessions = new Set();
  const completedOrderSessions = new Set();
  const recentActions = [];
  let productClicks = 0;
  let reviewViews = 0;
  let suspectedReviewViews = 0;
  let categoryViews = 0;
  let cartMoves = 0;
  let addToCart = 0;
  let wishlistAdds = 0;
  let checkoutStarts = 0;
  let orderCompletions = 0;

  const touchProduct = (doc, kind) => {
    const path = normalizedPath(doc);
    const pathInfo = productFromPath(path);
    const id = clean(doc.data?.product_id || pathInfo?.id);
    const rawName = clean(doc.data?.product_name || pathInfo?.name);
    if (!id && !rawName) return null;
    const name = rawName.replace(/\s+-\s+.*(?:제품|상품)?\s*이미지\s*$/i, '').trim() || `상품 ${id}`;
    const key = id || name;
    const row = productMap.get(key) || {
      product_id: id,
      name,
      clicks: 0,
      detail_views: 0,
      detail_sessions: new Set(),
      category_id: clean(doc.data?.category_id || pathInfo?.category_id),
      last_at: null,
    };
    if (kind === 'click') row.clicks += 1;
    if (kind === 'detail') row.detail_views += 1;
    if (doc.session_id && pathInfo) row.detail_sessions.add(String(doc.session_id));
    if (!row.name && name) row.name = name;
    if (!row.category_id) row.category_id = clean(doc.data?.category_id || pathInfo?.category_id);
    row.last_at = eventTime(doc) || row.last_at;
    productMap.set(key, row);
    return row;
  };

  for (const doc of events) {
    const type = clean(doc.event_type).toLowerCase();
    const path = normalizedPath(doc);
    const data = doc.data || {};
    const at = eventTime(doc);
    const sessionId = clean(doc.session_id);
    const productPath = productFromPath(path);

    if (productPath) touchProduct(doc, type === 'enter_product' ? 'detail' : 'path');

    if (type === 'product_click') {
      productClicks += 1;
      const product = touchProduct(doc, 'click');
      recentActions.push({
        type: 'product_click',
        label: product?.name || '상품',
        detail: product?.product_id ? `상품 ${product.product_id}` : '상품 상세 보기',
        at,
      });
    } else if (type === 'enter_product') {
      const product = touchProduct(doc, 'detail');
      recentActions.push({
        type: 'product_view',
        label: product?.name || '상품 상세',
        detail: product?.product_id ? `상품 ${product.product_id} 상세 진입` : '상품 상세 진입',
        at,
      });
    }

    if (type === 'enter_category') {
      categoryViews += 1;
      const fromPath = categoryFromPath(path);
      const payloadName = clean(data.category_name);
      const name = fromPath?.name || (payloadName && payloadName.toLowerCase() !== 'all' ? payloadName : '전체 상품');
      const id = fromPath?.id || clean(data.category_id);
      const key = `${id}:${name}`;
      const row = categoryMap.get(key) || { category_id: id, name, views: 0, last_at: null };
      row.views += 1;
      row.last_at = at || row.last_at;
      categoryMap.set(key, row);
      recentActions.push({ type: 'category_view', label: name, detail: '카테고리 확인', at });
    }

    const reviewSignal = type === 'subsection_enter'
      && (textIncludes(data.subsection_id, /review|리뷰|후기/i)
        || textIncludes(data.subsection_label, /review|리뷰|후기/i));
    if (reviewSignal && productPath) {
      reviewViews += 1;
      const product = touchProduct(doc, 'path');
      recentActions.push({
        type: 'review_view',
        label: product?.name || '상품 후기',
        detail: '상품후기 탭 확인',
        at,
      });
    } else if (reviewSignal) {
      suspectedReviewViews += 1;
    }

    if (/\/(?:order\/basket|cart)(?:[/.]|$)/i.test(path)) {
      if (sessionId) cartSessions.add(sessionId);
    }

    const role = clean(data.ghost_role).toLowerCase();
    const clickText = clean(data.click_text);
    const actionText = [
      data.click_text,
      data.text,
      data.target_text,
      data.element_text,
      data.button_text,
      data.label,
    ].map(clean).filter(Boolean).join(' ');
    const isCartAdd = ADD_TO_CART_TYPES.has(type)
      || /add.?cart|cart.?add|basket.?add/.test(role)
      || (type === 'click' && /장바구니\s*담기|add\s*to\s*cart/i.test(actionText));
    if (isCartAdd) {
      addToCart += 1;
      recentActions.push({ type: 'add_to_cart', label: '장바구니 담기', detail: '전용 행동 이벤트', at });
    }

    const isCartMove = (type === 'view_cart' || type === 'cart_view')
      || (type === 'click' && /장바구니\s*(?:이동|보기)|view\s*cart/i.test(clickText));
    if (isCartMove) {
      cartMoves += 1;
      recentActions.push({ type: 'cart_view', label: '장바구니', detail: '장바구니 화면으로 이동', at });
    }

    const isWishlist = WISHLIST_TYPES.has(type)
      || /wish|favorite|interest/.test(role)
      || (type === 'click' && /찜하기|관심상품|위시리스트|wishlist|favorite/i.test(actionText));
    if (isWishlist) {
      wishlistAdds += 1;
      recentActions.push({ type: 'wishlist_add', label: '찜하기', detail: '관심상품 등록', at });
    }

    const isCheckoutPath = /\/order\/(?!basket(?:[/.]|$))(?:orderform|checkout|payment)(?:[/.]|$)/i.test(path);
    const isCheckout = CHECKOUT_TYPES.has(type)
      || isCheckoutPath
      || (type === 'click' && /주문\s*(?:하기|진행)|결제\s*(?:하기|진행)|buy\s*now|checkout/i.test(actionText));
    if (isCheckout && (!sessionId || !checkoutSessions.has(sessionId))) {
      checkoutStarts += 1;
      if (sessionId) checkoutSessions.add(sessionId);
      recentActions.push({ type: 'checkout_start', label: '주문 진행', detail: '결제·주문 단계 진입', at });
    }

    const isOrderCompletePath = /\/order\/(?:order[_-]?(?:result|complete|success)|result|complete|success)(?:[/.]|$)/i.test(path);
    const isOrderComplete = ORDER_COMPLETE_TYPES.has(type) || isOrderCompletePath;
    if (isOrderComplete && (!sessionId || !completedOrderSessions.has(sessionId))) {
      orderCompletions += 1;
      if (sessionId) completedOrderSessions.add(sessionId);
      recentActions.push({ type: 'order_complete', label: '주문 완료', detail: '완료 이벤트 또는 완료 화면 확인', at });
    }
  }

  const products = [...productMap.values()]
    .map((row) => ({
      product_id: row.product_id,
      name: row.name,
      clicks: row.clicks,
      detail_views: Math.max(row.detail_views, row.detail_sessions.size),
      detail_sessions: row.detail_sessions.size,
      category_id: row.category_id,
      last_at: row.last_at,
    }))
    .filter((row) => row.clicks > 0 || row.detail_views > 0)
    .sort((a, b) => (b.clicks + b.detail_views) - (a.clicks + a.detail_views))
    .slice(0, 8);

  const categories = [...categoryMap.values()]
    .sort((a, b) => b.views - a.views)
    .slice(0, 8);

  recentActions.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  return {
    counts: {
      product_clicks: productClicks,
      product_detail_products: products.filter((item) => item.detail_views > 0).length,
      review_views: reviewViews,
      suspected_review_views: suspectedReviewViews,
      category_views: categoryViews,
      cart_visits: cartSessions.size,
      cart_moves: cartMoves,
      add_to_cart: addToCart,
      wishlist_adds: wishlistAdds,
      checkout_starts: checkoutStarts,
      order_completions: orderCompletions,
    },
    products,
    categories,
    recent_actions: recentActions.slice(0, 12),
    notes: {
      cart_tracking_gap: cartSessions.size > 0 && addToCart === 0,
      wishlist_tracking_gap: wishlistAdds === 0,
      order_tracking_gap: checkoutStarts > 0 && orderCompletions === 0,
      ignored_html_source: true,
    },
  };
}

module.exports = {
  buildCommerceSummary,
  normalizedPath,
  productFromPath,
  categoryFromPath,
};
