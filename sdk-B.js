/**
 * sdk-B.js — GhostTracker SDK 상호작용 이벤트 수집
 *
 * 역할: 클릭·마우스이동·입력·포커스·붙여넣기·탭이탈·hover·미디어·검색을 raw로 감지
 *
 * 감지만 하고 handleRawEvent(eventType, data)로 넘김.
 * event_seq·timestamp·파생 이벤트 생성은 A(eventProcessor)가 담당.
 * 이 파일에서 emit()을 직접 호출하지 않는다.
 */

let isInitialized = false;

const state = {
  clickCount: 0,
  tabExitCount: 0,
  hoverStartMap: new WeakMap(),
  fieldFocusCountMap: new WeakMap(),
  tabHiddenAt: null,

  // mouse_move: 2초 주기 누적
  mouseLastX: null,
  mouseLastY: null,
  mouseTotalDistance: 0,
  mouseJitterCount: 0,
  mouseLastDir: null,          // 방향 변화 횟수
  mouseTimer: null,

  // video watch pct
  videoWatchedPct: new WeakMap(),  // HTMLVideoElement → Set<number>
};

// 모든 B 트래커를 초기화한다 — 중복 init 방지 후 각 트래킹 함수를 순서대로 연결
export function initB(handleRawEvent) {
  if (isInitialized) return;
  if (typeof handleRawEvent !== 'function') {
    throw new Error('initB requires handleRawEvent function');
  }

  isInitialized = true;

  trackClicks(handleRawEvent);
  trackMouseMovement(handleRawEvent);
  trackInputs(handleRawEvent);
  trackFocusAndBlur(handleRawEvent);
  trackPaste(handleRawEvent);
  trackTabVisibility(handleRawEvent);
  trackHoverDwell(handleRawEvent);
  trackMedia(handleRawEvent);
  trackSearch(handleRawEvent);

  // 초기화 로그는 남기지 않는다 — 남의 쇼핑몰 콘솔을 더럽히지 않기 위함
}

/* =========================
   공통 유틸
========================= */

// input/textarea/select 여부 확인
function isFormElement(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

// 클릭된 요소에서 추적 가능한 가장 가까운 조상 요소를 찾는다
function getTrackableTarget(element) {
  if (!(element instanceof Element)) return null;
  return (
    element.closest(
      [
        '[data-ghost-role]',
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'label',
        "[role='button']",
      ].join(',')
    ) || element
  );
}

// tag#id.class 형태의 짧은 레이블 문자열을 만든다
function getElementLabel(element) {
  if (!(element instanceof Element)) return 'unknown';
  const tag = element.tagName ? element.tagName.toLowerCase() : 'unknown';
  const id  = element.id ? `#${element.id}` : '';
  let className = '';
  if (typeof element.className === 'string' && element.className.trim()) {
    className = '.' + element.className.trim().split(/\s+/).slice(0, 3).join('.');
  }
  return `${tag}${id}${className}`;
}

// 요소의 innerText나 value를 maxLength 글자로 잘라 반환
function getElementText(element, maxLength = 80) {
  if (!element) return '';
  const raw =
    typeof element.innerText === 'string'
      ? element.innerText
      : typeof element.value === 'string'
      ? element.value
      : '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// 폼 요소의 현재 입력 길이를 반환
function getFormValueLength(target) {
  if (!isFormElement(target)) return 0;
  if (typeof target.value !== 'string') return 0;
  return target.value.length;
}

// 폼 요소의 name·type·ghost_role 메타데이터를 묶어 반환
function getFormMeta(target) {
  if (!isFormElement(target)) {
    return { input_target: 'unknown', input_name: null, input_type: null, ghost_role: null };
  }
  return {
    input_target: getElementLabel(target),
    input_name:   target.name || null,
    input_type:   target.type || target.tagName.toLowerCase(),
    ghost_role:   target.dataset?.ghostRole || null,
  };
}

/* =========================
   클릭 + repeat_click
========================= */

// 전역 클릭을 가로채서 click 이벤트를 emit한다
function trackClicks(handleRawEvent) {
  document.addEventListener('click', (e) => {
    const target = getTrackableTarget(e.target);
    state.clickCount += 1;

    handleRawEvent('click', {
      click_count:    state.clickCount,
      click_target:   getElementLabel(target),
      click_text:     getElementText(target, 100),
      click_position: { x: e.clientX, y: e.clientY },
      tag_name:       target?.tagName?.toLowerCase() || null,
      ghost_role:     target?.dataset?.ghostRole || null,
    });

  });
}

/* =========================
   마우스 이동 (2초 주기)
========================= */

// 2초마다 마우스 이동 거리와 방향 전환 횟수를 누적해서 전송
function trackMouseMovement(handleRawEvent) {
  document.addEventListener('mousemove', (e) => {
    const x = e.clientX;
    const y = e.clientY;

    if (state.mouseLastX !== null && state.mouseLastY !== null) {
      const dx = x - state.mouseLastX;
      const dy = y - state.mouseLastY;
      state.mouseTotalDistance += Math.sqrt(dx * dx + dy * dy);

      // 방향 변화 감지 (jitter: x 또는 y 방향 반전)
      const dirX = dx > 0 ? 'r' : dx < 0 ? 'l' : null;
      const dirY = dy > 0 ? 'd' : dy < 0 ? 'u' : null;
      const dir  = `${dirX}${dirY}`;
      if (state.mouseLastDir && dir !== state.mouseLastDir) {
        state.mouseJitterCount += 1;
      }
      state.mouseLastDir = dir;
    }

    state.mouseLastX = x;
    state.mouseLastY = y;

    // 2초 타이머 (없으면 시작)
    if (!state.mouseTimer) {
      state.mouseTimer = setTimeout(() => {
        const dist  = Math.round(state.mouseTotalDistance);
        const jitter = state.mouseJitterCount;

        if (dist > 0) {
          handleRawEvent('mouse_move', {
            distance_px:  dist,
            jitter_count: jitter,
          });
        }

        // 상태 리셋
        state.mouseTotalDistance = 0;
        state.mouseJitterCount   = 0;
        state.mouseTimer         = null;
      }, 2_000);
    }
  });
}

/* =========================
   입력
========================= */

// 폼 요소 입력마다 input_change를 emit한다
function trackInputs(handleRawEvent) {
  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!isFormElement(target)) return;
    handleRawEvent('input_change', {
      ...getFormMeta(target),
      input_length: getFormValueLength(target),
    });
  });
}

