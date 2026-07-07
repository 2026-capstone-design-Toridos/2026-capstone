/**
 * sender.js — GhostTracker SDK 이벤트 전송 모듈
 *
 * 역할: eventProcessor가 만든 이벤트를 버퍼에 모아뒀다가 서버(/collect)로 보낸다
 *
 * ── 언제 뭘로 보내나 ───────────────────────────────────────────
 *  평소 (5초마다 자동 / 버퍼 30개 다 차면): fetch()로 전송
 *    → 응답 확인도 되고 평소엔 이게 더 안정적
 *
 *  탭 닫힘·새로고침 (beforeunload, pagehide): sendBeacon() 먼저 시도
 *    → 탭이 진짜 닫혀도 브라우저가 전송을 보장해주는 유일한 방법
 *    → 브라우저 큐가 가득 차서 sendBeacon이 실패하면 fetch(keepalive: true)로 한 번 더 시도
 *
 * 받는 쪽: POST /collect, body는 { events: [...] } 형태로 보냄
 * ────────────────────────────────────────────────────────────────
 */

let COLLECT_URL    = 'https://two026-capstone.onrender.com/collect';
let FLUSH_INTERVAL  = 5_000; // 5초마다 자동 플러시
let MAX_BUFFER_SIZE = 30;    // 버퍼 최대 크기 (초과 시 즉시 플러시)

let _buffer = [];
let _flushTimer = null;

/**
 * 전송 설정을 외부에서 주입할 때 사용 (initA의 options.sender로 전달)
 * @param {{ collectUrl?: string, flushInterval?: number, maxBufferSize?: number }} opts
 */
function configureSender({ collectUrl, flushInterval, maxBufferSize } = {}) {
  if (typeof collectUrl === 'string' && collectUrl.trim()) {
    COLLECT_URL = collectUrl.trim();
  }
  if (Number.isFinite(flushInterval) && flushInterval > 0) {
    FLUSH_INTERVAL = flushInterval;
  }
  if (Number.isFinite(maxBufferSize) && maxBufferSize > 0) {
    MAX_BUFFER_SIZE = maxBufferSize;
  }
}

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

// 일반 전송 — 응답 추적 가능, 탭 닫힘 보장 불필요 
function _sendFetch(payload) {
  fetch(COLLECT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    payload,
  }).catch(() => {
    // 전송 실패 시 조용히 무시 (호스트 쇼핑몰에 에러 노출 방지)
  });
}

// unload 전송 — sendBeacon 우선, 실패 시 fetch keepalive 
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

export { send, flush, configureSender };
