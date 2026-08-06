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
 * ── 실패하면 어떻게 되나 ───────────────────────────────────────
 *  예전에는 전송 직전에 버퍼를 비우고 .catch(() => {})로 삼켜서,
 *  한 번 실패한 이벤트가 그대로 사라졌다. 특히 Render 무료 플랜은
 *  유휴 상태에서 첫 요청에 30초 이상 걸려(콜드 스타트) 그동안의
 *  이벤트가 전량 유실됐다. 하필 그 구간이 "첫 방문자"다.
 *
 *  이제는:
 *    1. res.ok까지 확인한 뒤에야 성공으로 친다 (500도 실패로 잡는다)
 *    2. 실패한 배치는 재시도 큐에 넣고 지수 백오프로 다시 보낸다
 *    3. MAX_RETRIES를 넘기면 버린다 (무한 재시도로 서버를 때리지 않는다)
 *    4. 큐가 MAX_QUEUE_SIZE를 넘으면 오래된 것부터 버린다 (메모리 방어)
 *
 *  중복 저장은 이벤트마다 붙는 event_id로 서버에서 걸러낸다.
 *  재시도는 "저장은 됐는데 응답만 유실된" 경우를 구분할 수 없기 때문에,
 *  재시도와 중복 방지는 반드시 세트로 동작해야 한다.
 *
 * 받는 쪽: POST /collect, body는 { events: [...] } 형태로 보냄
 * ────────────────────────────────────────────────────────────────
 */

let COLLECT_URL     = 'https://two026-capstone.onrender.com/collect';
let FLUSH_INTERVAL  = 5_000; // 5초마다 자동 플러시
let MAX_BUFFER_SIZE = 30;    // 버퍼 최대 크기 (초과 시 즉시 플러시)

// ── 재시도 정책 ────────────────────────────────────────────────
let MAX_RETRIES    = 3;       // 배치당 최대 재시도 횟수
let RETRY_BASE_MS  = 1_000;   // 1s → 2s → 4s 지수 백오프
let MAX_QUEUE_SIZE = 200;     // 재시도 대기 이벤트 총량 상한

let _buffer = [];
let _flushTimer = null;

// 재시도 대기 배치 목록: [{ events, attempt }]
let _retryQueue = [];
let _retryTimer = null;

/**
 * 전송 설정을 외부에서 주입할 때 사용 (initA의 options.sender로 전달)
 * @param {{ collectUrl?: string, flushInterval?: number, maxBufferSize?: number,
 *           maxRetries?: number, retryBaseMs?: number, maxQueueSize?: number }} opts
 */
