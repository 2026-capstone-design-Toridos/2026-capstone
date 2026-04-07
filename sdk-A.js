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
 */

import { initSession, setPageContext, updatePageUrl, touchSessionTimestamp } from './core/sessionManager.js';
import { recordPageEnter, getPageDwellTime, getLastEventTime, onInactive } from './core/timeTracker.js';
import { emit, emitSessionEnd } from './core/eventProcessor.js';
import { flush } from './core/sender.js';

// ── 내부 상태 ─────────────────────────────────────────────────
let _navigationPath = [];
let _sessionEnded   = false;

// ── 초기화 ────────────────────────────────────────────────────

function initA() {
  const sessionCtx = initSession();
  const envInfo    = _collectEnv();

  // 공통 페이지/환경 문맥을 sessionManager에 등록
  // → eventProcessor._dispatch()가 모든 이벤트에 자동으로 붙임
  setPageContext({
    page_url:    sessionCtx.page_url,
    pathname:    sessionCtx.pathname,
    referrer:    sessionCtx.referrer,
    utm_source:  sessionCtx.utm_source,
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
  if (/Windows/i.test(ua))         return 'windows';
  if (/Mac OS X/i.test(ua))        return 'macos';
  if (/Android/i.test(ua))         return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Linux/i.test(ua))           return 'linux';
  return 'unknown';
}

function _getBrowser(ua) {
  if (/Edg\//i.test(ua))    return 'edge';
  if (/OPR\//i.test(ua))    return 'opera';
  if (/Chrome\//i.test(ua)) return 'chrome';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'unknown';
}

// ── SPA 내비게이션 추적 ───────────────────────────────────────
//
// pushState / replaceState / popstate 세 가지를 모두 가로챔.
// replaceState: Next.js 등에서 scroll 복원이나 shallow routing 시 사용.
//   이를 빠뜨리면 navigation_path가 누락되는 경우가 생김.

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
  updatePageUrl(); // sessionManager의 page_url / pathname 갱신

  emit('navigation', {
    navigation_path:  [..._navigationPath],
    page_depth:       _navigationPath.length,
    current_pathname: pathname,
    nav_trigger:      trigger, // push | replace | pop
  });
}

// ── 세션 종료 감지 ───────────────────────────────────────────
//
// beforeunload: 데스크탑 탭 닫기 / 주소창 이동
// pagehide:     iOS Safari는 beforeunload 신뢰 불가 → pagehide 필수
//
// visibilitychange(hidden)은 탭 전환이지 세션 종료가 아니므로 제외.
//   탭 전환은 B 모듈의 tab_exit가 담당.
//   여기서 쓰면 _sessionEnded 가드가 잠겨서 실제 탭 닫힘 이벤트가 유실됨.
//
// _sessionEnded 가드: beforeunload와 pagehide가 모두 발화할 수 있으므로 한 번만 처리.

function _setupSessionEnd() {
  const handleSessionEnd = () => {
    if (_sessionEnded) return;
    _sessionEnded = true;

    touchSessionTimestamp(); // TTL 갱신 (다음 방문이 30분 이내면 동일 세션)

    emitSessionEnd({
      exit_page:             window.location.pathname,
      page_dwell_time:       getPageDwellTime(),
      last_event_time:       getLastEventTime(),
      bounce_flag:           _navigationPath.length === 1,
      last_viewport_scrollY: window.scrollY,
      navigation_path:       [..._navigationPath],
      page_depth:            _navigationPath.length,
    });

    flush(true); // unload flush → sendBeacon 우선
  };

  window.addEventListener('beforeunload', handleSessionEnd);
  window.addEventListener('pagehide',     handleSessionEnd);
}

// ── 비활성 감지 ───────────────────────────────────────────────

function _setupInactivityTracking() {
  // timeTracker.js는 { startTime, lastEventTime }을 넘겨줌 (A안)
  // inactivity_start_time: 비활성이 시작된 시각
  // last_event_time:       바로 직전 마지막 실제 활동 시각
  // 실제 비활성 지속 시간은 AI가 (session_end.timestamp - inactivity_start_time)으로 계산
  onInactive(({ startTime, lastEventTime }) => {
    emit('inactivity', {
      inactivity_start_time: startTime,
      last_event_time:       lastEventTime,
    });
  });
}

export { initA, emit };
