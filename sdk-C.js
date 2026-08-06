/**
 * sdk-C.js — GhostTracker SDK 스크롤·섹션·이커머스 이벤트 수집
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

// C 모듈 초기화 — 스크롤·섹션·서브섹션·이커머스·리뷰 트래커를 순서대로 연결
export function initC(handleRawEvent) {
  if (typeof handleRawEvent !== 'function') {
    throw new Error('initC requires handleRawEvent function');
  }

  _initScrollTracking(handleRawEvent);
  _initSectionTracking(handleRawEvent);
  _initSubsectionTracking(handleRawEvent);
  _initEcommerceTracking(handleRawEvent);
  _initReviewTracking(handleRawEvent);

  // 초기화 로그는 남기지 않는다 — 남의 쇼핑몰 콘솔을 더럽히지 않기 위함
}

// ─────────────────────────────────────────────────────────────
// SCROLL TRACKING
// ─────────────────────────────────────────────────────────────

// 스크롤 depth·milestone·stop·방향 변화·속도를 감지한다
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

  // ── scroll_speed 억제 ──────────────────────────────────────
  //
  // 예전에는 스크롤 프레임마다 무조건 발생시켰다. 실측 결과 전체 수집
  // 이벤트의 59%(1553/2651)가 scroll_speed였다. scroll_depth가 153건인 것과
  // 비교하면 10배다.
  //
  // 이게 분석을 망가뜨린다. 세션 시퀀스를 만들면 토큰의 절반 이상이
  // 스크롤 노이즈라 모든 세션이 비슷해 보이고, 클러스터가 안 갈린다.
  // "클러스터링이 잘 안 된다"의 원인 중 하나다.
  //
  // 이제 일정 간격마다, 의미 있는 거리를 움직였을 때만 한 번 보낸다.
  // 구간 평균 속도라 개별 프레임 값보다 오히려 노이즈가 적다.
  const SPEED_EMIT_INTERVAL_MS = 1_000;  // 최소 1초 간격
  const SPEED_MIN_DISTANCE_PX  = 50;     // 이 정도는 움직여야 의미가 있다
  let speedWindowStart = Date.now();
  let speedWindowY     = 0;

  function detectSpeed() {
    const now = Date.now();
    const dt  = now - speedWindowStart;

    if (dt < SPEED_EMIT_INTERVAL_MS) return;

    const dy = Math.abs(window.scrollY - speedWindowY);

    // 다음 구간 기준점은 조건 충족 여부와 무관하게 갱신한다
    speedWindowStart = now;
    speedWindowY     = window.scrollY;
    lastTime         = now;

    if (dy < SPEED_MIN_DISTANCE_PX) return;   // 거의 안 움직였으면 기록할 게 없다

    handleRawEvent('scroll_speed', {
      speed:       Number((dy / dt).toFixed(3)),  // px/ms, 구간 평균
      distance_px: dy,
      duration_ms: dt,
    });
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
  }, { passive: true });
}

// ─────────────────────────────────────────────────────────────
// SECTION TRACKING
//   1순위: [data-section="..."] 명시적 마킹
//   2순위: HTML5 시맨틱 태그 자동 추론 (inferred: true)
// ─────────────────────────────────────────────────────────────

// 명시 마킹과 시맨틱 태그 추론으로 섹션 진입/이탈/재방문/전환을 추적한다
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
// SUBSECTION TRACKING
//   1순위: [data-subsection="..."] 명시적 마킹
//   2순위: id/class/aria/heading 키워드 기반 자동 감지 (data 속성 없어도 동작)
// dwell 시간 계산은 A(window.__GT)에 위임
// ─────────────────────────────────────────────────────────────

// data-subsection 요소를 IntersectionObserver로 감시해 enter/exit를 A bridge로 넘긴다 (dwell 계산은 A 담당)
function _initSubsectionTracking(handleRawEvent) {
  const visitCount = {};

  // 자동 감지 키워드 규칙 (section 보다 세분화된 의미 단위)
  const SUBSECTION_RULES = [
    { id: 'review',   re: /review|리뷰|후기|상품평|구매평|customer.?review/i },
    { id: 'shipping', re: /ship|delivery|배송|반품|교환|환불|return|refund/i },
    { id: 'size',     re: /size.?chart|사이즈|치수|실측|option.?size/i },
    { id: 'price',    re: /price|가격|할인|쿠폰|discount|coupon|benefit|sale/i },
    { id: 'qa',       re: /q&a|qna|문의|질문|faq/i },
  ];

  /** [data-subsection] 없어도 키워드로 서브섹션 ID 추론 */
  function inferSubsectionId(el) {
    if (el.dataset.subsection) return el.dataset.subsection;

    const className = typeof el.className === 'string' ? el.className : '';
    const heading   = el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent || '';
    const raw = [
      el.id || '',
      className,
      el.getAttribute('aria-label') || '',
      heading,
    ].join(' ');

    for (const rule of SUBSECTION_RULES) {
      if (rule.re.test(raw)) return rule.id;
    }
    return null;
  }

  /** 서브섹션 후보 요소 수집: 명시 마킹 + 키워드 매칭 block 요소 */
  function findCandidates() {
    const tagged = Array.from(document.querySelectorAll('[data-subsection]'));

    const inferred = Array.from(
      document.querySelectorAll('section, article, div, aside, ul, table')
    ).filter((el) => {
      if (el.dataset.subsection) return false; // 이미 tagged 처리
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) return false;
      return inferSubsectionId(el) !== null;
    });

    return [...tagged, ...inferred];
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const id = inferSubsectionId(entry.target);
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
    findCandidates().forEach((el) => observer.observe(el));
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

