/**
 * sdk-C.js  —  C 담당 (김다민)
 *
 * 역할: 스크롤 / 섹션 / 서브섹션 / 이커머스 / 리뷰 이벤트 수집
 *   - scroll: depth, milestone, stop, direction_change, speed
 *   - section: enter, exit, revisit, transition
 *   - subsection: enter, exit, dwell (시간계산 A에 위임), revisit
 *   - ecommerce: product_click, option_select, option_change,
 *                quantity_change, add_to_cart, remove_from_cart, purchase_click
 *   - review: review_click, review_page_change, review_scroll,
 *             review_area_scroll, review_image_click
 *
 * 연결 방식:
 *   - ES 모듈 export initC(handleRawEvent)
 *   - index.js에서 initC(emit) 호출
 *   - subsection enter/exit → window.__GT.subsectionEnter/Exit (A가 dwell 시간 계산)
 */

export function initC(handleRawEvent) {
  if (typeof handleRawEvent !== 'function') {
    throw new Error('initC requires handleRawEvent function');
  }

  _initScrollTracking(handleRawEvent);
  _initSectionTracking(handleRawEvent);
  _initSubsectionTracking(handleRawEvent);
  _initEcommerceTracking(handleRawEvent);
  _initReviewTracking(handleRawEvent);

  console.log('[GhostTracker] sdk-C initialized');
}

// ─────────────────────────────────────────────────────────────
// SCROLL TRACKING
// ─────────────────────────────────────────────────────────────

function _initScrollTracking(handleRawEvent) {
  let ticking        = false;
  let lastDepth      = -1;
  let lastY          = 0;
  let lastDirection  = null;
  let lastTime       = Date.now();
  let scrollTimeout  = null;
  let isFirstScroll  = true;

  const milestones = [25, 50, 75, 100];
  const reached    = new Set();

  function getScrollDepth() {
    const scrollTop  = window.scrollY;
    const docHeight  = document.body.scrollHeight - window.innerHeight;
    if (docHeight < 100) return 0;
    return Math.round((scrollTop / docHeight) * 100);
  }

  function detectDirection(depth) {
    const currentY  = window.scrollY;
    const direction = currentY > lastY ? 'down' : 'up';

    if (lastDirection && direction !== lastDirection) {
      handleRawEvent('scroll_direction_change', {
        from: lastDirection,
        to:   direction,
        depth_pct: depth,
      });
    }

    lastDirection = direction;
    lastY         = currentY;
  }

  function detectSpeed() {
    const now = Date.now();
    const dy  = Math.abs(window.scrollY - lastY);
    const dt  = now - lastTime;

    if (dt > 0) {
      const speed = dy / dt;
      handleRawEvent('scroll_speed', { speed: Number(speed.toFixed(3)) });
    }
    lastTime = now;
  }

  function handleScroll() {
    const depth = getScrollDepth();

    if (isFirstScroll) {
      isFirstScroll = false;
      lastDepth     = depth;
      return;
    }

    if (Math.abs(depth - lastDepth) >= 5) {
      lastDepth = depth;
      handleRawEvent('scroll_depth', { depth_pct: depth });
    }

    milestones.forEach((m) => {
      if (depth >= m && !reached.has(m)) {
        reached.add(m);
        handleRawEvent('scroll_milestone', { milestone: m });
      }
    });

    detectSpeed();
    detectDirection(depth);
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        handleScroll();
        ticking = false;
      });
      ticking = true;
    }

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      handleRawEvent('scroll_stop', { position: window.scrollY });
    }, 300);
  });
}

// ─────────────────────────────────────────────────────────────
// SECTION TRACKING
//   1순위: [data-section="..."] 명시적 마킹
//   2순위: HTML5 시맨틱 태그 자동 추론 (inferred: true)
// ─────────────────────────────────────────────────────────────

