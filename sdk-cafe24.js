/**
 * sdk-cafe24.js — GhostTracker Cafe24 전용 의미 이벤트 어댑터
 *
 * 역할:
 *   - Cafe24 inline handler 인자 파싱
 *   - 장바구니 / 관심상품 intent 감지
 *   - 네트워크 응답, DOM 변화, 카운트 증가로 실제 성공 여부 판별
 *
 * 기존 sdk-A/B/C는 건드리지 않고, Cafe24에서만 추가 의미 이벤트를 얹는다.
 */

import { getPlatformContext, getPlatformProductId } from './core/platformAdapter.js';

const VERSION = '1.0.0';
const DEBUG_GLOBAL = '__GT_CAFE24_ADAPTER__';

const CART_SUCCESS_TEXT_RE = /장바구니 이동|장바구니에 담겼습니다|cart\s*added|added\s*to\s*cart|command\s*=\s*add/i;
const CART_FAILURE_TEXT_RE = /품절|재고 부족|옵션 선택 필요|로그인 필요|오류|실패|fail|error|sold\s*out/i;
const WISHLIST_SUCCESS_TEXT_RE = /관심상품.*등록|wishlist.*success|added\s*to\s*wishlist/i;
const WISHLIST_REMOVE_TEXT_RE = /관심상품.*삭제|관심상품.*해제|removed\s*from\s*wishlist/i;
const LOGIN_REQUIRED_TEXT_RE = /로그인 필요|member\/login|login\s*required/i;

let _initialized = false;
let _handleRawEvent = null;
let _observer = null;
let _fetchPatched = false;
let _xhrPatched = false;
let _pendingCart = null;
let _pendingWishlist = null;
let _pendingTimers = new Set();
let _pageEntryEmitted = false;
let _pageEntryKey = null;

function initCafe24Adapter(handleRawEvent) {
  if (_initialized) return;
  if (typeof handleRawEvent !== 'function') {
    throw new Error('initCafe24Adapter requires handleRawEvent function');
  }

  if (!_isCafe24Page()) {
    window[DEBUG_GLOBAL] = {
      initialized: false,
      version: VERSION,
      getState,
    };
    return;
  }

  _initialized = true;
  _handleRawEvent = handleRawEvent;

  _installClickTracking();
  _installNetworkTracking();
  _installMutationTracking();
  _installPageEntryTracking();
  _publishDebugHandle();

  window.addEventListener('beforeunload', _cleanup, { once: true });
}

function getState() {
  return {
    initialized: _initialized,
    version: VERSION,
    pendingCart: _pendingCart ? { ..._pendingCart } : null,
    pendingWishlist: _pendingWishlist ? { ..._pendingWishlist } : null,
    basketCount: _readBasketCount(),
    pageType: getPlatformContext()?.page_type || null,
  };
}

function _publishDebugHandle() {
  window[DEBUG_GLOBAL] = {
    initialized: true,
    version: VERSION,
    getState,
  };
}

function _cleanup() {
  for (const timerId of _pendingTimers) {
    clearTimeout(timerId);
  }
  _pendingTimers.clear();

  if (_observer) {
    _observer.disconnect();
    _observer = null;
  }
}

function _isCafe24Page() {
  if (_meta('meta[name="path_role"]')) return true;
  if (_meta('meta[name="design_html_path"]')) return true;
  if (_meta('meta[property="product:productId"]')) return true;

  return Boolean(document.querySelector([
    '[onclick*="category_add_basket"]',
    '[onclick*="selectOptionCommon"]',
    '[onclick*="product_submit"]',
    '[onclick*="add_to_cart"]',
    '[onclick*="add_wishlist"]',
    '[onclick*="add_wishlist_nologin"]',
    'a[onclick*="category_add_basket"]',
    'button[onclick*="category_add_basket"]',
    'input[onclick*="category_add_basket"]',
    'a[onclick*="add_wishlist"]',
    'button[onclick*="add_wishlist"]',
    'input[onclick*="add_wishlist"]',
    '.ec-product-listwishicon',
    'img.ec-product-listwishicon',
    '#actionCart',
    '.actionCart',
    '#actionWish',
    '.actionWish',
    '#actionWishSoldout',
    'img[alt*="장바구니"]',
    'img[alt*="관심상품"]',
    'img[alt*="찜"]',
  ].join(',')));
}