function configureSender({
  collectUrl, flushInterval, maxBufferSize,
  maxRetries, retryBaseMs, maxQueueSize,
} = {}) {
  if (typeof collectUrl === 'string' && collectUrl.trim()) {
    COLLECT_URL = collectUrl.trim();
  }
  if (Number.isFinite(flushInterval) && flushInterval > 0) {
    FLUSH_INTERVAL = flushInterval;
  }
  if (Number.isFinite(maxBufferSize) && maxBufferSize > 0) {
    MAX_BUFFER_SIZE = maxBufferSize;
  }
  if (Number.isFinite(maxRetries) && maxRetries >= 0) {
    MAX_RETRIES = maxRetries;
  }
  if (Number.isFinite(retryBaseMs) && retryBaseMs > 0) {
    RETRY_BASE_MS = retryBaseMs;
  }
  if (Number.isFinite(maxQueueSize) && maxQueueSize > 0) {
    MAX_QUEUE_SIZE = maxQueueSize;
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

  if (isUnload) {
    // 창이 닫히는 중이라 재시도 기회가 없다.
    // 재시도 대기 중이던 것까지 전부 모아 마지막으로 한 번 던진다.
    const pending = _drainRetryQueue();
    const events  = [...pending, ..._buffer];
    _buffer = [];

    if (events.length === 0) return;

    const payload = _serialize(events);
    if (payload !== null) _sendBeaconOrFetch(payload);
    return;
  }

  if (_buffer.length === 0) return;

  const events = _buffer;
  _buffer = [];
  _post(events, 0);
}

/** 재시도 대기 중인 이벤트 수 — 검증·디버그용 */
function getPendingCount() {
  return _retryQueue.reduce((sum, batch) => sum + batch.events.length, 0);
}

/**
 * 수집 서버를 미리 깨운다 (warm-up).
 *
 * Render 무료 플랜은 유휴 상태에서 첫 요청에 30~50초가 걸린다.
 * 재시도 백오프(1s→2s→4s = 합 7초)로는 이 구간을 버티지 못한다.
 *
 * 그래서 SDK 초기화 직후 가벼운 GET을 한 번 던져 서버를 깨워둔다.
 * 첫 이벤트가 실제로 전송될 때쯤이면(최소 5초 뒤) 서버가 준비돼 있다.
 * 방문자 입장에서도 "첫 접속이 느린" 현상이 함께 사라진다.
 *
 * 실패해도 아무것도 하지 않는다. 어차피 재시도 큐가 받아준다.
 */
function warmUp() {
  try {
    const url = new URL(COLLECT_URL);
    fetch(`${url.origin}/health`, { method: 'GET', mode: 'cors' }).catch(() => {});
  } catch {
    // COLLECT_URL이 상대경로 등으로 설정된 경우 — 깨울 대상이 없다
  }
}

// ── 내부 헬퍼 ────────────────────────────────────────────────

/**
 * 이벤트 배열을 JSON으로 직렬화한다.
 *
 * JSON.stringify는 순환 참조나 예외를 던지는 getter를 만나면 throw한다.
 * data에 어떤 값이 들어올지 SDK가 완전히 통제할 수 없으므로(B·C가 DOM에서
 * 뽑아온 값을 그대로 담는다), 여기서 막지 않으면 그 예외가 flush()를 타고
 * beforeunload 핸들러까지 올라가 호스트 쇼핑몰에 노출된다.
 *
 * 배치 전체가 실패하면 이벤트를 하나씩 시도해 문제가 되는 것만 버린다.
 *
 * @returns {string|null} 직렬화 실패 시 null
 */
function _serialize(events) {
  try {
    return JSON.stringify({ events });
  } catch {
    // 배치 안에 직렬화 불가능한 이벤트가 섞여 있다 → 나머지만 살린다
    const safeEvents = events.filter((event) => {
      try {
        JSON.stringify(event);
        return true;
      } catch {
        return false;
      }
    });

    if (safeEvents.length === 0) return null;

    try {
      return JSON.stringify({ events: safeEvents });
    } catch {
      return null;
    }
  }
}

/**
 * 배치를 전송하고, 실패하면 재시도 큐에 넣는다.
 * @param {object[]} events
 * @param {number} attempt  현재까지 시도한 횟수 (0부터)
 */
function _post(events, attempt) {
  const payload = _serialize(events);
  if (payload === null) return;   // 보낼 수 없는 데이터는 조용히 버린다

  fetch(COLLECT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    payload,
  })
    .then((res) => {
      // 200번대가 아니면 서버가 저장하지 못한 것으로 본다.
      // 예전 코드는 .catch만 달아둬서 500 응답도 성공으로 셌다.
      if (res.ok) return;

      // 4xx는 다시 보내도 같은 결과다 (형식 오류 등). 버린다.
      if (res.status >= 400 && res.status < 500) return;

      _enqueueRetry(events, attempt + 1);
    })
    .catch(() => {
      // 네트워크 실패·타임아웃·콜드 스타트 → 재시도 대상
      _enqueueRetry(events, attempt + 1);
    });
}