/* =========================
   포커스 / 블러
========================= */

// 포커스·블러 시 field_focus/field_blur를, 빈 채로 blur하면 input_abandon도 emit
function trackFocusAndBlur(handleRawEvent) {
  document.addEventListener(
    'focus',
    (e) => {
      const target = e.target;
      if (!isFormElement(target)) return;
      const prevCount = state.fieldFocusCountMap.get(target) || 0;
      const nextCount = prevCount + 1;
      state.fieldFocusCountMap.set(target, nextCount);
      handleRawEvent('field_focus', {
        ...getFormMeta(target),
        field_refocus_count: Math.max(0, nextCount - 1),
      });
    },
    true
  );

  document.addEventListener(
    'blur',
    (e) => {
      const target = e.target;
      if (!isFormElement(target)) return;
      const valueLength = getFormValueLength(target);
      handleRawEvent('field_blur', {
        ...getFormMeta(target),
        input_length: valueLength,
      });
      if (valueLength === 0) {
        handleRawEvent('input_abandon', { ...getFormMeta(target) });
      }
    },
    true
  );
}

/* =========================
   붙여넣기
========================= */

// 폼 요소에 붙여넣기 하면 paste_event를 emit한다
function trackPaste(handleRawEvent) {
  document.addEventListener('paste', (e) => {
    const target = e.target;
    if (!isFormElement(target)) return;
    handleRawEvent('paste_event', { ...getFormMeta(target) });
  });
}

/* =========================
   탭 이탈 / 복귀
========================= */

// 탭 숨김/복귀를 감지해 tab_exit/tab_return을 emit한다
function trackTabVisibility(handleRawEvent) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.tabHiddenAt = Date.now();
      state.tabExitCount += 1;
      handleRawEvent('tab_exit', { tab_exit_count: state.tabExitCount });
      return;
    }
    const duration =
      typeof state.tabHiddenAt === 'number' ? Date.now() - state.tabHiddenAt : null;
    handleRawEvent('tab_return', { tab_exit_duration_ms: duration });
    state.tabHiddenAt = null;
  });
}

/* =========================
   Hover dwell (300ms 이상)
========================= */

// 300ms 이상 머문 hover를 감지해서 hover_dwell을 emit한다
function trackHoverDwell(handleRawEvent) {
  document.addEventListener(
    'mouseover',
    (e) => {
      const target = getTrackableTarget(e.target);
      if (!(target instanceof Element)) return;
      state.hoverStartMap.set(target, Date.now());
    },
    true
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      const target = getTrackableTarget(e.target);
      if (!(target instanceof Element)) return;
      const startTime = state.hoverStartMap.get(target);
      if (!startTime) return;
      state.hoverStartMap.delete(target);
      const dwellTime = Date.now() - startTime;
      if (dwellTime < 300) return;
      handleRawEvent('hover_dwell', {
        hover_target:       getElementLabel(target),
        hover_text:         getElementText(target, 100),
        hover_dwell_time_ms: dwellTime,
        ghost_role:         target.dataset?.ghostRole || null,
      });
    },
    true
  );
}

/* =========================
   미디어 (이미지 슬라이드 / 줌 / 동영상)
========================= */