function _meta(selector) {
  try {
    const el = document.querySelector(selector);
    return el ? String(el.getAttribute('content') || '').trim() : '';
  } catch {
    return '';
  }
}

function _installClickTracking() {
  document.addEventListener('click', (event) => {
    const sectionTab = _findSectionTab(event.target);
    if (sectionTab) {
      _emit('subsection_enter', {
        subsection_id: sectionTab.subsection_id,
        subsection_label: sectionTab.subsection_label,
        trigger: 'product_tab_click',
        source: sectionTab.source,
      });
      return;
    }

    const source = _findActionSource(event.target);
    if (!source) return;

    const action = _parseAction(source);
    if (!action) return;

    if (action.type === 'cart') {
      _emitCartIntent(action);
      return;
    }

    if (action.type === 'wishlist') {
      _emitWishlistIntent(action);
    }
  }, true);
}

function _installPageEntryTracking() {
  const probe = () => _emitPageEntry();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe, { once: true });
  } else {
    setTimeout(probe, 0);
  }

  window.addEventListener('pageshow', probe);
}

function _emitPageEntry() {
  const ctx = getPlatformContext();
  if (!ctx || !ctx.page_type) return;

  const key = `${ctx.page_type}|${window.location.pathname}|${window.location.search}`;
  if (_pageEntryEmitted && _pageEntryKey === key) return;
  _pageEntryEmitted = true;
  _pageEntryKey = key;

  if (ctx.page_type === 'CATEGORY') {
    const category = _inferCategoryContext();
    _emit('enter_category', {
      page_type: ctx.page_type,
      category_name: category.category_name,
      category_id: category.category_id,
      category_path: category.category_path,
      category_slug: category.category_slug,
      trigger: 'page_entry',
    });
    return;
  }

  if (ctx.page_type === 'PRODUCT') {
    _emit('enter_product', {
      page_type: ctx.page_type,
      product_id: ctx.product_id || getPlatformProductId() || _readProductId(),
      category_id: _readCategoryId(),
      trigger: 'page_entry',
    });
  }
}

function _installNetworkTracking() {
  if (!_fetchPatched && typeof window.fetch === 'function') {
    _fetchPatched = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = function patchedFetch(...args) {
      const requestUrl = _resolveRequestUrl(args[0]);
      const responsePromise = originalFetch(...args);

      responsePromise.then((response) => {
        if (!response || !requestUrl || !_isInterestingUrl(requestUrl)) return;
        response.clone().text().then((bodyText) => {
          _handleResponse(requestUrl, response.status, bodyText);
        }).catch(() => {});
      }).catch(() => {});

      return responsePromise;
    };
  }

  if (!_xhrPatched && typeof window.XMLHttpRequest !== 'undefined') {
    _xhrPatched = true;
    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__gtCafe24Url = _resolveRequestUrl(url);
      return originalOpen.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function patchedSend(...args) {
      this.addEventListener('loadend', () => {
        try {
          const requestUrl = this.__gtCafe24Url;
          if (!requestUrl || !_isInterestingUrl(requestUrl)) return;
          _handleResponse(requestUrl, this.status, String(this.responseText || ''));
        } catch {
          /* ignore */
        }
      });

      return originalSend.apply(this, args);
    };
  }
}

function _installMutationTracking() {
  if (_observer || typeof MutationObserver === 'undefined') return;

  _observer = new MutationObserver(() => {
    _probePending('mutation');
  });

  const observeBody = () => {
    if (document.body && _observer) {
      _observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'icon_status', 'src', 'alt'],
      });
    }
  };

  if (document.body) {
    observeBody();
  } else {
    document.addEventListener('DOMContentLoaded', observeBody, { once: true });
  }
}