/** 실패한 배치를 재시도 큐에 넣고 백오프 타이머를 건다 */
function _enqueueRetry(events, attempt) {
  if (attempt > MAX_RETRIES) return;   // 포기 (호스트 쇼핑몰에 알리지 않는다)

  _retryQueue.push({ events, attempt });
  _trimRetryQueue();
  _scheduleRetry();
}

/**
 * 큐가 무한히 커지지 않도록 오래된 배치부터 버린다.
 * 서버가 장시간 죽어 있어도 브라우저 메모리를 잠식하지 않게 하는 장치.
 */
function _trimRetryQueue() {
  while (getPendingCount() > MAX_QUEUE_SIZE && _retryQueue.length > 0) {
    _retryQueue.shift();
  }
}

/** 큐에서 가장 이른 재시도 시점에 맞춰 타이머를 건다 */
function _scheduleRetry() {
  if (_retryTimer !== null || _retryQueue.length === 0) return;

  // 큐에서 가장 적게 시도된 배치 기준으로 대기 시간을 정한다
  const minAttempt = Math.min(..._retryQueue.map((batch) => batch.attempt));
  const delay = RETRY_BASE_MS * Math.pow(2, Math.max(0, minAttempt - 1));

  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    const batches = _retryQueue;
    _retryQueue = [];
    batches.forEach((batch) => _post(batch.events, batch.attempt));
  }, delay);
}

/** 재시도 큐를 비우고 담겨 있던 이벤트를 전부 반환 (unload 시 사용) */
function _drainRetryQueue() {
  clearTimeout(_retryTimer);
  _retryTimer = null;

  const events = _retryQueue.flatMap((batch) => batch.events);
  _retryQueue = [];
  return events;
}

/**
 * unload 전송 — sendBeacon 우선, 실패 시 fetch keepalive
 *
 * ── Content-Type을 text/plain으로 보내는 이유 (중요) ─────────────
 *
 * 예전에는 Blob type을 'application/json'으로 줬는데, 이 값은
 * CORS-safelisted Content-Type이 아니다. 그래서 교차 출처 요청이
 * "단순 요청"이 아니게 되고 preflight(OPTIONS)가 필요해진다.
 *
 * fetch는 preflight를 보낼 수 있지만 sendBeacon은 못 한다.
 * 게다가 sendBeacon은 "큐에 넣었다"는 뜻으로 true를 반환하기 때문에,
 * 그 뒤 실제 전송이 CORS로 막혀도 알 수가 없다.
 * true를 받았으니 아래 fetch fallback도 실행되지 않는다.
 *
 * 결과: 페이지를 떠나는 순간의 이벤트가 전부 조용히 사라졌다.
 *   - 링크를 눌러 이동할 때의 click
 *   - 장바구니 담기·구매 클릭 (누르자마자 페이지가 넘어간다)
 *   - session_end (exit_page·dwell_time·bounce_flag가 여기 들어 있다)
 * 실측에서도 click과 session_end만 0건이고 스크롤·마우스는 정상이었다.
 *
 * text/plain은 safelisted라 preflight 없이 나간다.
 * 서버는 text/plain 본문도 JSON으로 파싱한다(backend/server.js).
 * GA·Segment 같은 수집 SDK가 beacon을 text/plain으로 보내는 것도 같은 이유다.
 * ────────────────────────────────────────────────────────────────
 */
function _sendBeaconOrFetch(payload) {
  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
    try {
      if (navigator.sendBeacon(COLLECT_URL, blob)) return;
    } catch {
      // 일부 브라우저는 큐 포화 시 예외를 던진다 → fetch로 넘어간다
    }
  }

  fetch(COLLECT_URL, {
    method:    'POST',
    headers:   { 'Content-Type': 'text/plain;charset=UTF-8' },
    body:      payload,
    keepalive: true,
  }).catch(() => {
    // 창이 닫히는 중이라 더 할 수 있는 게 없다
  });
}

export { send, flush, configureSender, getPendingCount, warmUp };
