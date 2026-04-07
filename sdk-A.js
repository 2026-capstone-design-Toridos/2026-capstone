/**
 * sdk-A.js  —  A 담당 (조현)
 *
 * 역할: Core Engine 초기화 + 세션/환경/페이지이동 수집
 *
 * 수집 이벤트 (21개):
 *   세션/페이지: session_id, page_url, pathname, referrer, utm_source, utm_campaign,
 *               visit_time, is_returning
 *   시간:        page_dwell_time, time_to_first_click, inactivity, last_event_time
 *   페이지이동:  navigation_path, page_depth, exit_page, bounce_flag
 *   환경:        device_type, screen_width, os_type, browser_type
 *   시퀀스/공통: event_seq, event_token, inter_event_gap  (eventProcessor 자동 처리)
 *
 * ── window.__GT bridge ──────────────────────────────────────────
 * C 모듈(IIFE)은 import를 쓸 수 없으므로 window.__GT를 통해 A와 통신.
 *   window.__GT.subsectionEnter(id)  — C의 IntersectionObserver가 진입 시 호출
 *   window.__GT.subsectionExit(id)   — C의 IntersectionObserver가 이탈 시 호출
 * A가 시간을 계산해 subsection_dwell 이벤트를 emit.
 * ────────────────────────────────────────────────────────────────
 */

import { initSession, setPageContext, updatePageUrl, touchSessionTimestamp } from './core/sessionManager.js';
import { recordPageEnter, getPageDwellTime, getLastEventTime, onInactive, getPendingInactivity } from './core/timeTracker.js';
import { emit, emitSessionEnd } from './core/eventProcessor.js';
import { flush } from './core/sender.js';

// ── 내부 상태 ─────────────────────────────────────────────────
let _navigationPath = [];
let _sessionEnded   = false;
let _hasInteracted  = false;                // 클릭/터치 등 실제 상호작용 여부 (bounce 판정용)
let _subsectionEnterTimes = {};             // subsection_id → enter timestamp
let _resizeTimer = null;

// ── 초기화 ────────────────────────────────────────────────────

function initA() {
  const sessionCtx = initSession();
  const envInfo    = _collectEnv();

  setPageContext({
    page_url:     sessionCtx.page_url,
    pathname:     sessionCtx.pathname,
    referrer:     sessionCtx.referrer,
    utm_source:   sessionCtx.utm_source,
    utm_campaign: sessionCtx.utm_campaign,
    ...envInfo,
  });

  recordPageEnter();
  _navigationPath.push(window.location.pathname);

  emit('session_start', {
    ...sessionCtx,
    ...envInfo,
  });

  _setupNavigationTracking();
  _setupSessionEnd();
  _setupInactivityTracking();
  _setupInteractionTracking();
  _setupScreenResize();
  _setupGTBridge();
}

// ── 환경 정보 수집 ────────────────────────────────────────────

function _collectEnv() {
  const ua = navigator.userAgent;
  return {
    device_type:  _getDeviceType(ua),
    screen_width: window.innerWidth,
    os_type:      _getOS(ua),
    browser_type: _getBrowser(ua),
  };
}

function _getDeviceType(ua) {
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

function _getOS(ua) {
  if (/Windows/i.test(ua))          return 'windows';
  if (/Mac OS X/i.test(ua))         return 'macos';
  if (/Android/i.test(ua))          return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Linux/i.test(ua))            return 'linux';
  return 'unknown';
}