function _findActionSource(target) {
  let node = target instanceof Element ? target : null;
  let hops = 0;

  while (node && hops < 6) {
    const hit = _extractAction(node);
    if (hit) return hit;
    node = node.parentElement;
    hops += 1;
  }

  return null;
}

function _findSectionTab(target) {
  let node = target instanceof Element ? target : null;
  let hops = 0;

  while (node && hops < 6) {
    const source = _collectActionText(node);
    const tab = _parseSectionTab(source);
    if (tab) return tab;
    node = node.parentElement;
    hops += 1;
  }

  return null;
}

function _extractAction(node) {
  const raw = _collectActionText(node);
  if (!raw) return null;

  if (/category_add_basket\s*\(/.test(raw) || /actionCart\b/.test(raw) || /장바구니\s*담기/.test(raw) || /add\s*to\s*cart/i.test(raw)) {
    return { type: 'cart', mode: 'direct_add', source: raw };
  }

  if (/selectOptionCommon\s*\(/.test(raw) || /옵션\s*선택/.test(raw)) {
    return { type: 'cart', mode: 'option_required', source: raw };
  }

  if (/product_submit\s*\(\s*2\s*,/.test(raw) || /바로\s*구매/.test(raw) || /구매하기/.test(raw) || /buy\s*now/i.test(raw)) {
    return { type: 'cart', mode: 'detail_add', source: raw };
  }

  if (/add_wishlist_nologin\s*\(/.test(raw)) {
    return { type: 'wishlist', mode: 'login_required', source: raw };
  }

  if (/add_wishlist\s*\(/.test(raw) || /ec-product-listwishicon/.test(raw) || /actionWish/.test(raw) || /관심상품/.test(raw) || /찜/.test(raw) || /wishlist/i.test(raw)) {
    return { type: 'wishlist', mode: 'toggle', source: raw };
  }

  return null;
}

function _collectActionText(node) {
  if (!(node instanceof Element)) return '';

  const attrs = [
    node.getAttribute('onclick'),
    node.getAttribute('href'),
    node.getAttribute('src'),
    node.getAttribute('alt'),
    node.getAttribute('title'),
    node.getAttribute('value'),
    node.getAttribute('aria-label'),
    node.className,
    node.id,
    node.textContent,
    node.outerHTML,
  ];

  try {
    node.querySelectorAll?.('img, button, input, svg title').forEach((child) => {
      attrs.push(
        child.getAttribute?.('onclick'),
        child.getAttribute?.('href'),
        child.getAttribute?.('src'),
        child.getAttribute?.('alt'),
        child.getAttribute?.('title'),
        child.getAttribute?.('value'),
        child.getAttribute?.('aria-label'),
        child.textContent
      );
    });
  } catch {
    /* ignore DOM traversal failures */
  }

  return attrs.filter(Boolean).map((value) => String(value)).join(' ');
}

function _parseAction(action) {
  const source = action.source || '';

  if (action.type === 'cart' && action.mode === 'direct_add') {
    const args = _extractCallArgs(source, 'category_add_basket');
    const productId = _cleanArg(args[0]) || getPlatformProductId() || _readProductId();
    const categoryId = _cleanArg(args[1]) || _readCategoryId();

    return {
      type: 'cart',
      mode: 'direct_add',
      trigger: 'category_add_basket',
      product_id: productId || null,
      category_id: categoryId || null,
      product_code: _cleanArg(args[6]) || null,
    };
  }

  if (action.type === 'cart' && action.mode === 'option_required') {
    const args = _extractCallArgs(source, 'selectOptionCommon');
    const productId = _cleanArg(args[0]) || getPlatformProductId() || _readProductId();
    const categoryId = _cleanArg(args[1]) || _readCategoryId();

    return {
      type: 'cart',
      mode: 'option_required',
      trigger: 'selectOptionCommon',
      product_id: productId || null,
      category_id: categoryId || null,
    };
  }

  if (action.type === 'cart' && action.mode === 'detail_add') {
    const args = _extractCallArgs(source, 'product_submit');
    const endpoint = _cleanArg(args[1]) || null;
    const productId = getPlatformProductId() || _readProductId();
    const categoryId = _readCategoryId();

    return {
      type: 'cart',
      mode: 'detail_add',
      trigger: 'product_submit_2',
      endpoint,
      product_id: productId || null,
      category_id: categoryId || null,
    };
  }

  if (action.type === 'wishlist' && action.mode === 'login_required') {
    const args = _extractCallArgs(source, 'add_wishlist_nologin');
    const loginUrl = _cleanArg(args[0]) || '/member/login.html';
    const productId = _readWishlistProductId() || getPlatformProductId() || _readProductId();
    const categoryId = _readWishlistCategoryId() || _readCategoryId();

    return {
      type: 'wishlist',
      mode: 'login_required',
      trigger: 'add_wishlist_nologin',
      login_url: loginUrl,
      product_id: productId || null,
      category_id: categoryId || null,
    };
  }

  if (action.type === 'wishlist') {
    const wishlistMeta = _readWishlistMetaFromNode(source) || {};
    const productId = wishlistMeta.product_id || _readWishlistProductId() || getPlatformProductId() || _readProductId();
    const categoryId = wishlistMeta.category_id || _readWishlistCategoryId() || _readCategoryId();
    const operation = wishlistMeta.operation || (String(wishlistMeta.icon_status || '').toLowerCase() === 'on' ? 'remove' : 'add');

    return {
      type: 'wishlist',
      mode: 'toggle',
      trigger: wishlistMeta.trigger || 'wishlist_icon',
      operation,
      product_id: productId || null,
      category_id: categoryId || null,
      login_status: wishlistMeta.login_status || null,
      icon_status: wishlistMeta.icon_status || null,
    };
  }

  return null;
}

function _parseSectionTab(source) {
  if (/prdDetail|상세정보|detail/i.test(source)) {
    return { subsection_id: 'detail', subsection_label: '상세정보', source };
  }

  if (/prdReview|상품후기|리뷰|후기/i.test(source)) {
    return { subsection_id: 'review', subsection_label: '상품후기', source };
  }

  if (/prdQnA|상품문의|문의|q\s*&\s*a|qna/i.test(source)) {
    return { subsection_id: 'qa', subsection_label: '상품문의', source };
  }

  return null;
}

function _emitCartIntent(action) {
  const payload = _parseAction(action);
  if (!payload) return;

  if (payload.mode === 'option_required') {
    _pendingCart = {
      intent_id: _newId(),
      ...payload,
      created_at: Date.now(),
      basket_count: _readBasketCount(),
    };
    _emit('cart_intent', payload);
    _scheduleOptionModalProbe();
    return;
  }

  _pendingCart = {
    intent_id: _newId(),
    ...payload,
    created_at: Date.now(),
    basket_count: _readBasketCount(),
  };

  _emit('cart_intent', payload);
  _scheduleCartProbe();
}

function _emitWishlistIntent(action) {
  const payload = _parseAction(action);
  if (!payload) return;

  if (payload.mode === 'login_required' || payload.login_status === 'F') {
    _pendingWishlist = null;
    _emit('wishlist_login_required', {
      product_id: payload.product_id,
      category_id: payload.category_id,
      login_url: payload.login_url || '/member/login.html',
      trigger: payload.trigger,
    });
    return;
  }

  _pendingWishlist = {
    intent_id: _newId(),
    ...payload,
    created_at: Date.now(),
  };

  _emit('wishlist_intent', {
    operation: payload.operation || 'add',
    product_id: payload.product_id,
    category_id: payload.category_id,
    trigger: payload.trigger,
  });

  _scheduleWishlistProbe();
}

function _inferCategoryContext() {
  const preferredNodes = Array.from(document.querySelectorAll([
    '[aria-current="page"]',
    '.selected',
    '.current',
    '.active',
    '.on',
    '#category-name',
  ].join(',')));

  const links = Array.from(document.querySelectorAll([
    '.path a',
    '.breadcrumb a',
    '[class*="breadcrumb"] a',
    '[class*="path"] a',
    '[class*="category"] a',
    'nav a[href*="/category/"]',
    'a[href*="/category/"]',
  ].join(',')));

  const labelPatterns = [
    /^(all|outer|bottom|top|best|26season)$/i,
    /^(전체|아우터|바텀|탑|베스트|26season|26시즌)$/i,
  ];

  const orderedNodes = [...preferredNodes, ...links.filter((node) => !preferredNodes.includes(node))];

  const candidateTexts = orderedNodes
    .map((el) => ({
      text: String(el.textContent || '').trim().replace(/\s+/g, ' '),
      href: String(el.getAttribute('href') || ''),
    }))
    .filter((item) => item.text);

  const preferred = candidateTexts.find((item) => labelPatterns.some((re) => re.test(item.text)))
    || candidateTexts[candidateTexts.length - 1]
    || null;

  const categoryName = preferred ? preferred.text : null;
  const categoryHref = preferred ? preferred.href : '';
  const categorySlugMatch = categoryHref.match(/\/category\/([^/]+)/i);
  const categoryIdMatch = categoryHref.match(/\/category\/(?:[^/]+\/)?(\d+)\//i);

  return {
    category_name: categoryName,
    category_slug: categorySlugMatch ? decodeURIComponent(categorySlugMatch[1]) : null,
    category_id: categoryIdMatch ? categoryIdMatch[1] : _readCategoryId(),
    category_path: window.location.pathname,
  };
}

function _emit(eventType, data) {
  if (!_handleRawEvent) return;
  _handleRawEvent(eventType, data);
}

function _scheduleCartProbe() {
  _queueProbe(() => _probePending('cart'));
  _queueProbe(() => _probePending('cart'), 250);
  _queueProbe(() => _probePending('cart'), 1200);
}

function _scheduleWishlistProbe() {
  _queueProbe(() => _probePending('wishlist'));
  _queueProbe(() => _probePending('wishlist'), 250);
  _queueProbe(() => _probePending('wishlist'), 1200);
}

function _scheduleOptionModalProbe() {
  _queueProbe(() => {
    if (!_pendingCart || _pendingCart.mode !== 'option_required') return;
    if (_findVisibleOptionModal()) {
      _emit('option_modal_open', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
      });
    }
  }, 50);

  _queueProbe(() => {
    if (!_pendingCart || _pendingCart.mode !== 'option_required') return;
    if (_findVisibleOptionModal()) {
      _emit('option_modal_open', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
      });
    }
  }, 400);
}

function _queueProbe(fn, delay = 0) {
  const timerId = setTimeout(() => {
    _pendingTimers.delete(timerId);
    fn();
  }, delay);
  _pendingTimers.add(timerId);
}

function _probePending(reason) {
  if (_pendingCart) {
    const currentBasketCount = _readBasketCount();
    if (typeof currentBasketCount === 'number' && typeof _pendingCart.basket_count === 'number' && currentBasketCount > _pendingCart.basket_count) {
      _emit('add_to_cart_success', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
        product_code: _pendingCart.product_code,
        action_mode: _pendingCart.mode,
        trigger: _pendingCart.trigger,
        evidence: 'basket_count_increase',
        basket_count: currentBasketCount,
      });
      _pendingCart = null;
      return;
    }

    if (_findSuccessLayer(CART_SUCCESS_TEXT_RE)) {
      _emit('add_to_cart_success', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
        product_code: _pendingCart.product_code,
        action_mode: _pendingCart.mode,
        trigger: _pendingCart.trigger,
        evidence: 'success_layer',
      });
      _pendingCart = null;
      return;
    }

    if (_pendingCart.mode === 'option_required' && reason !== 'cart' && _findVisibleOptionModal()) {
      _emit('option_modal_open', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
      });
    }
  }

  if (_pendingWishlist) {
    const wishlistState = _readWishlistState(_pendingWishlist);
    if (wishlistState === 'login_required') {
      _emit('wishlist_login_required', {
        intent_id: _pendingWishlist.intent_id,
        product_id: _pendingWishlist.product_id,
        category_id: _pendingWishlist.category_id,
        login_url: _pendingWishlist.login_url || '/member/login.html',
      });
      _pendingWishlist = null;
      return;
    }

    if (wishlistState === 'add_success') {
      _emit('add_to_wishlist_success', {
        intent_id: _pendingWishlist.intent_id,
        product_id: _pendingWishlist.product_id,
        category_id: _pendingWishlist.category_id,
        evidence: 'icon_state_on',
      });
      _pendingWishlist = null;
      return;
    }

    if (wishlistState === 'remove_success') {
      _emit('remove_from_wishlist_success', {
        intent_id: _pendingWishlist.intent_id,
        product_id: _pendingWishlist.product_id,
        category_id: _pendingWishlist.category_id,
        evidence: 'icon_state_off',
      });
      _pendingWishlist = null;
      return;
    }
  }
}

function _handleResponse(url, status, bodyText) {
  const lowered = String(bodyText || '').toLowerCase();
  const parsed = _tryParseJson(bodyText);
  const isCartUrl = /basket/i.test(url);
  const isWishlistUrl = /wish/i.test(url);

  if (!_pendingCart && !_pendingWishlist) return;

  if (_pendingCart && isCartUrl) {
    if (_isSuccessPayload(parsed, lowered)) {
      _emit('add_to_cart_success', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
        product_code: _pendingCart.product_code,
        action_mode: _pendingCart.mode,
        trigger: _pendingCart.trigger,
        evidence: 'network_success',
      });
      _pendingCart = null;
      return;
    }

    if (_isFailurePayload(parsed, lowered) || status >= 400 || CART_FAILURE_TEXT_RE.test(lowered)) {
      _emit('cart_action_error', {
        intent_id: _pendingCart.intent_id,
        product_id: _pendingCart.product_id,
        category_id: _pendingCart.category_id,
        product_code: _pendingCart.product_code,
        action_mode: _pendingCart.mode,
        trigger: _pendingCart.trigger,
        status,
        message: _pickMessage(parsed, bodyText),
      });
      _pendingCart = null;
      return;
    }
  }

  if (_pendingWishlist && isWishlistUrl) {
    if (LOGIN_REQUIRED_TEXT_RE.test(lowered) || _looksLikeLoginRequired(parsed, lowered)) {
      _emit('wishlist_login_required', {
        intent_id: _pendingWishlist.intent_id,
        product_id: _pendingWishlist.product_id,
        category_id: _pendingWishlist.category_id,
        login_url: _pendingWishlist.login_url || '/member/login.html',
      });
      _pendingWishlist = null;
      return;
    }

    if (_isSuccessPayload(parsed, lowered) || WISHLIST_SUCCESS_TEXT_RE.test(lowered) || WISHLIST_REMOVE_TEXT_RE.test(lowered)) {
      const operation = _pendingWishlist.operation || 'add';
      _emit(operation === 'remove' ? 'remove_from_wishlist_success' : 'add_to_wishlist_success', {
        intent_id: _pendingWishlist.intent_id,
        product_id: _pendingWishlist.product_id,
        category_id: _pendingWishlist.category_id,
        evidence: 'network_success',
      });
      _pendingWishlist = null;
      return;
    }
  }

  _probePending('network');
}

