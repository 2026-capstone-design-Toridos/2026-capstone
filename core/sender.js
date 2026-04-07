/**
 * sender.js  —  A 담당
 *
 * 역할: 가공된 이벤트를 서버로 전송
 *
 * ── 전송 전략 ─────────────────────────────────────────────────
 *  일반 flush (주기 / 버퍼 초과):
 *    fetch() — 응답 처리 가능, keepalive 불필요
 *
 *  unload flush (beforeunload / pagehide):
 *    sendBeacon() 우선 → 실패(큐 포화) 시 fetch(keepalive: true) fallback
 *    이유: sendBeacon은 탭이 닫혀도 전송 보장되지만 일반 상황에서는
 *          응답 처리가 불가하고 Content-Type 제한이 있어 평상시엔 fetch가 낫다.
 *
 * BE 연결점: POST /collect  —  body: { events: [...] }
 * ────────────────────────────────────────────────────────────────
 */

const COLLECT_URL    = '/collect';
const FLUSH_INTERVAL = 5_000; // 5초마다 자동 플러시
const MAX_BUFFER_SIZE = 30;   // 버퍼 최대 크기 (초과 시 즉시 플러시)

let _buffer = [];
let _flushTimer = null;

// ── 공개 API ──────────────────────────────────────────────────

/**
 * 이벤트를 버퍼에 추가. 버퍼 초과 시 즉시 일반 flush.
 * @param {object} event
 */
function send(event) {
  _buffer.push(event);

  if (_buffer.length >= MAX_BUFFER_SIZE) {
    flush(false);
    return;
  }

  if (_flushTimer === null) {
    _flushTimer = setTimeout(() => flush(false), FLUSH_INTERVAL);
  }
}

/**
 * 버퍼를 즉시 서버로 전송
 * @param {boolean} isUnload  true = unload 계열 (sendBeacon 우선)
 *                            false = 일반 주기/초과 flush (fetch)
 */
function flush(isUnload = false) {
  clearTimeout(_flushTimer);
  _flushTimer = null;

  if (_buffer.length === 0) return;

  const payload = JSON.stringify({ events: _buffer });
  _buffer = [];

  if (isUnload) {
    _sendBeaconOrFetch(payload);
  } else {
    _sendFetch(payload);
  }
}

// ── 내부 헬퍼 ────────────────────────────────────────────────

/** 일반 전송 — 응답 추적 가능, 탭 닫힘 보장 불필요 */
function _sendFetch(payload) {
  fetch(COLLECT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    payload,
  }).catch(() => {
    // 전송 실패 시 조용히 무시 (호스트 쇼핑몰에 에러 노출 방지)
  });
}

/** unload 전송 — sendBeacon 우선, 실패 시 fetch keepalive */
function _sendBeaconOrFetch(payload) {
  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'application/json' });
    if (navigator.sendBeacon(COLLECT_URL, blob)) return;
    // sendBeacon 큐 포화(false 반환) → fallback
  }
  fetch(COLLECT_URL, {
    method:    'POST',
    headers:   { 'Content-Type': 'application/json' },
    body:      payload,
    keepalive: true,
  }).catch(() => {});
}

export { send, flush };