function _initSectionTracking(handleRawEvent) {
  const activeSections = new Set();
  const visitCount = {};
  let lastSection = null;
  let autoIndex = 0;
  let rescanTimer = null;

  /**
   * 요소의 id/class/aria/text를 합쳐서 section 의미를 추론한다.
   * data-section이 있으면 그것을 최우선으로 사용한다.
   */
  function inferSectionName(el) {
    if (!(el instanceof Element)) return null;

    // 1순위: 명시적 마킹
    if (el.dataset.section) {
      return normalizeSectionName(el.dataset.section);
    }

    const tag = el.tagName.toLowerCase();

    const className =
      typeof el.className === 'string'
        ? el.className
        : '';

    const headingText =
      el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent || '';

    const raw = [
      el.id || '',
      className,
      el.getAttribute('aria-label') || '',
      el.getAttribute('role') || '',
      headingText,
      // 너무 긴 텍스트 전체를 보면 오탐/비용이 커져서 앞부분만 사용
      el.textContent?.slice(0, 120) || '',
    ]
      .join(' ')
      .toLowerCase();

    // 2순위: 쇼핑몰 핵심 영역 자동 추론
    if (/review|reviews|리뷰|후기|상품평|구매평|customer-review|user-review/.test(raw)) {
      return 'review';
    }

    if (/shipping|delivery|deliver|배송|배달|택배|반품|교환|환불|return|refund/.test(raw)) {
      return 'shipping';
    }

    if (/size|sizes|사이즈|치수|실측|size-chart|option-size/.test(raw)) {
      return 'size';
    }

    if (/price|가격|금액|할인|쿠폰|discount|coupon|benefit|sale/.test(raw)) {
      return 'price';
    }

    if (/image|images|photo|gallery|thumbnail|이미지|사진|썸네일|product-image/.test(raw)) {
      return 'image';
    }

    if (/product-detail|product_detail|detail|description|상품정보|상세정보|상세설명|제품정보/.test(raw)) {
      return 'product_detail';
    }

    if (/cart|basket|bag|장바구니|바구니/.test(raw)) {
      return 'cart';
    }

    if (/checkout|order|payment|결제|주문/.test(raw)) {
      return 'checkout';
    }

    // 3순위: HTML5 semantic tag
    if (['header', 'nav', 'main', 'footer', 'aside'].includes(tag)) {
      return tag;
    }

    // section/article인데 heading이 있으면 heading 기반 이름 생성
    if (['section', 'article'].includes(tag) && headingText.trim()) {
      return normalizeSectionName(headingText.trim());
    }

    // fallback
    if (['section', 'article'].includes(tag)) {
      return `${tag}_${autoIndex++}`;
    }

    return null;
  }

  function normalizeSectionName(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_가-힣]/g, '')
      .slice(0, 40);
  }

  function isSectionCandidate(el) {
    if (!(el instanceof Element)) return false;

    // 너무 작은 요소는 section으로 보기 어려움
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 40) return false;

    // 명시적 마킹은 무조건 후보
    if (el.dataset.section) return true;

    const tag = el.tagName.toLowerCase();

    // semantic tag는 후보
    if (['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(tag)) {
      return true;
    }

    const className =
      typeof el.className === 'string'
        ? el.className
        : '';

    const raw = [
      el.id || '',
      className,
      el.getAttribute('aria-label') || '',
      el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent || '',
      el.textContent?.slice(0, 120) || '',
    ]
      .join(' ')
      .toLowerCase();

    // 쇼핑몰 주요 영역 후보
    return (
      /review|reviews|리뷰|후기|상품평|구매평/.test(raw) ||
      /shipping|delivery|배송|배달|택배|반품|교환|환불/.test(raw) ||
      /size|sizes|사이즈|치수|실측/.test(raw) ||
      /price|가격|금액|할인|쿠폰|discount|coupon/.test(raw) ||
      /product-detail|product_detail|detail|description|상품정보|상세정보|상세설명|제품정보/.test(raw) ||
      /image|images|photo|gallery|thumbnail|이미지|사진|썸네일/.test(raw) ||
      /cart|basket|bag|장바구니|바구니/.test(raw) ||
      /checkout|order|payment|결제|주문/.test(raw)
    );
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const el = entry.target;
        const id = el.dataset.section || el.dataset.ghostSectionInferred;
        const isInferred = !el.dataset.section && !!el.dataset.ghostSectionInferred;

        if (!id) return;

        if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
          if (!activeSections.has(id)) {
            activeSections.add(id);

            handleRawEvent('section_enter', {
              section: id,
              ...(isInferred && { inferred: true }),
            });

            visitCount[id] = (visitCount[id] || 0) + 1;

            if (visitCount[id] > 1) {
              handleRawEvent('section_revisit', {
                section: id,
                count: visitCount[id],
                ...(isInferred && { inferred: true }),
              });
            }

            if (lastSection && lastSection !== id) {
              handleRawEvent('section_transition', {
                from: lastSection,
                to: id,
              });
            }

            lastSection = id;
          }
        } else if (!entry.isIntersecting) {
          if (activeSections.has(id)) {
            activeSections.delete(id);

            handleRawEvent('section_exit', {
              section: id,
              ...(isInferred && { inferred: true }),
            });
          }
        }
      });
    },
    {
      threshold: [0.3],
    }
  );

  function observeSectionElement(el) {
    if (!(el instanceof Element)) return;

    // 중복 observe 방지
    if (el.dataset.gtSectionObserved === 'true') return;

    if (!isSectionCandidate(el)) return;

    const sectionName = inferSectionName(el);
    if (!sectionName) return;

    if (!el.dataset.section) {
      el.dataset.ghostSectionInferred = sectionName;
    }

    el.dataset.gtSectionObserved = 'true';
    observer.observe(el);
  }

  function initSectionObserver() {
    const SECTION_SELECTOR = [
      // 명시적 마킹
      '[data-section]',

      // HTML5 semantic
      'header',
      'nav',
      'main',
      'section',
      'article',
      'aside',
      'footer',

      // review
      '[id*="review" i]',
      '[class*="review" i]',
      '[id*="리뷰"]',
      '[class*="리뷰"]',
      '[id*="후기"]',
      '[class*="후기"]',
      '[id*="상품평"]',
      '[class*="상품평"]',

      // shipping / delivery
      '[id*="shipping" i]',
      '[class*="shipping" i]',
      '[id*="delivery" i]',
      '[class*="delivery" i]',
      '[id*="배송"]',
      '[class*="배송"]',
      '[id*="반품"]',
      '[class*="반품"]',
      '[id*="교환"]',
      '[class*="교환"]',

      // size
      '[id*="size" i]',
      '[class*="size" i]',
      '[id*="사이즈"]',
      '[class*="사이즈"]',

      // price / benefit
      '[id*="price" i]',
      '[class*="price" i]',
      '[id*="discount" i]',
      '[class*="discount" i]',
      '[id*="coupon" i]',
      '[class*="coupon" i]',
      '[id*="가격"]',
      '[class*="가격"]',
      '[id*="쿠폰"]',
      '[class*="쿠폰"]',

      // product detail
      '[id*="product-detail" i]',
      '[class*="product-detail" i]',
      '[id*="product_detail" i]',
      '[class*="product_detail" i]',
      '[id*="detail" i]',
      '[class*="detail" i]',
      '[id*="description" i]',
      '[class*="description" i]',
      '[id*="상품정보"]',
      '[class*="상품정보"]',
      '[id*="상세정보"]',
      '[class*="상세정보"]',
      '[id*="상세설명"]',
      '[class*="상세설명"]',

      // image / gallery
      '[id*="gallery" i]',
      '[class*="gallery" i]',
      '[id*="image" i]',
      '[class*="image" i]',
      '[id*="photo" i]',
      '[class*="photo" i]',
      '[id*="thumbnail" i]',
      '[class*="thumbnail" i]',
    ].join(',');

    document.querySelectorAll(SECTION_SELECTOR).forEach(observeSectionElement);
  }

  function scheduleSectionRescan() {
    clearTimeout(rescanTimer);

    rescanTimer = setTimeout(() => {
      initSectionObserver();
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSectionObserver);
  } else {
    initSectionObserver();
  }

  // React / Next.js / SPA에서 페이지 이동 후 DOM이 새로 생기는 경우 대응
  const mutationObserver = new MutationObserver(() => {
    scheduleSectionRescan();
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // history API 기반 SPA 이동 대응
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    scheduleSectionRescan();
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    scheduleSectionRescan();
  };

  window.addEventListener('popstate', scheduleSectionRescan);
}

// ─────────────────────────────────────────────────────────────
// SUBSECTION TRACKING  [data-subsection="..."]
// dwell 시간 계산은 A(window.__GT)에 위임
// ─────────────────────────────────────────────────────────────

function _initSubsectionTracking(handleRawEvent) {
  const visitCount = {};

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const id = entry.target.dataset.subsection;
        if (!id) return;

        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          // A bridge로 enter 알림 (dwell 계산 + subsection_enter emit은 A)
          window.__GT?.subsectionEnter?.(id);

          // revisit 감지
          visitCount[id] = (visitCount[id] || 0) + 1;
          if (visitCount[id] > 1) {
            handleRawEvent('subsection_revisit', { subsection_id: id, count: visitCount[id] });
          }
        } else if (!entry.isIntersecting) {
          // A bridge로 exit 알림 (dwell 계산 후 subsection_dwell + subsection_exit emit은 A)
          window.__GT?.subsectionExit?.(id);
        }
      });
    },
    { threshold: [0.5] }
  );

  function initSubsectionObserver() {
    document.querySelectorAll('[data-subsection]').forEach((el) => observer.observe(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSubsectionObserver);
  } else {
    initSubsectionObserver();
  }
}