function _isSuccessPayload(parsed, loweredText) {
  if (parsed && typeof parsed === 'object') {
    const result = parsed.result ?? parsed.success ?? parsed.ok ?? parsed.code ?? null;
    if (result === true || result === 'true' || result === 1 || result === '1' || result === '0000') return true;
    if (typeof parsed.message === 'string' && /성공|담겼|등록/i.test(parsed.message)) return true;
  }

  return /"?success"?\s*:\s*true|"?result"?\s*:\s*true|"?result"?\s*:\s*"?1"?|"?code"?\s*:\s*"?0000"?/.test(loweredText) || CART_SUCCESS_TEXT_RE.test(loweredText) || WISHLIST_SUCCESS_TEXT_RE.test(loweredText);
}

function _isFailurePayload(parsed, loweredText) {
  if (parsed && typeof parsed === 'object') {
    const result = parsed.result ?? parsed.success ?? parsed.ok ?? null;
    if (result === false || result === 'false' || result === 0 || result === '0') return true;
    if (typeof parsed.message === 'string' && /실패|오류|품절|재고|로그인/i.test(parsed.message)) return true;
  }

  return /"?success"?\s*:\s*false|"?result"?\s*:\s*false|품절|재고 부족|옵션 선택 필요|로그인 필요|error|fail|오류|실패/.test(loweredText);
}

