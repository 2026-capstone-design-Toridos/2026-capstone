// sdk-B.js
// 역할:
// - 클릭 / 마우스이동 / 입력 / 포커스 / 붙여넣기 / 탭 이탈·복귀 / hover dwell / 미디어 / 검색
// - raw 이벤트만 감지해서 handleRawEvent(eventType, data)로 전달
// - session_id, event_seq, timestamp, 파생 이벤트 생성은 A가 담당

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

  console.log('[GhostTracker] sdk-B initialized');
}

/* =========================
   공통 유틸
========================= */

function isFormElement(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

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

function getFormValueLength(target) {
  if (!isFormElement(target)) return 0;
  if (typeof target.value !== 'string') return 0;
  return target.value.length;
}

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

  // ── image_zoom: img 위에서 wheel 이벤트 ──
  document.addEventListener('wheel', (e) => {
    const img = e.target?.closest('img') || (e.target?.tagName === 'IMG' ? e.target : null);
    if (!img) return;
    handleRawEvent('image_zoom', {
      zoom_direction: e.deltaY < 0 ? 'in' : 'out',
      image_src:      img.src?.split('?')[0]?.split('/').pop() || 'unknown',
    });
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

function trackSearch(handleRawEvent) {
  const DEBOUNCE_MS = 300;
  const timers = new WeakMap();  // input element → timer id

  const SEARCH_SELECTOR = [
    'input[type="search"]',
    'input[role="searchbox"]',
    '[role="searchbox"]',
    '[data-ghost-role="search-input"]',
  ].join(',');

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.matches(SEARCH_SELECTOR)) return;

    // debounce
    if (timers.has(target)) clearTimeout(timers.get(target));
    timers.set(
      target,
      setTimeout(() => {
        timers.delete(target);
        handleRawEvent('search_use', {
          search_length: typeof target.value === 'string' ? target.value.length : 0,
          input_name:    target.name || null,
          ghost_role:    target.dataset?.ghostRole || null,
        });
      }, DEBOUNCE_MS)
    );
  });
}
