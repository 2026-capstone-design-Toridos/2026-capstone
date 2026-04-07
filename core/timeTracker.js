/**
 * timeTracker.js  —  A 담당
 *
 * 역할: 시간 기반 지표 계산
 *   page_dwell_time, time_to_first_click, last_event_time, inactivity
 *
 * ── inactivity 처리 방식 (A안 채택) ─────────────────────────────
 *  타이머 발화 시점 = 비활성이 시작된 순간 (inactivity_start).
 *  그 순간의 inactivity_duration은 의미 있는 값이 아니므로 계산하지 않는다.
 *  대신 callback에 { startTime, lastEventTime }을 넘긴다.
 *
 *  AI/분석 시:
 *    실제 비활성 지속 시간 = session_end.timestamp - inactivity_start_time
 *    또는 다음 이벤트.timestamp - inactivity_start_time으로 역산 가능.
 *
 *  B안(타이머 종료 후 duration 계산)을 쓰지 않은 이유:
 *    비활성 중에도 언제 시작됐는지가 더 유용한 정보이고,
 *    타이머를 중첩 관리하면 복잡도가 높아지기 때문.
 * ────────────────────────────────────────────────────────────────
 */

const INACTIVITY_THRESHOLD_MS = 10_000; // 10초 비활성 = 이탈 전조

let _pageEnterTime  = null;
let _firstClickTime = null;
let _lastEventTime  = null;
let _inactivityTimer = null;
let _onInactiveCallback = null;

/**
 * 페이지 진입 시각 기록 (sdk-A 초기화 시 호출)
 */
function recordPageEnter() {
  _pageEnterTime = Date.now();
  _lastEventTime = _pageEnterTime;
  _resetInactivityTimer();
}

/**
 * 이벤트 발생 시마다 호출 — last_event_time 갱신 + inactivity 타이머 리셋
 * 세션 종료(emitSessionEnd)는 활동으로 보지 않으므로 그곳에선 호출하지 않는다.
 */
function recordActivity() {
  _lastEventTime = Date.now();
  _resetInactivityTimer();
}

/**
 * 첫 번째 클릭 시각 기록 (한 번만 저장)
 * @returns {number|null} time_to_first_click (ms), 이미 기록됐으면 null
 */
function recordFirstClick() {
  if (_firstClickTime !== null) return null;
  _firstClickTime = Date.now();
  return _firstClickTime - _pageEnterTime;
}

/**
 * beforeunload 시 호출 — 전체 체류 시간 반환
 * @returns {number} page_dwell_time (ms)
 */
function getPageDwellTime() {
  if (_pageEnterTime === null) return 0;
  return Date.now() - _pageEnterTime;
}

/** @returns {number|null} last_event_time */
function getLastEventTime() {
  return _lastEventTime;
}

/**
 * 비활성 콜백 등록
 * callback({ startTime: number, lastEventTime: number }) 형태로 호출됨
 * @param {function} callback
 */
function onInactive(callback) {
  _onInactiveCallback = callback;
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────

function _resetInactivityTimer() {
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => {
    // 타이머 발화 = 비활성 시작 시점
    const startTime = Date.now();
    if (_onInactiveCallback) {
      _onInactiveCallback({ startTime, lastEventTime: _lastEventTime });
    }
  }, INACTIVITY_THRESHOLD_MS);
}

export {
  recordPageEnter,
  recordActivity,
  recordFirstClick,
  getPageDwellTime,
  getLastEventTime,
  onInactive,
};
