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

    detectDirection(depth);
    detectSpeed();
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
// SECTION TRACKING  [data-section="..."]
// ─────────────────────────────────────────────────────────────

function _initSectionTracking(handleRawEvent) {
  const activeSections = new Set();
  const visitCount     = {};
  let lastSection      = null;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const id = entry.target.dataset.section;
        if (!id) return;

        if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
          if (!activeSections.has(id)) {
            activeSections.add(id);

            handleRawEvent('section_enter', { section: id });

            visitCount[id] = (visitCount[id] || 0) + 1;
            if (visitCount[id] > 1) {
              handleRawEvent('section_revisit', { section: id, count: visitCount[id] });
            }

            if (lastSection && lastSection !== id) {
              handleRawEvent('section_transition', { from: lastSection, to: id });
            }
            lastSection = id;
          }
        } else if (!entry.isIntersecting) {
          if (activeSections.has(id)) {
            activeSections.delete(id);
            handleRawEvent('section_exit', { section: id });
          }
        }
      });
    },
    { threshold: [0.3] }
  );

  function initSectionObserver() {
    document.querySelectorAll('[data-section]').forEach((el) => observer.observe(el));
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
          handleRawEvent('subsection_exit', { subsection_id: id });
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
// ECOMMERCE TRACKING  [data-ghost-role="..."]
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

  // ── click 이벤트 (위임) ───────────────────────────────────
  document.addEventListener('click', (e) => {
    const el   = e.target?.closest('[data-ghost-role]');
    if (!el) return;

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
        break;

      case 'add-to-cart':
        handleRawEvent('add_to_cart', {
          product_id:   productId,
          product_name: el.dataset.productName || null,
          quantity:     Number(el.dataset.quantity) || 1,
        });
        break;

      case 'remove-from-cart':
        handleRawEvent('remove_from_cart', {
          product_id: productId,
          quantity:   Number(el.dataset.quantity) || 1,
        });
        break;

      case 'purchase-btn':
        handleRawEvent('purchase_click', {
          product_id: productId,
        });
        break;
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