function _getBrowser(ua) {
  if (/Edg\//i.test(ua))     return 'edge';
  if (/OPR\//i.test(ua))     return 'opera';
  if (/Chrome\//i.test(ua))  return 'chrome';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Safari\//i.test(ua))  return 'safari';
  return 'unknown';
}

// ── SPA 내비게이션 추적 ───────────────────────────────────────

function _setupNavigationTracking() {
  const origPush    = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);

  history.pushState = function (...args) {
    origPush(...args);
    _onNavigation('push');
  };

  history.replaceState = function (...args) {
    origReplace(...args);
    _onNavigation('replace');
  };

  window.addEventListener('popstate', () => _onNavigation('pop'));
}

function _onNavigation(trigger) {
  const pathname = window.location.pathname;
  _navigationPath.push(pathname);
  updatePageUrl();

  emit('navigation', {
    navigation_path:  [..._navigationPath],
    page_depth:       _navigationPath.length,
    current_pathname: pathname,
    nav_trigger:      trigger,
  });
}

// ── 세션 종료 감지 ───────────────────────────────────────────

function _setupSessionEnd() {
  const handleSessionEnd = () => {
    if (_sessionEnded) return;
    _sessionEnded = true;

    touchSessionTimestamp();

    emitSessionEnd({
      exit_page:             window.location.pathname,
      page_dwell_time:       getPageDwellTime(),
      last_event_time:       getLastEventTime(),
      // bounce: 한 페이지에서 상호작용 없이 이탈
      // has_interacted 기준을 함께 봐야 진짜 bounce 판별 가능
      bounce_flag:           _navigationPath.length === 1 && !_hasInteracted,
      last_viewport_scrollY: window.scrollY,
      navigation_path:       [..._navigationPath],
      page_depth:            _navigationPath.length,
    });

    flush(true);
  };

  window.addEventListener('beforeunload', handleSessionEnd);
  window.addEventListener('pagehide',     handleSessionEnd);
}

// ── 비활성 감지 ───────────────────────────────────────────────

function _setupInactivityTracking() {
  // 비활성이 끝나는 시점(다음 활동)에 호출됨 → duration 값 확정 후 emit
  onInactive(({ inactivity_start_time, inactivity_duration }) => {
    emit('inactivity', {
      inactivity_start_time,
      inactivity_duration,
    });
  });
}

// ── 상호작용 감지 (bounce_flag 정확도 향상) ───────────────────
//
// 단순 스크롤도 "상호작용"으로 간주하지 않음.
// click / touchstart 기준으로 실제 의도적 상호작용만 추적.

function _setupInteractionTracking() {
  const markInteracted = () => { _hasInteracted = true; };
  document.addEventListener('click',      markInteracted, { once: true, passive: true });
  document.addEventListener('touchstart', markInteracted, { once: true, passive: true });
}

// ── 화면 크기 변화 감지 ───────────────────────────────────────
//
// 리사이즈는 연속으로 발생하므로 500ms debounce.

function _setupScreenResize() {
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      emit('screen_resize', {
        screen_width:  window.innerWidth,
        screen_height: window.innerHeight,
      });
    }, 500);
  });
}

// ── window.__GT bridge ───────────────────────────────────────
//
// C(IIFE)는 ES 모듈 import를 쓸 수 없어서 직접 emit을 받지 못함.
// window.__GT를 통해 A와 통신 → A가 subsection_dwell 시간을 계산해 emit.
//
// C의 IntersectionObserver에서 이렇게 호출:
//   window.__GT?.subsectionEnter('review')
//   window.__GT?.subsectionExit('review')

function _setupGTBridge() {
  window.__GT = window.__GT || {};

  // C(IIFE)의 로컬 send()를 이것으로 교체하면 A 코어와 연결됨
  //   function send(eventType, payload) { window.__GT?.emit(eventType, payload); }
  window.__GT.emit = emit;

  // subsection dwell: C의 IntersectionObserver가 진입/이탈 시 호출
  window.__GT.subsectionEnter = (subsection_id) => {
    _subsectionEnterTimes[subsection_id] = Date.now();
    emit('subsection_enter', { subsection_id });
  };

  window.__GT.subsectionExit = (subsection_id) => {
    const enterTime = _subsectionEnterTimes[subsection_id];
    if (!enterTime) return;
    const dwell_ms = Date.now() - enterTime;
    delete _subsectionEnterTimes[subsection_id];
    emit('subsection_dwell', { subsection_id, dwell_ms });
  };

  // 디버깅용
  window.__GT.getState = () => ({
    navigationPath: [..._navigationPath],
    hasInteracted:  _hasInteracted,
    sessionEnded:   _sessionEnded,
  });
}

export { initA, emit };