// 이미지 슬라이드·줌, 동영상 재생·시청 진척을 감지한다
function trackMedia(handleRawEvent) {
  // ── image_slide: data-ghost-role="slide-prev" 또는 "slide-next" 버튼 클릭 ──
  document.addEventListener('click', (e) => {
    const role = e.target?.dataset?.ghostRole || e.target?.closest('[data-ghost-role]')?.dataset?.ghostRole;
    if (role === 'slide-prev' || role === 'slide-next') {
      handleRawEvent('image_slide', {
        direction:   role === 'slide-prev' ? 'prev' : 'next',
        slide_target: getElementLabel(e.target),
      });
    }
  });

  // ── image_zoom: img 위에서 wheel 이벤트 (BUG-05: debounce 추가) ──
  // wheel 이벤트는 연속 발생하므로 200ms debounce 후 마지막 방향만 전송.
  let _zoomTimer = null;
  let _zoomLastDir = null;
  document.addEventListener('wheel', (e) => {
    const img = e.target?.closest('img') || (e.target?.tagName === 'IMG' ? e.target : null);
    if (!img) return;
    _zoomLastDir = e.deltaY < 0 ? 'in' : 'out';
    clearTimeout(_zoomTimer);
    _zoomTimer = setTimeout(() => {
      handleRawEvent('image_zoom', {
        zoom_direction: _zoomLastDir,
        image_src:      img.src?.split('?')[0]?.split('/').pop() || 'unknown',
      });
      _zoomLastDir = null;
    }, 200);
  }, { passive: true });

  // ── video_play + video_watch_pct: capture phase ──
  document.addEventListener(
    'play',
    (e) => {
      if (!(e.target instanceof HTMLVideoElement)) return;
      handleRawEvent('video_play', {
        video_src:      e.target.src?.split('?')[0]?.split('/').pop() || 'unknown',
        video_duration: Math.round(e.target.duration) || null,
        current_time:   Math.round(e.target.currentTime),
      });
    },
    true
  );

  document.addEventListener(
    'timeupdate',
    (e) => {
      const video = e.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (!video.duration) return;

      const pct = Math.floor((video.currentTime / video.duration) * 10) * 10; // 10% 단위
      if (pct <= 0) return;

      let watched = state.videoWatchedPct.get(video);
      if (!watched) {
        watched = new Set();
        state.videoWatchedPct.set(video, watched);
      }
      if (!watched.has(pct)) {
        watched.add(pct);
        handleRawEvent('video_watch_pct', {
          watch_pct:      pct,
          video_src:      video.src?.split('?')[0]?.split('/').pop() || 'unknown',
          video_duration: Math.round(video.duration),
        });
      }
    },
    true
  );
}

/* =========================
   검색 입력 감지 (search_use)
========================= */

// 검색창을 명시 셀렉터 + 휴리스틱으로 찾아서 search_use를 300ms debounce 후 emit한다
function trackSearch(handleRawEvent) {
  const DEBOUNCE_MS = 300;
  const timers = new WeakMap();  // input element → timer id

  // ── 명시적 셀렉터 (inferred 없음) ────────────────────────────
  const SEARCH_SELECTOR = [
    'input[type="search"]',
    'input[role="searchbox"]',
    '[role="searchbox"]',
    '[data-ghost-role="search-input"]',
    // name 기반 (표준 검색 파라미터)
    'input[name="q"]',
    'input[name="s"]',
    'input[name="search"]',
    'input[name="keyword"]',
    'input[name="query"]',
    // placeholder/aria-label 기반
    'input[placeholder*="검색" i]',
    'input[placeholder*="search" i]',
    'input[placeholder*="찾기" i]',
    'input[placeholder*="find" i]',
    'input[aria-label*="검색" i]',
    'input[aria-label*="search" i]',
  ].join(',');

  // ── 휴리스틱 추론 (inferred: true) ───────────────────────────
  // id / class / 부모 form action 기반 — 오탐 가능성 있어 별도 처리
  function isSearchHeuristic(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type && el.type !== 'text') return false;
    const id  = (el.id  || '').toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const formAction = (el.closest('form')?.getAttribute('action') || '').toLowerCase();
    return (
      id.includes('search') ||
      cls.split(/\s+/).some((c) => c.includes('search')) ||
      formAction.includes('search')
    );
  }

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const isExplicit = target.matches(SEARCH_SELECTOR);
    const isInferred = !isExplicit && isSearchHeuristic(target);
    if (!isExplicit && !isInferred) return;

    // 이벤트 발생 시점에 즉시 캡처 (React가 300ms 안에 input 초기화할 수 있음)
    const capturedValue  = typeof target.value === 'string' ? target.value : '';
    const capturedLength = capturedValue.length;

    // BUG-FIX: 빈 값이면 clearTimeout도 하지 않음
    // React가 input 클리어할 때 발생하는 input 이벤트가 기존 타이머(실제 검색어)를 죽이는 문제 방지
    if (capturedLength === 0) return;

    if (timers.has(target)) clearTimeout(timers.get(target));
    timers.set(
      target,
      setTimeout(() => {
        timers.delete(target);
        handleRawEvent('search_use', {
          search_query:  capturedValue,
          search_length: capturedLength,
          input_name:    target.name || null,
          ghost_role:    target.dataset?.ghostRole || null,
          ...(isInferred && { inferred: true }),
        });
      }, DEBOUNCE_MS)
    );
  });
}