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
import { recordPageEnter, resetPageTimers, getPageDwellTime, getLastEventTime, onInactive, getPendingInactivity } from './core/timeTracker.js';
import { emit, emitSessionEnd, setActivityCallback } from './core/eventProcessor.js';
import { flush, configureSender } from './core/sender.js';

// ── 내부 상태 ─────────────────────────────────────────────────
let _initialized = false;
let _navigationPath = [];
let _sessionEnded   = false;
let _hasInteracted  = false;                // 클릭/터치 등 실제 상호작용 여부 (bounce 판정용)
let _subsectionEnterTimes = {};             // subsection_id → enter timestamp
let _resizeTimer = null;
let _lastNavPathname  = null;               // BUG-01: navigation 중복 dedup용
let _lastNavTimestamp = 0;                  // BUG-01: 동일 tick 내 중복 호출 방지

// ── 세션 TTL 타이머 (30분 비활성 → session_end + 자동 새 세션) ──
const SESSION_TTL_MS = 30 * 60 * 1000;     // 30분
let _sessionTTLTimer = null;

// ── 초기화 ────────────────────────────────────────────────────

function initA(options = {}) {
  if (_initialized) return;
  _initialized = true;

  // sender 설정 주입 (collectUrl, flushInterval, maxBufferSize)
  if (options.sender) {
    configureSender(options.sender);
  }

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

  // BUG-08: pageContext(page_url, pathname, utm_*, device_type 등)는 모든 이벤트에
  // 자동으로 붙으므로, session_start data에는 세션 고유 필드만 담는다.
  emit('session_start', {
    session_id:     sessionCtx.session_id,
    is_new_session: sessionCtx.is_new_session,
    is_returning:   sessionCtx.is_returning,
    session_count:  sessionCtx.session_count,
    visit_time:     sessionCtx.visit_time,
    referrer:       sessionCtx.referrer,
  });

  _setupNavigationTracking();
  _setupSessionEnd();
  _setupInactivityTracking();
  _setupInteractionTracking();
  _setupScreenResize();
  _setupGTBridge();

  // 30분 TTL 타이머 시작 + 활동 콜백 등록
  setActivityCallback(_onUserActivity);
  _resetSessionTTLTimer();
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
    const prevPathname = window.location.pathname;
    origPush(...args);
    _onNavigation('push', prevPathname);
  };

  history.replaceState = function (...args) {
    const prevPathname = window.location.pathname;
    origReplace(...args);
    _onNavigation('replace', prevPathname);
  };

  window.addEventListener('popstate', () => _onNavigation('pop', null));
}

function _onNavigation(trigger, prevPathname = null) {
  const pathname = window.location.pathname;
  const now      = Date.now();

  // BUG-01: Next.js가 pushState 직후 replaceState를 자동 호출해 중복 emit 발생.
  // 동일 pathname으로 100ms 이내 재호출이면 무시한다.
  if (pathname === _lastNavPathname && now - _lastNavTimestamp < 100) return;
  _lastNavPathname  = pathname;
  _lastNavTimestamp = now;

  _navigationPath.push(pathname);
  updatePageUrl();
  resetPageTimers();          // SPA 페이지 이동 시 dwell 시간 리셋

  // 페이지 이동 시 상태 초기화
  _hasInteracted = false;
  _subsectionEnterTimes = {};

  emit('navigation', {
    navigation_path:  [..._navigationPath],
    page_depth:       _navigationPath.length,
    current_pathname: pathname,
    prev_pathname:    prevPathname,
    nav_trigger:      trigger,
  });
}

// ── 세션 종료 감지 ───────────────────────────────────────────
//
// BUG-02: beforeunload/pagehide만으로는 Next.js + Chrome 환경에서
//         sendBeacon 전송이 보장되지 않음.
// 보완: visibilitychange → hidden 시 즉시 flush (탭 전환/닫기 모두 커버).
//       beforeunload/pagehide는 fallback으로 유지.