// ─────────────────────────────────────────────────────────────
// ECOMMERCE TRACKING
//   Layer 1: [data-ghost-role="..."] 명시적 마킹 (확정)
//   Layer 2: 텍스트 / 클래스 / href 휴리스틱 (inferred: true)
//
// 지원 역할:
//   product-card, product-link → product_click
//   option-select              → option_select
//   option-change              → option_change (동일 select 반복 변경)
//   quantity-input             → quantity_change
//   add-to-cart                → add_to_cart
//   remove-from-cart           → remove_from_cart
//   purchase-btn               → purchase_click
// ─────────────────────────────────────────────────────────────

function _initEcommerceTracking(handleRawEvent) {
  // option_change: 동일 select 반복 변경 추적
  const optionChangeCounts = new WeakMap();

  // ── 휴리스틱 유틸 ─────────────────────────────────────────
  const ADD_TO_CART_TEXT = [
    /add\s*to\s*cart/i, /add\s*to\s*bag/i, /add\s*to\s*basket/i,
    /장바구니/i, /담기/i, /카트에?\s*추가/i,
  ];

  // ── remove_from_cart 3단계 감지 시스템 ──────────────────────
  // Level 1: 명시적 패턴 (컨텍스트 불필요 — 오탐 거의 없음)
  const REMOVE_EXPLICIT_TEXT = [
    /remove\s*from\s*(cart|bag|basket)/i,
    /delete\s*from\s*(cart|bag|basket)/i,
    /장바구니.*(삭제|제거)/i,
    /카트.*(삭제|제거)/i,
    /담은\s*상품?\s*(삭제|제거)/i,
  ];
  const REMOVE_EXPLICIT_CLASS = [
    'cart-remove', 'remove-from-cart', 'delete-from-cart',
    'cart-item-remove', 'cart-item-delete', 'cart-delete',
    'basket-remove', 'bag-remove',
  ];
  const REMOVE_EXPLICIT_ARIA = [
    /remove\s*(item\s*)?from\s*(cart|bag|basket)/i,
    /장바구니.*(삭제|제거)/i,
    /delete\s*(item\s*)?from\s*(cart|bag|basket)/i,
  ];

  // Level 2: 일반 패턴 (아래 cart item 컨텍스트 내에서만 허용)
  const CART_ITEM_SELECTOR = [
    '[class*="cart-item"]', '[class*="cart_item"]',
    '[class*="cart-product"]', '[class*="cart_product"]',
    '[class*="basket-item"]', '[class*="basket_item"]',
    '[class*="bag-item"]', '[class*="bag_item"]',
    '[class*="order-item"]', '[class*="order_item"]',
    '[class*="line-item"]', '[class*="lineitem"]',
    '[data-cart-item]', '[data-item-id]',
  ].join(',');

  const REMOVE_GENERIC_TEXT = [
    /^(삭제|제거|지우기)$/,
    /^(remove|delete)$/i,
  ];
  const REMOVE_GENERIC_CLASS = [
    'remove-btn', 'remove-item', 'delete-item',
    'btn-remove', 'delete-btn', 'btn-delete',
    'item-remove', 'item-delete',
    'close-item', 'item-close',
  ];
  const REMOVE_GENERIC_ARIA = [
    /^(삭제|제거|remove|delete)$/i,
    /상품\s*(삭제|제거)/i,
    /아이템?\s*(삭제|제거)/i,
  ];
  // X / × 아이콘 텍스트 (컨텍스트 안에서만)
  const X_ICON_RE = /^[×✕✖✗]$|^x$/i;

  // remove_from_cart 판별 함수
  function isRemoveFromCart(el) {
    // Level 1: 명시적 — 컨텍스트 불필요
    const ariaLabel = el.getAttribute?.('aria-label') || '';
    if (
      REMOVE_EXPLICIT_TEXT.some((p) => p.test(textOf(el)) || p.test(ariaLabel)) ||
      hasClass(el, REMOVE_EXPLICIT_CLASS) ||
      REMOVE_EXPLICIT_ARIA.some((p) => p.test(ariaLabel))
    ) return true;

    // Level 2: 일반 — cart item 컨텍스트 필수
    const inCartCtx = !!el.closest(CART_ITEM_SELECTOR);
    if (!inCartCtx) return false;

    const t = textOf(el).trim();

    // 2a. 일반 삭제 텍스트 (정확히 매치)
    if (REMOVE_GENERIC_TEXT.some((p) => p.test(t))) return true;

    // 2b. X / × 아이콘 텍스트
    if (X_ICON_RE.test(t)) return true;

    // 2c. 클래스 기반
    if (hasClass(el, REMOVE_GENERIC_CLASS)) return true;

    // 2d. aria-label 기반
    if (REMOVE_GENERIC_ARIA.some((p) => p.test(ariaLabel))) return true;

    // 2e. SVG 아이콘 전용 버튼 (텍스트 없음 + SVG 있음 + 삭제 관련 클래스/aria)
    const hasSvg = !!el.querySelector('svg');
    const svgTitle = el.querySelector('svg title')?.textContent || '';
    if (
      hasSvg && t === '' && (
        hasClass(el, [...REMOVE_GENERIC_CLASS, 'close', 'dismiss', 'clear', 'trash']) ||
        /delete|remove|삭제|제거|trash/i.test(svgTitle)
      )
    ) return true;

    return false;
  }

  const PURCHASE_TEXT = [
    /buy\s*now/i, /checkout/i, /place\s*order/i, /proceed\s*to\s*checkout/i,
    /구매하기/i, /주문하기/i, /결제하기/i, /^결제$/i, /주문\s*완료/i,
  ];
  const PURCHASE_HREF = ['/checkout', '/order', '/purchase', '/pay'];
  const PRODUCT_HREF  = /\/(?:product|p|item|goods|shop)\/([^/?#]+)/i;

  // React 18이 클릭 이벤트 처리 중 DOM을 업데이트하기 전에
  // capture phase에서 엘리먼트 텍스트를 미리 저장해둠
  const _preClickText = new WeakMap();
  const ECOMMERCE_SELECTOR = 'a, button, form, input, select, textarea, label, [role="button"]';

  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.(ECOMMERCE_SELECTOR) || e.target;
    if (el instanceof Element) {
      _preClickText.set(el, el.textContent?.trim() || '');
    }
  }, { capture: true });

  function textOf(el) {
    // capture phase에서 저장한 텍스트 우선 사용 (React re-render 전 값)
    return _preClickText.get(el) || (el?.textContent || el?.innerText || '').trim();
  }

  function matchesPatterns(el, patterns) {
    const text  = textOf(el);
    const label = el?.getAttribute?.('aria-label') || '';
    return patterns.some((p) => p.test(text) || p.test(label));
  }

  function hasClass(el, keywords) {
    const cls = (typeof el?.className === 'string' ? el.className : '').toLowerCase();
    return keywords.some((k) => cls.includes(k));
  }

  // product_id를 DOM 맥락 / URL에서 추론
  function inferProductId(el) {
    const fromParent = el?.closest?.('[data-product-id]')?.dataset?.productId;
    if (fromParent) return fromParent;
    const match = window.location.pathname.match(PRODUCT_HREF);
    if (match) return match[1];
    const params = new URLSearchParams(window.location.search);
    return params.get('product_id') || params.get('id') || null;
  }

  // 클릭된 엘리먼트로부터 이커머스 이벤트 추론
  function inferEcommerceEvent(target) {
    if (!(target instanceof Element)) return null;
    // PostHog autocapture 방식: 7종 엘리먼트까지 탐색 (form·label 추가)
    const el   = target.closest('a, button, form, input, select, textarea, label, [role="button"]') || target;
    const href = el.getAttribute?.('href') || '';

    // add_to_cart
    if (
      matchesPatterns(el, ADD_TO_CART_TEXT) ||
      hasClass(el, ['add-to-cart', 'add_to_cart', 'addtocart', 'btn-cart', 'cart-add'])
    ) {
      // 상품명: 버튼 근처 heading → 페이지 h1 순으로 탐색
      const nameEl =
        el.closest('[data-product-name]')?.dataset.productName ||
        el.closest('section,article,div')?.querySelector('h1,h2,h3,h4')?.textContent?.trim() ||
        document.querySelector('h1')?.textContent?.trim() ||
        null;
      return {
        type: 'add_to_cart',
        data: { product_id: inferProductId(el), product_name: nameEl ? String(nameEl).slice(0, 80) : null, quantity: 1, inferred: true },
      };
    }

    // remove_from_cart (결정장애형 핵심 신호) — 3단계 감지
    if (isRemoveFromCart(el)) {
      return {
        type: 'remove_from_cart',
        data: { product_id: inferProductId(el), quantity: 1, inferred: true },
      };
    }

    // purchase_click
    if (
      matchesPatterns(el, PURCHASE_TEXT) ||
      PURCHASE_HREF.some((p) => href.includes(p))
    ) {
      return {
        type: 'purchase_click',
        data: { product_id: inferProductId(el), inferred: true },
      };
    }

    // product_click — href URL 패턴
    if (el.tagName === 'A' && PRODUCT_HREF.test(href)) {
      const m = href.match(PRODUCT_HREF);
      // 가격 혼입 방지: heading → p 순으로 첫 번째 텍스트 요소만 사용
      const nameEl = el.querySelector('h1,h2,h3,h4,h5,h6,p');
      const productName = (nameEl?.textContent?.trim() || textOf(el)).slice(0, 80) || null;
      return {
        type: 'product_click',
        data: {
          product_id:   m ? m[1] : null,
          product_name: productName,
          ghost_role:   'inferred_link',
          inferred:     true,
        },
      };
    }

    // product_click — schema.org 마이크로데이터 또는 card class
    const card = el.closest(
      '[itemtype*="Product"], [class*="product-card"], [class*="product-item"], [class*="ProductCard"]'
    );
    if (card) {
      return {
        type: 'product_click',
        data: {
          product_id:   inferProductId(el),
          product_name: (
            card.querySelector('[itemprop="name"]')?.textContent?.trim() ||
            card.querySelector('h2,h3,h4')?.textContent?.trim() ||
            null
          )?.slice(0, 80),
          ghost_role:   'inferred_card',
          inferred:     true,
        },
      };
    }

    return null;
  }

  // ── click 이벤트 (위임) ───────────────────────────────────
  document.addEventListener('click', (e) => {
    // Layer 1: 명시적 마킹 (확정 이벤트)
    const el = e.target?.closest('[data-ghost-role]');
    if (el) {
      const role      = el.dataset.ghostRole;
      const productId = el.dataset.productId || el.closest('[data-product-id]')?.dataset.productId || null;

      switch (role) {
        case 'product-card':
        case 'product-link':
          handleRawEvent('product_click', {
            product_id:   productId,
            product_name: el.dataset.productName || el.textContent?.trim().slice(0, 80) || null,
            ghost_role:   role,
          });
          return;

        case 'add-to-cart':
          handleRawEvent('add_to_cart', {
            product_id:   productId,
            product_name: el.dataset.productName || null,
            quantity:     Number(el.dataset.quantity) || 1,
          });
          return;

        case 'remove-from-cart':
          handleRawEvent('remove_from_cart', {
            product_id: productId,
            quantity:   Number(el.dataset.quantity) || 1,
          });
          return;

        case 'purchase-btn':
          handleRawEvent('purchase_click', { product_id: productId });
          return;
      }
    }

    // Layer 2: 휴리스틱 추론 fallback (inferred: true)
    const inferred = inferEcommerceEvent(e.target);
    if (inferred) {
      handleRawEvent(inferred.type, inferred.data);
    }
  });

  // ── change 이벤트 (select/input 변경) ───────────────────
  document.addEventListener('change', (e) => {
    const el   = e.target?.closest('[data-ghost-role]');
    if (!el) return;

    const role      = el.dataset.ghostRole;
    const productId = el.dataset.productId || el.closest('[data-product-id]')?.dataset.productId || null;

    if (role === 'option-select') {
      handleRawEvent('option_select', {
        product_id:    productId,
        option_name:   el.name || el.dataset.optionName || null,
        option_value:  el.value,
      });

      // option_change: 같은 select 반복 변경 감지
      const prev = optionChangeCounts.get(el) || { count: 0, lastValue: null };
      if (prev.lastValue !== null && prev.lastValue !== el.value) {
        prev.count += 1;
        handleRawEvent('option_change', {
          product_id:    productId,
          option_name:   el.name || el.dataset.optionName || null,
          option_value:  el.value,
          change_count:  prev.count,
        });
      }
      optionChangeCounts.set(el, { count: prev.count, lastValue: el.value });
    }

    if (role === 'quantity-input') {
      handleRawEvent('quantity_change', {
        product_id: productId,
        quantity:   Number(el.value) || 0,
        prev_quantity: Number(el.dataset.prevQuantity) || null,
      });
      el.dataset.prevQuantity = el.value;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// REVIEW TRACKING
//
//   1. review_click       — 개별 리뷰 아이템 클릭 (텍스트/작성자/별점 영역)
//   2. review_page_change — 리뷰 페이지네이션 / 더보기 버튼 클릭
//   3. review_scroll      — 리뷰 섹션이 뷰포트에 보이는 동안 페이지 스크롤
//   4. review_area_scroll — overflow scroll 리뷰 패널·모달 내부 스크롤
//   5. review_image_click — 리뷰 이미지 클릭 (사진 후기)
//
//   휴리스틱 우선순위:
//     [data-ghost-role="review-section/review-item"] 명시 마킹 > CSS 클래스/id 추론
// ─────────────────────────────────────────────────────────────

function _initReviewTracking(handleRawEvent) {
  // ── 리뷰 컨테이너 선택자 (섹션/패널 전체) ─────────────────
  const REVIEW_CONTAINER_SEL = [
    '[data-ghost-role="review-section"]',
    '[data-section="review"]', '[data-section="reviews"]',
    '[id*="review"]', '[id*="Review"]', '[id*="후기"]', '[id*="리뷰"]',
    '[class*="review-section"]', '[class*="review_section"]',
    '[class*="review-list"]',   '[class*="review_list"]',
    '[class*="review-wrap"]',   '[class*="review_wrap"]',
    '[class*="review-area"]',   '[class*="review_area"]',
    '[class*="후기-wrap"]',     '[class*="후기_wrap"]',
    '[class*="리뷰-wrap"]',     '[class*="리뷰_wrap"]',
    '[class*="product-review"]','[class*="product_review"]',
    '[class*="user-review"]',   '[class*="user_review"]',
    '[class*="customer-review"]',
  ].join(',');

  // ── 개별 리뷰 아이템 선택자 ──────────────────────────────
  const REVIEW_ITEM_SEL = [
    '[data-ghost-role="review-item"]',
    '[class*="review-item"]',  '[class*="review_item"]',
    '[class*="review-card"]',  '[class*="review_card"]',
    '[class*="review-content"]','[class*="review_content"]',
    '[class*="review-row"]',   '[class*="review_row"]',
    '[class*="후기-item"]',    '[class*="후기_item"]',
    '[class*="리뷰-item"]',    '[class*="리뷰_item"]',
  ].join(',');

  // ── 페이지네이션 컨테이너 선택자 ─────────────────────────
  const PAGINATION_CTX_SEL = [
    '[class*="pagination"]', '[class*="paging"]',
    '[role="navigation"]',   '[aria-label*="페이지"]',
    '[aria-label*="pagination"]',
  ].join(',');

  // 페이지 이동 텍스트 패턴
  const LOAD_MORE_RE  = /더\s*보기|더\s*불러오기|load\s*more|show\s*more|see\s*more/i;
  const PREV_NEXT_RE  = /^(이전|다음|prev(ious)?|next|◀|▶|‹|›|«|»|←|→|<|>)$/i;

  // ── 유틸 ─────────────────────────────────────────────────
  function inReviewContainer(el) {
    return !!(el?.closest?.(REVIEW_CONTAINER_SEL));
  }

  // 리뷰 아이템의 별점 정보 추출 (있으면 함께 전송)
  function extractRating(el) {
    const item = el?.closest?.(REVIEW_ITEM_SEL) || el?.closest?.(REVIEW_CONTAINER_SEL);
    if (!item) return null;
    const ratingEl = item.querySelector(
      '[class*="star"], [class*="rating"], [class*="score"], ' +
      '[aria-label*="stars"], [aria-label*="점"], [data-rating]'
    );
    if (!ratingEl) return null;
    return (
      ratingEl.dataset.rating ||
      ratingEl.getAttribute('aria-label') ||
      ratingEl.textContent?.trim() ||
      null
    );
  }

  // ── 뷰포트 내 리뷰 섹션 가시 여부 (review_scroll용) ──────
  let _reviewInViewport = false;

  function observeReviewContainers() {
    const containers = document.querySelectorAll(REVIEW_CONTAINER_SEL);
    if (!containers.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) _reviewInViewport = true;
        });
        // 전부 화면 밖으로 나갔는지 재확인
        if (!entries.some((e) => e.isIntersecting)) {
          _reviewInViewport = [...document.querySelectorAll(REVIEW_CONTAINER_SEL)].some(
            (el) => {
              const r = el.getBoundingClientRect();
              return r.top < window.innerHeight && r.bottom > 0;
            }
          );
        }
      },
      { threshold: [0.05] }   // 5% 이상 보이면 활성
    );

    containers.forEach((el) => io.observe(el));
  }

  // ── 1·2·5. 클릭 이벤트 위임 ──────────────────────────────
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!inReviewContainer(target)) return;   // 리뷰 영역 외부 무시

    const btnText = (target.textContent || '').trim();

    // ── 5. review_image_click ─────────────────────────────
    const isImgEl = target.tagName === 'IMG' || target.tagName === 'PICTURE';
    const imgWrapper = !isImgEl && target.closest(
      'figure, [class*="photo"], [class*="image"], [class*="thumb"], [class*="gallery"]'
    );
    const wrappedImg = imgWrapper?.querySelector('img');

    if (isImgEl || wrappedImg) {
      const img = isImgEl ? target : wrappedImg;
      handleRawEvent('review_image_click', {
        src:      (img?.getAttribute('src') || '').slice(0, 200) || null,
        alt:      (img?.getAttribute('alt') || '').slice(0, 80)  || null,
        inferred: true,
      });
      return;
    }

    // ── 2. review_page_change ─────────────────────────────
    const inPaginationCtx = !!target.closest(PAGINATION_CTX_SEL);
    const isNumericPage   = /^\d+$/.test(btnText) && inPaginationCtx;

    if (
      inPaginationCtx ||
      isNumericPage   ||
      LOAD_MORE_RE.test(btnText) ||
      PREV_NEXT_RE.test(btnText)
    ) {
      let page_number = null;
      let direction   = null;
      if (/^\d+$/.test(btnText))        page_number = Number(btnText);
      else if (/이전|prev|◀|‹|«|←|</i.test(btnText)) direction = 'prev';
      else if (/다음|next|▶|›|»|→|>/i.test(btnText)) direction = 'next';
      else                               direction   = 'more';

      handleRawEvent('review_page_change', {
        page_number,
        direction,
        btn_text: btnText.slice(0, 20) || null,
        inferred: true,
      });
      return;
    }

    // ── 1. review_click ───────────────────────────────────
    // 개별 리뷰 아이템 내 클릭이면 전송
    const reviewItem = target.closest(REVIEW_ITEM_SEL);
    if (reviewItem) {
      handleRawEvent('review_click', {
        rating:   extractRating(target),
        inferred: true,
      });
    }
  });

  // ── 3. review_scroll: 뷰포트에 리뷰 보이는 동안 페이지 스크롤 ──
  let _reviewScrollTimer     = null;
  let _reviewScrollLastDepth = -1;

  window.addEventListener('scroll', () => {
    if (!_reviewInViewport) return;

    clearTimeout(_reviewScrollTimer);
    _reviewScrollTimer = setTimeout(() => {
      const docH = document.body.scrollHeight - window.innerHeight;
      const depth = docH > 0 ? Math.round((window.scrollY / docH) * 100) : 0;
      // 5% 이상 변화 시에만 emit (throttle)
      if (Math.abs(depth - _reviewScrollLastDepth) >= 5) {
        _reviewScrollLastDepth = depth;
        handleRawEvent('review_scroll', {
          scroll_y:  window.scrollY,
          depth_pct: depth,
          inferred:  true,
        });
      }
    }, 100);
  }, { passive: true });

  // ── 4. review_area_scroll: 리뷰 패널/모달 자체 스크롤 ─────
  function attachAreaScrollListeners() {
    document.querySelectorAll(REVIEW_CONTAINER_SEL).forEach((el) => {
      const style = window.getComputedStyle(el);
      const isScrollable =
        ['auto', 'scroll'].includes(style.overflow)   ||
        ['auto', 'scroll'].includes(style.overflowY);
      // 실제로 내용이 넘치는 경우에만 리스너 등록
      if (!isScrollable || el.scrollHeight <= el.clientHeight + 10) return;

      let _areaTimer    = null;
      let _lastScrollTop = el.scrollTop;

      el.addEventListener('scroll', () => {
        clearTimeout(_areaTimer);
        _areaTimer = setTimeout(() => {
          const scrollH = el.scrollHeight - el.clientHeight;
          const pct     = scrollH > 0 ? Math.round((el.scrollTop / scrollH) * 100) : 0;
          handleRawEvent('review_area_scroll', {
            scroll_top: el.scrollTop,
            depth_pct:  pct,
            direction:  el.scrollTop > _lastScrollTop ? 'down' : 'up',
            inferred:   true,
          });
          _lastScrollTop = el.scrollTop;
        }, 150);
      }, { passive: true });
    });
  }

  // DOM 준비 후 초기화
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      observeReviewContainers();
      attachAreaScrollListeners();
    });
  } else {
    observeReviewContainers();
    attachAreaScrollListeners();
  }
}
