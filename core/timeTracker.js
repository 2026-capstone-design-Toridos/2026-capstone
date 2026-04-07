/**
 * timeTracker.js  —  A 담당
 *
 * 역할: 시간 기반 지표 계산
 *   page_dwell_time, time_to_first_click, inactivity_duration, last_event_time
 *
 * ── inactivity 처리 방식 ─────────────────────────────────────
 *  [비활성 시작] 10초 타이머 발화 → _inactivityStartTime 기록 (emit 안 함)
 *  [비활성 종료] 다음 recordActivity() 호출 시 duration 계산 → callback 실행
 *  [세션 종료]   비활성 중 세션이 끝나면 getPendingInactivity()로 flush
 *
 *  장점:
 *    - inactivity_duration 필드를 실제 값으로 스펙에 맞게 전송 가능
 *    - AI/BE 팀이 별도 역산 없이 바로 사용 가능
 * ────────────────────────────────────────────────────────────────
 */

const INACTIVITY_THRESHOLD_MS = 10_000; // 10초 비활성 = 이탈 전조

let _pageEnterTime      = null;
let _firstClickTime     = null;
let _lastEventTime      = null;
let _inactivityTimer    = null;
let _inactivityStartTime = null;   // 비활성 시작 시각 (타이머 발화 시 기록)
let _onInactiveCallback  = null;

/**
 * 페이지 진입 시각 기록 (sdk-A 초기화 시 호출)
 */
function recordPageEnter() {
  _pageEnterTime = Date.now();
  _lastEventTime = _pageEnterTime;
  _resetInactivityTimer();
}

/**
 * 이벤트 발생 시마다 호출
 *
 * 비활성 중이었다면 → inactivity_duration 계산 후 콜백 실행 (emit)
 * 항상             → last_event_time 갱신 + 비활성 타이머 리셋
 *
 * 세션 종료(emitSessionEnd)는 활동으로 보지 않으므로 그곳에선 호출하지 않는다.
 */
function recordActivity() {
  const now = Date.now();

  // 비활성 중이었다면 → 종료 시점에 duration 확정 후 callback
  if (_inactivityStartTime !== null) {
    const inactivity_duration = now - _inactivityStartTime;
    if (_onInactiveCallback) {
      _onInactiveCallback({
        inactivity_start_time: _inactivityStartTime,
        inactivity_duration,
      });
    }
    _inactivityStartTime = null;
  }

  _lastEventTime = now;
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
 * 비활성 중 세션이 종료될 때 eventProcessor.emitSessionEnd()에서 호출
 * 아직 emit 되지 않은 pending inactivity 데이터를 반환
 * @returns {{ inactivity_start_time: number, inactivity_duration: number } | null}
 */
function getPendingInactivity() {
  if (_inactivityStartTime === null) return null;
  return {
    inactivity_start_time: _inactivityStartTime,
    inactivity_duration:   Date.now() - _inactivityStartTime,
  };
}

/**
 * 비활성 종료 콜백 등록
 * callback({ inactivity_start_time: number, inactivity_duration: number })
 * @param {function} callback
 */
function onInactive(callback) {
  _onInactiveCallback = callback;
}

// ── 내부 헬퍼 ────────────────────────────────────────────────

function _resetInactivityTimer() {
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => {
    // emit 하지 않고 시작 시각만 기록 → 다음 recordActivity()가 duration 계산
    _inactivityStartTime = Date.now();
  }, INACTIVITY_THRESHOLD_MS);
}

export {
  recordPageEnter,
  recordActivity,
  recordFirstClick,
  getPageDwellTime,
  getLastEventTime,
  getPendingInactivity,
  onInactive,
};