function _looksLikeLoginRequired(parsed, loweredText) {
  if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
    return LOGIN_REQUIRED_TEXT_RE.test(parsed.message);
  }
  return LOGIN_REQUIRED_TEXT_RE.test(loweredText);
}

function _pickMessage(parsed, bodyText) {
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim().slice(0, 200);
    if (typeof parsed.msg === 'string' && parsed.msg.trim()) return parsed.msg.trim().slice(0, 200);
  }
  return String(bodyText || '').trim().slice(0, 200);
}

function _tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function _resolveRequestUrl(input) {
  try {
    if (typeof input === 'string') return new URL(input, window.location.href).href;
    if (input && typeof input.url === 'string') return new URL(input.url, window.location.href).href;
  } catch {
    return '';
  }
  return '';
}

function _isInterestingUrl(url) {
  return /\/exec\/front\/order\/|basket|wish|wishlist|add_wishlist|remove_wishlist|login/i.test(url);
}

function _findSuccessLayer(regex) {
  const text = document.body ? document.body.innerText || '' : '';
  return regex.test(text);
}

function _findVisibleOptionModal() {
  const candidates = document.querySelectorAll([
    '.xans-product-optionlayer',
    '[class*="optionlayer"]',
    '[class*="optionLayer"]',
    '[class*="option-modal"]',
    '[id*="optionlayer"]',
    '[id*="optionLayer"]',
    '[id*="option-modal"]',
    '.layer',
    '.popup',
    '.popup-layer',
  ].join(','));

  for (const el of candidates) {
    if (_isVisible(el)) return true;
  }
  return false;
}