// 명시 마킹(Layer 1)과 휴리스틱(Layer 2) 두 단계로 장바구니·구매·상품 이벤트를 잡는다
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
  //
  // 실측: Cafe24 장바구니의 삭제 버튼은 <a class="btnNormal btn_close">삭제</a>이고
  // 행(row)은 xans-record- / xans-order-normalbasket 클래스를 쓴다.
  // 아래 목록에 그 형태가 없어서 컨텍스트 판정에 실패했고, 텍스트가 정확히
  // "삭제"인데도 remove_from_cart가 한 건도 안 잡혔다.
  const CART_ITEM_SELECTOR = [
    '[class*="cart-item"]', '[class*="cart_item"]',
    '[class*="cart-product"]', '[class*="cart_product"]',
    '[class*="basket-item"]', '[class*="basket_item"]',
    '[class*="bag-item"]', '[class*="bag_item"]',
    '[class*="order-item"]', '[class*="order_item"]',
    '[class*="line-item"]', '[class*="lineitem"]',
    '[data-cart-item]', '[data-item-id]',
    // Cafe24 계열
    '[class*="xans-order"]', '[class*="xans-record"]',
  ].join(',');

  const REMOVE_GENERIC_TEXT = [
    /^(삭제|제거|지우기)$/,
    /^(remove|delete)$/i,
    // Cafe24 장바구니 상단의 일괄 삭제 버튼
    /^(선택|전체)\s*(삭제|제거)$/,
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
  //
  // 텍스트 후보는 textCandidates()를 쓴다. 예전에는 textOf + aria-label만 봐서
  // Cafe24 장바구니의 삭제 버튼을 놓쳤다:
  //   <a class="btnDelete"><img alt="삭제" src="btn_delete.gif"></a>
  // textContent가 빈 문자열이고 aria-label도 없어서 전부 미감지였다.
  function isRemoveFromCart(el) {
    const candidates = textCandidates(el);   // 텍스트 + aria-label + title + img alt
    const ariaLabel  = el.getAttribute?.('aria-label') || '';

    // Level 1: 명시적 — 컨텍스트 불필요
    if (
      REMOVE_EXPLICIT_TEXT.some((p) => candidates.some((t) => p.test(t))) ||
      hasClass(el, REMOVE_EXPLICIT_CLASS) ||
      REMOVE_EXPLICIT_ARIA.some((p) => p.test(ariaLabel))
    ) return true;

    // Level 2: 일반 — cart item 컨텍스트 필수 (오탐 방지)
    //
    // 클래스 이름은 쇼핑몰마다 제각각이라 목록만으로는 한계가 있다.
    // Layer 0가 "지금 이 페이지는 장바구니"라고 알려주면 그 자체가 컨텍스트다.
    // 장바구니 화면에서 "삭제"를 눌렀다면 담은 상품을 빼는 것이 맞다.
    const onCartPage = window.__GT?.platformPageType?.() === 'CART';
    const inCartCtx  = onCartPage || !!el.closest(CART_ITEM_SELECTOR);
    if (!inCartCtx) return false;

    // 2a. 일반 삭제 텍스트 (정확히 매치)
    if (REMOVE_GENERIC_TEXT.some((p) => candidates.some((t) => p.test(t)))) return true;

    // 2b. X / × 아이콘 텍스트
    if (candidates.some((t) => X_ICON_RE.test(t))) return true;

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
    // Cafe24 기본 스킨 버튼은 "바로 구매" / "바로구매"라 기존 패턴에 안 걸렸다
    /바로\s*구매/i, /^구매$/i, /즉시\s*구매/i, /지금\s*구매/i,
    // Cafe24 장바구니 하단 주문 버튼: "전체상품주문" / "선택상품주문"
    // "주문내역"·"주문조회" 같은 조회 메뉴가 걸리지 않게 '상품주문' 형태로 좁힌다
    /상품\s*주문/i, /^주문$/i,
  ];
  // 주소만 보고 "구매 의사"로 판정할 수 있는 경로.
  //
  // 예전에는 '/order'가 들어 있었는데 너무 넓었다. Cafe24 기준으로
  //   /order/basket.html        → 장바구니 (구매 아님)
  //   /myshop/order/list.html   → 주문 조회 (구매 아님)
  // 둘 다 '/order'를 포함해서 헤더 메뉴만 눌러도 purchase_click이 찍혔다.
  // 실제 결제 진행 경로만 남긴다.
  const PURCHASE_HREF = ['/checkout', '/purchase', '/pay', '/orderform', '/order/order.html'];

  // 장바구니 "페이지로 이동"하는 링크 — 담기가 아니라 이동이다
  const CART_PAGE_HREF = ['/order/basket', '/cart', '/basket'];
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

  /**
   * 엘리먼트가 "말하고 있는" 모든 텍스트 후보를 모은다.
   *
   * 예전에는 textContent와 aria-label만 봤다. 그런데 Cafe24 기본 스킨은
   * 이미지 버튼을 쓴다:
   *   <a href="..."><img alt="장바구니 담기" src="btn_list_cart.gif"></a>
   *   <a href="javascript:;"><img alt="up" src="btn_count_up.gif"></a>
   * textContent는 빈 문자열이고 aria-label도 없어서 전부 미감지였다.
   *
   * img alt / title / value까지 후보에 넣으면 이미지 버튼 쇼핑몰 전반이
   * 함께 해결된다 (Cafe24 전용 대응이 아니다).
   */
  function textCandidates(el) {
    if (!el) return [];

    const out = [textOf(el)];

    try {
      const attr = (name) => el.getAttribute?.(name) || '';
      out.push(attr('aria-label'), attr('title'), attr('alt'), attr('value'));

      // 자식 이미지의 alt/title — 이미지 버튼의 실제 의미가 여기 있다
      el.querySelectorAll?.('img, svg title').forEach((child) => {
        out.push(child.getAttribute?.('alt') || '', child.textContent || '');
      });
    } catch {
      /* DOM 접근 실패는 무시하고 있는 후보만 쓴다 */
    }

    return out.map((t) => String(t || '').trim()).filter(Boolean);
  }

  function matchesPatterns(el, patterns) {
    const candidates = textCandidates(el);
    return patterns.some((p) => candidates.some((text) => p.test(text)));
  }

  function hasClass(el, keywords) {
    const cls = (typeof el?.className === 'string' ? el.className : '').toLowerCase();
    return keywords.some((k) => cls.includes(k));
  }

  /**
   * 링크 주소에서 상품 번호를 뽑는다.
   *
   * 실측 결과 Cafe24 상품 링크는 두 형태다.
   *   /product/데일리-케이블-조직-니트-풀오버/18/category/1/display/10/
   *   /product/detail.html?product_no=20&cate_no=1
   *
   * 예전에는 첫 세그먼트를 그대로 ID로 썼다. 그래서 목록에서 상품을 클릭하면
   * product_id가 "데일리-케이블-조직-니트-풀오버"(한글 슬러그)로 기록되고,
   * 같은 상품을 상세에서 담으면 "18"로 기록돼 서로 다른 상품처럼 보였다.
   *
   * 슬러그 다음 세그먼트가 숫자면 그게 상품 번호다.
   */
  function productIdFromHref(href) {
    const raw = String(href || '');
    if (!raw) return null;

    // 쿼리 파라미터 우선 (detail.html?product_no=20)
    const q = raw.split('?')[1] || '';
    const byParam = new URLSearchParams(q).get('product_no')
                 || new URLSearchParams(q).get('product_id')
                 || new URLSearchParams(q).get('goods_no');
    if (byParam) return byParam;

    const path = raw.split('?')[0];
    const seg = path.split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });

    const idx = seg.findIndex((s) => /^(product|item|goods|shop|p)$/i.test(s));
    if (idx === -1) return null;

    // /product/{슬러그}/{번호}/... → 번호를 쓴다
    if (/^\d+$/.test(seg[idx + 2] || '')) return seg[idx + 2];
    // /product/{번호}/...
    if (/^\d+$/.test(seg[idx + 1] || '')) return seg[idx + 1];

    const slug = seg[idx + 1] || '';
    // detail.html 같은 파일명은 ID가 아니다
    if (!slug || /\.\w{2,5}$/.test(slug)) return null;
    return slug;
  }

  // product_id 확보 — Layer 0(플랫폼 확정값) → DOM 마킹 → URL 추론 순
  function inferProductId(el) {
    // Layer 0: Cafe24 등이 meta로 알려주는 확정값이 있으면 그게 정답이다.
    // URL 정규식은 SEO URL에서 퍼센트 인코딩된 한글 슬러그를 잡아버린다.
    const fromPlatform = window.__GT?.platformProductId?.();
    if (fromPlatform) return fromPlatform;

    const fromParent = el?.closest?.('[data-product-id]')?.dataset?.productId;
    if (fromParent) return fromParent;

    const match = window.location.pathname.match(PRODUCT_HREF);
    if (match) {
      const seg = decodeURIComponent(match[1]);
      // /product/{슬러그}/{상품번호}/... 형태면 다음 세그먼트가 진짜 ID다
      const next = window.location.pathname.split('/').filter(Boolean);
      const idx  = next.findIndex((s) => decodeURIComponent(s) === seg);
      if (idx >= 0 && /^\d+$/.test(next[idx + 1] || '')) return next[idx + 1];
      // 파일명(detail.html 등)을 ID로 쓰지 않는다
      if (!/\.\w{2,5}$/.test(seg)) return seg;
    }

    const params = new URLSearchParams(window.location.search);
    return params.get('product_no')      // Cafe24
        || params.get('product_id')
        || params.get('goods_no')        // 고도몰
        || params.get('id')
        || null;
  }

  // 클릭된 엘리먼트로부터 이커머스 이벤트 추론
  function inferEcommerceEvent(target) {
    if (!(target instanceof Element)) return null;
    // PostHog autocapture 방식: 7종 엘리먼트까지 탐색 (form·label 추가)
    const el   = target.closest('a, button, form, input, select, textarea, label, [role="button"]') || target;
    const href = el.getAttribute?.('href') || '';

    // 헤더의 "장바구니(3)" 같은 링크는 담기가 아니라 페이지 이동이다.
    // 텍스트에 "장바구니"가 들어가서 add_to_cart로 잡히고 있었다.
    // 담기 의도가 명시된 문구("담기", "add to cart")가 없으면 이동으로 본다.
    const goesToCartPage = CART_PAGE_HREF.some((p) => href.includes(p));
    const saysAddExplicitly = matchesPatterns(el, [/담기/i, /add\s*to\s*(cart|bag|basket)/i, /카트에?\s*추가/i]);
    if (goesToCartPage && !saysAddExplicitly) return null;

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
      // 이미지 링크면 텍스트가 없으니 img alt가 상품명이다
      const productName = (
        nameEl?.textContent?.trim()
        || el.querySelector('img')?.getAttribute('alt')
        || textOf(el)
      ).slice(0, 80) || null;
      return {
        type: 'product_click',
        data: {
          // 슬러그가 아니라 실제 상품 번호를 쓴다
          product_id:   productIdFromHref(href) || (m ? m[1] : null),
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
  //
  // Layer 2 fallback이 click에는 있는데 change에는 없어서, data-ghost-role
  // 마킹이 없는 쇼핑몰에서는 option_select / quantity_change가 0건이었다.
  // Cafe24 기본 스킨에 그런 마킹이 있을 리 없으니 사실상 전부 미수집이었다.
  //
  // 옵션 반복 변경("사이즈를 다섯 번 바꾸다 이탈")은 결정장애형 고객을
  // 가르는 핵심 신호라, 이게 비면 클러스터링에서 유형이 안 갈린다.

  /** 마킹 없는 select/input이 옵션 선택인지 휴리스틱으로 판정 */
  function inferOptionField(el) {
    if (!(el instanceof Element)) return null;

    const name = String(el.getAttribute?.('name') || '').toLowerCase();
    const id   = String(el.id || '').toLowerCase();
    const cls  = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const hay  = `${name} ${id} ${cls}`;

    // 수량 입력 — Cafe24는 name="quantity", 일반적으로 qty/수량
    const isQuantity =
      /quantity|qty|수량|amount|ea_/.test(hay) ||
      (el.tagName === 'INPUT' && el.type === 'number');
    if (isQuantity) return 'quantity';

    // 옵션 선택 — Cafe24는 product_option_id1 / option1 형태
    const isOption =
      el.tagName === 'SELECT' ||
      /option|opt_|사이즈|색상|size|color/.test(hay);
    if (isOption) return 'option';

    return null;
  }

  document.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const marked = target.closest?.('[data-ghost-role]');

    // Layer 1: 명시 마킹이 있으면 그대로 신뢰
    // Layer 2: 없으면 휴리스틱으로 역할을 추론 (inferred: true로 구분)
    let el, role, inferred = false;
    if (marked) {
      el   = marked;
      role = marked.dataset.ghostRole;
    } else {
      const kind = inferOptionField(target);
      if (!kind) return;
      el   = target;
      role = kind === 'quantity' ? 'quantity-input' : 'option-select';
      inferred = true;
    }

    const productId = el.dataset?.productId
      || el.closest('[data-product-id]')?.dataset.productId
      || (window.__GT?.platformProductId?.() ?? null);

    if (role === 'option-select') {
      handleRawEvent('option_select', {
        product_id:    productId,
        option_name:   el.name || el.dataset?.optionName || null,
        option_value:  el.value,
        ...(inferred && { inferred: true }),
      });

      // option_change: 같은 select 반복 변경 감지
      const prev = optionChangeCounts.get(el) || { count: 0, lastValue: null };
      if (prev.lastValue !== null && prev.lastValue !== el.value) {
        prev.count += 1;
        handleRawEvent('option_change', {
          product_id:    productId,
          option_name:   el.name || el.dataset?.optionName || null,
          option_value:  el.value,
          change_count:  prev.count,
          ...(inferred && { inferred: true }),
        });
      }
      optionChangeCounts.set(el, { count: prev.count, lastValue: el.value });
    }

    if (role === 'quantity-input') {
      handleRawEvent('quantity_change', {
        product_id: productId,
        quantity:   Number(el.value) || 0,
        prev_quantity: Number(el.dataset?.prevQuantity) || null,
        ...(inferred && { inferred: true }),
      });
      if (el.dataset) el.dataset.prevQuantity = el.value;
    }
  });

  // ── 수량 +/- 버튼 (click 기반) ─────────────────────────────
  //
  // Cafe24 수량 조절은 select가 아니라 이미지 링크다:
  //   <a href="javascript:;"><img alt="up" src="btn_count_up.gif"></a>
  // change 이벤트가 아예 발생하지 않으므로 click으로 잡아야 한다.
  const QTY_UP_TEXT   = [/^up$/i, /증가/, /플러스/, /^\+$/, /수량\s*증가/];
  const QTY_DOWN_TEXT = [/^down$/i, /감소/, /마이너스/, /^-$/, /^−$/, /수량\s*감소/];

  // 실측: Cafe24 장바구니 수량 버튼은 <a class="up"> / <a class="down">이고
  // 안에 든 이미지의 alt가 비어 있는 스킨도 있다. alt만 믿으면 스킨에 따라 깨진다.
  // 클래스도 함께 보되, 아래에서 "수량 입력칸이 같은 영역에 있을 것"을 요구해
  // 임의의 up/down 클래스가 잘못 걸리지 않게 한다.
  const QTY_UP_CLASS   = ['up', 'quantityup', 'quantity-up', 'btn-up', 'plus', 'increase', 'btncountup'];
  const QTY_DOWN_CLASS = ['down', 'quantitydown', 'quantity-down', 'btn-down', 'minus', 'decrease', 'btncountdown'];

  // 클래스 토큰이 정확히 일치하는지 검사 (부분 문자열이면 'group'이 'up'에 걸린다)
  function hasClassToken(el, tokens) {
    const cls = (typeof el?.className === 'string' ? el.className : '').toLowerCase();
    const parts = cls.split(/[\s_-]+/).filter(Boolean);
    return tokens.some((t) => parts.includes(t) || cls.replace(/[\s_-]/g, '') === t);
  }

  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('a, button, [role="button"]');
    if (!el) return;

    // 이미 다른 이커머스 이벤트로 잡히는 버튼이면 건너뛴다
    if (matchesPatterns(el, ADD_TO_CART_TEXT) || matchesPatterns(el, PURCHASE_TEXT)) return;

    const byTextUp   = matchesPatterns(el, QTY_UP_TEXT);
    const byTextDown = matchesPatterns(el, QTY_DOWN_TEXT);
    const byClassUp   = hasClassToken(el, QTY_UP_CLASS);
    const byClassDown = hasClassToken(el, QTY_DOWN_CLASS);

    const isUp   = byTextUp   || byClassUp;
    const isDown = byTextDown || byClassDown;
    if (!isUp && !isDown) return;

    // 수량 맥락 안의 버튼인지 확인 (임의의 +/- 버튼 오탐 방지)
    const scope = el.closest('[class*="quantity"], [class*="qty"], [class*="count"], [class*="product"], form, tr, li');
    if (!scope) return;

    // 클래스만으로 판단한 경우에는 같은 영역에 수량 입력칸이 있어야 인정한다.
    // 'up'/'down' 같은 짧은 클래스가 다른 용도로 쓰이는 걸 걸러낸다.
    const hasQtyInput = !!scope.querySelector('input[name*="quantity" i], input[name*="qty" i], input[type="number"]');
    if (!byTextUp && !byTextDown && !hasQtyInput) return;

    const input = scope.querySelector('input[name*="quantity" i], input[name*="qty" i], input[type="number"]');

    // 장바구니에는 상품이 여러 개라 페이지 단위 ID가 없다.
    // 같은 행 안의 상품 링크에서 어떤 상품의 수량인지 찾아낸다.
    const rowLink = scope.querySelector('a[href*="/product/"]')?.getAttribute('href');

    handleRawEvent('quantity_change', {
      product_id: window.__GT?.platformProductId?.()
                  ?? productIdFromHref(rowLink)
                  ?? inferProductId(el),
      direction:  isUp ? 'up' : 'down',
      quantity:   input ? Number(input.value) || null : null,
      inferred:   true,
    });
  }, { passive: true });
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

// 리뷰 영역 클릭·페이지 이동·페이지 스크롤·패널 내부 스크롤을 한 곳에서 감지한다
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