function _setupSessionEnd() {
  const _buildExitPayload = () => ({
    exit_page:             window.location.pathname,
    page_dwell_time:       getPageDwellTime(),
    last_event_time:       getLastEventTime(),
    bounce_flag:           _navigationPath.length === 1 && !_hasInteracted,
    last_viewport_scrollY: window.scrollY,
    navigation_path:       [..._navigationPath],
    page_depth:            _navigationPath.length,
  });

  // 완전 종료 (탭 닫기, 새로고침): session_end emit 후 flush
  const handleSessionEnd = () => {
    if (_sessionEnded) return;
    _sessionEnded = true;
    touchSessionTimestamp();
    emitSessionEnd(_buildExitPayload());
    flush(true);
  };

  window.addEventListener('beforeunload', handleSessionEnd);
  window.addEventListener('pagehide',     handleSessionEnd);

  // 탭 숨김 (다른 탭으로 전환, 모바일 앱 전환 등): 버퍼에 쌓인 이벤트 즉시 전송
  // session_end는 emit하지 않음 — 사용자가 돌아올 수 있으므로
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !_sessionEnded) {
      flush(true);
    }
  });
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
  if (!window.__GT) window.__GT = {};

  Object.assign(window.__GT, {
    // C(IIFE)의 로컬 send()를 이것으로 교체하면 A 코어와 연결됨
    //   function send(eventType, payload) { window.__GT?.emit(eventType, payload); }
    emit,

    // subsection dwell: C의 IntersectionObserver가 진입/이탈 시 호출
    subsectionEnter: (subsection_id) => {
      if (!subsection_id) return;
      _subsectionEnterTimes[subsection_id] = Date.now();
      emit('subsection_enter', { subsection_id });
    },

    subsectionExit: (subsection_id) => {
      if (!subsection_id) return;
      const enterTime = _subsectionEnterTimes[subsection_id];
      if (!enterTime) return;
      const dwell_ms = Date.now() - enterTime;
      delete _subsectionEnterTimes[subsection_id];
      emit('subsection_exit',  { subsection_id });
      emit('subsection_dwell', { subsection_id, dwell_ms });
    },

    // 디버깅용
    getState: () => ({
      navigationPath: [..._navigationPath],
      hasInteracted:  _hasInteracted,
      sessionEnded:   _sessionEnded,
    }),
  });
}

// ── 세션 TTL 타이머 ───────────────────────────────────────────
//
// 30분 동안 사용자 활동이 없으면 session_end를 자동 발생시키고,
// 다음 활동 시 새 세션을 자동으로 시작한다.
//
// 흐름:
//   활동 발생 → _onUserActivity() → 타이머 리셋
//   30분 경과 → _onSessionTTLExpired() → session_end emit + localStorage 클리어
//   다음 활동 → _onUserActivity() → _sessionEnded 감지 → _restartSession() → 새 세션 시작

function _resetSessionTTLTimer() {
  clearTimeout(_sessionTTLTimer);
  _sessionTTLTimer = setTimeout(_onSessionTTLExpired, SESSION_TTL_MS);
}

function _onUserActivity() {
  // 이전 세션이 TTL 만료로 종료됐으면 새 세션 시작
  if (_sessionEnded) {
    _restartSession();
  }
  _resetSessionTTLTimer();
}

function _onSessionTTLExpired() {
  if (_sessionEnded) return;
  _sessionEnded = true;

  // session_end 발생 (exit_reason: timeout)
  emitSessionEnd({
    exit_page:             window.location.pathname,
    page_dwell_time:       getPageDwellTime(),
    last_event_time:       getLastEventTime(),
    bounce_flag:           _navigationPath.length === 1 && !_hasInteracted,
    exit_reason:           'timeout',
    navigation_path:       [..._navigationPath],
    page_depth:            _navigationPath.length,
  });
  flush(true);

  // localStorage 세션 키 제거 → 다음 initSession() 호출 시 새 UUID 발급
  localStorage.removeItem('gt_sid');
  localStorage.removeItem('gt_sid_ts');
}

function _restartSession() {
  // 먼저 플래그 리셋 (emit 내부에서 재진입 방지)
  _sessionEnded = false;
  _hasInteracted = false;
  _subsectionEnterTimes = {};
  _navigationPath = [window.location.pathname];

  // 새 세션 발급 (gt_sid가 없으므로 새 UUID 생성)
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

  emit('session_start', {
    session_id:     sessionCtx.session_id,
    is_new_session: sessionCtx.is_new_session,
    is_returning:   sessionCtx.is_returning,
    session_count:  sessionCtx.session_count,
    visit_time:     sessionCtx.visit_time,
    referrer:       sessionCtx.referrer,
  });
}

export { initA, emit };