function _isVisible(el) {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function _readBasketCount() {
  const selectors = [
    '#cart-count',
    '.cart-count',
    '.count',
    '.xans-layout-shoppinginfo .count',
    '.xans-layout-shoppinginfo strong',
    '[class*="cartCount"]',
    '[id*="cartCount"]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const match = String(el.textContent || '').match(/\d+/);
    if (match) return Number(match[0]);
  }

  return null;
}

function _readProductId() {
  const selectors = [
    'input[name="product_no"]',
    'input[name="product_no[]"]',
    'input[name="productNo"]',
    'input[name="product_id"]',
    '[name="product_no"]',
    '[name="product_no[]"]',
    '[data-product-no]',
    '[data-product-id]',
    '[productno]',
    '[product_no]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const value = el?.getAttribute('value') || el?.getAttribute('data-product-no') || el?.getAttribute('data-product-id') || el?.getAttribute('productno') || el?.getAttribute('product_no') || '';
    if (value) return String(value).trim();
  }

  return null;
}

function _readCategoryId() {
  const selectors = [
    'input[name="cate_no"]',
    'input[name="category_no"]',
    'input[name="category_no[]"]',
    '[name="cate_no"]',
    '[name="category_no"]',
    '[data-category-no]',
    '[categoryno]',
    '[category_no]',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const value = el?.getAttribute('value') || el?.getAttribute('data-category-no') || el?.getAttribute('categoryno') || el?.getAttribute('category_no') || '';
    if (value) return String(value).trim();
  }

  return null;
}

function _readWishlistProductId() {
  const el = _findWishlistAnchor();
  if (!el) return null;
  return String(el.getAttribute('productno') || el.getAttribute('product_no') || _readProductId() || '').trim() || null;
}

function _readWishlistCategoryId() {
  const el = _findWishlistAnchor();
  if (!el) return null;
  return String(el.getAttribute('categoryno') || el.getAttribute('category_no') || _readCategoryId() || '').trim() || null;
}

function _readWishlistMetaFromNode(source) {
  const node = source instanceof Element ? source.closest('.ec-product-listwishicon, [productno], [categoryno], #actionWish, .actionWish, #actionWishSoldout, [onclick*="add_wishlist"], [onclick*="add_wishlist_nologin"]') : null;
  if (!node) return null;

  const productId = String(node.getAttribute('productno') || node.getAttribute('product_no') || '').trim();
  const categoryId = String(node.getAttribute('categoryno') || node.getAttribute('category_no') || '').trim();
  const loginStatus = String(node.getAttribute('login_status') || '').trim();
  const iconStatus = String(node.getAttribute('icon_status') || '').trim();

  return {
    trigger: node.classList.contains('ec-product-listwishicon') ? 'ec-product-listwishicon' : (node.id || node.className || 'wishlist_icon'),
    product_id: productId || null,
    category_id: categoryId || null,
    login_status: loginStatus || null,
    icon_status: iconStatus || null,
    operation: iconStatus.toLowerCase() === 'on' ? 'remove' : 'add',
  };
}

function _findWishlistAnchor() {
  return document.querySelector('.ec-product-listwishicon, [productno], [categoryno], #actionWish, .actionWish, #actionWishSoldout, [onclick*="add_wishlist"], [onclick*="add_wishlist_nologin"]');
}

function _readWishlistState(pendingWishlist) {
  const anchors = Array.from(document.querySelectorAll('.ec-product-listwishicon, [productno], [categoryno], #actionWish, .actionWish, #actionWishSoldout, [onclick*="add_wishlist"], [onclick*="add_wishlist_nologin"]'));
  for (const el of anchors) {
    const productId = String(el.getAttribute('productno') || el.getAttribute('product_no') || '').trim();
    const categoryId = String(el.getAttribute('categoryno') || el.getAttribute('category_no') || '').trim();
    if (pendingWishlist.product_id && productId && pendingWishlist.product_id !== productId) continue;
    if (pendingWishlist.category_id && categoryId && pendingWishlist.category_id !== categoryId) continue;

    const loginStatus = String(el.getAttribute('login_status') || '').trim();
    const iconStatus = String(el.getAttribute('icon_status') || '').trim().toLowerCase();
    const src = String(el.getAttribute('src') || '').toLowerCase();
    const alt = String(el.getAttribute('alt') || '').toLowerCase();
    const title = String(el.getAttribute('title') || '').toLowerCase();
    const text = String(el.textContent || '').toLowerCase();

    if (loginStatus === 'F' || LOGIN_REQUIRED_TEXT_RE.test(`${src} ${alt} ${title} ${text}`)) {
      return 'login_required';
    }

    if (pendingWishlist.operation === 'remove') {
      if (iconStatus === 'off' || /before/.test(src) || /등록 전/.test(alt + title + text)) return 'remove_success';
    } else if (iconStatus === 'on' || /after/.test(src) || /등록 후/.test(alt + title + text)) {
      return 'add_success';
    }
  }

  return null;
}

function _extractCallArgs(source, fnName) {
  const start = source.indexOf(fnName + '(');
  if (start < 0) return [];

  let idx = start + fnName.length + 1;
  let depth = 1;
  let current = '';
  let quote = null;
  const args = [];

  while (idx < source.length) {
    const ch = source[idx];

    if (quote) {
      if (ch === '\\' && idx + 1 < source.length) {
        current += ch + source[idx + 1];
        idx += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      idx += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      idx += 1;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      current += ch;
      idx += 1;
      continue;
    }

    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        if (current.trim()) args.push(current.trim());
        break;
      }
      current += ch;
      idx += 1;
      continue;
    }

    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      idx += 1;
      continue;
    }

    current += ch;
    idx += 1;
  }

  return args;
}

function _cleanArg(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^['"]|['"]$/g, '').trim();
}

function _newId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export { initCafe24Adapter, getState };

