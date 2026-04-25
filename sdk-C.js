/**
 * sdk-C.js  —  C 담당 (김다민)
 *
 * 역할: 스크롤 / 섹션 / 서브섹션 / 이커머스 이벤트 수집
 *   - scroll: depth, milestone, stop, direction_change, speed
 *   - section: enter, exit, revisit, transition
 *   - subsection: enter, exit, dwell (시간계산 A에 위임), revisit
 *   - ecommerce: product_click, option_select, option_change,
 *                quantity_change, add_to_cart, remove_from_cart, purchase_click
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
  const visitCount     = {};
  let lastSection      = null;
  let autoIndex        = 0;

  // 시맨틱 태그에서 섹션 이름 추론
  function inferSectionName(el) {
    const tag     = el.tagName.toLowerCase();
    // 고정 태그 이름 우선
    if (['header', 'nav', 'main', 'footer', 'aside'].includes(tag)) return tag;
    // 첫 번째 heading 텍스트 사용
    const heading = el.querySelector('h1,h2,h3,h4,h5,h6');
    if (heading?.textContent?.trim()) {
      return heading.textContent.trim()
        .slice(0, 40)
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_가-힣]/g, '');
    }
    // fallback: section_0, article_1 …
    return `${tag}_${autoIndex++}`;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const el         = entry.target;
        const id         = el.dataset.section || el.dataset.ghostSectionInferred;
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
              handleRawEvent('section_transition', { from: lastSection, to: id });
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
    { threshold: [0.3] }
  );

  function initSectionObserver() {
    // 1. 명시적 마킹 먼저
    document.querySelectorAll('[data-section]').forEach((el) => observer.observe(el));

    // 2. 마킹 없는 HTML5 시맨틱 태그 자동 추론
    const SEMANTIC_TAGS = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'];
    document.querySelectorAll(SEMANTIC_TAGS.join(','))
      .forEach((el) => {
        if (el.dataset.section) return;            // 이미 마킹 있으면 skip
        el.dataset.ghostSectionInferred = inferSectionName(el);
        observer.observe(el);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSectionObserver);
  } else {
    initSectionObserver();
  }
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
