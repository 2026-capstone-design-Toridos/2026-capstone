/**
 * eventProcessor.js  — GhostTracker SDK 이벤트 처리 모듈
 *
 * 역할: 모든 이벤트의 중앙 처리기 (Event Dispatcher)
 *   1. B·C에서 emit()으로 넘어온 raw 이벤트에 공통 필드 자동 부여
 *   2. 파생 이벤트 생성: rage_click, cart_abandon_flag, time_to_first_click
 *   3. sender.js로 전달
 */

import {
  getSessionId,
  getPageContext,
  touchSessionTimestamp,
  nextEventSeq,
  getLastEventTimestamp,
  setLastEventTimestamp,
} from './sessionManager.js';
import { recordActivity, recordFirstClick, getPendingInactivity } from './timeTracker.js';
import { send } from './sender.js';
import { getPlatformContext } from './platformAdapter.js';

// ── event_token vocab ──────────────────────────────────────────
// AI 팀과 공유하는 고정 매핑. 변경 시 반드시 BE/AI 팀에 공지.
// B/C 실제 emit 이벤트명과 1:1 대응.
const EVENT_VOCAB = Object.freeze({
  // Session / Page (A)
  session_start:            1,
  session_end:              2,
  navigation:               3,
  bounce:                   4,

  // Click (B)
  click:                   10,
  rage_click:              11,  // A 파생

  // Mouse / Hover (B)
  mouse_move:              20,  // B: 2초 주기 누적 이동거리 + jitter
  hover_dwell:             21,  // B: 300ms 이상 hover

  // Tab (B)
  tab_exit:                30,
  tab_return:              31,

  // Form (B)
  input_change:            40,
  field_focus:             41,
  field_blur:              42,
  input_abandon:           43,
  paste_event:             44,
  search_use:              45,  // B: 검색 입력 감지

  // Media (B)
  image_slide:             50,
  image_zoom:              51,
  video_play:              52,
  video_watch_pct:         53,  // B: 10% 단위 영상 시청 진척

  // Scroll (C)
  scroll_depth:            60,
  scroll_milestone:        61,
  scroll_stop:             62,
  scroll_direction_change: 63,
  scroll_speed:            64,

  // Section (C)
  section_enter:           70,
  section_exit:            71,
  section_revisit:         72,
  section_transition:      73,
  subsection_enter:        74,
  subsection_exit:         75,
  subsection_revisit:      76,  // C: 동일 서브섹션 재진입

  // Ecommerce (C)
  product_click:           80,
  option_select:           81,
  add_to_cart:             82,
  remove_from_cart:        83,
  purchase_click:          84,
  cart_abandon_flag:       85,  // A 파생
  quantity_change:         86,  // C: 수량 변경
  option_change:           87,  // C: 동일 옵션 반복 변경

  // Review (C)
  review_click:            94,  // C: 리뷰 아이템 클릭
  review_page_change:      95,  // C: 리뷰 페이지 넘기기 (페이지네이션 / 더보기)
  review_scroll:           96,  // C: 리뷰 섹션 가시 상태에서 페이지 스크롤
  review_area_scroll:      97,  // C: 리뷰 전용 스크롤 영역(모달/패널) 내 스크롤
  review_image_click:      98,  // C: 리뷰 내 이미지 클릭

  // A 파생 / A 전용
  inactivity:              90,
  time_to_first_click:     91,  // A 파생
  subsection_dwell:        92,  // C 계산 후 emit
  screen_resize:           93,  // A 전용

  // SDK 자체 진단 — 리스너에서 예외가 나면 조용히 삼키고 이 이벤트로 기록한다.
  // 분석 대상이 아니므로 토큰은 0(패딩)으로 두어 학습 시퀀스에 섞이지 않게 한다.
  sdk_error:                0,
});

// ── 내부 상태 ─────────────────────────────────────────────────
//
// event_seq와 직전 이벤트 시각은 모듈 변수가 아니라 sessionManager(localStorage)가
// 들고 있다. Cafe24처럼 페이지를 넘길 때마다 전체 새로고침이 일어나는 쇼핑몰에서는
// 모듈 변수가 매번 0으로 리셋되어
//   - event_seq가 페이지마다 1부터 다시 시작 → 세션 타임라인 정렬이 뒤섞이고
//     (classify.js, clusters.js, exit_capture.py가 event_seq로 정렬한다)
//   - inter_event_gap이 페이지 첫 이벤트마다 0으로 기록되며
//   - event_seq를 중복 판정 키로 쓸 수 없게 된다
// 세션 단위로 이어져야 "행동 순서" 분석이 성립한다.

// 세션 TTL 만료 / 활동 콜백 (sdk-A.js가 주입)
let _activityCallback = null;

/**
 * 예외 격리 래퍼.
 *
 * SDK는 남의 쇼핑몰에 삽입되므로, 예상 못 한 DOM을 만나 예외가 나더라도
 * 호스트 페이지에 영향을 주면 안 된다. 예전에는 SDK 전체에 try/catch가
 * 하나도 없어서 리스너 하나가 죽으면 그 유형의 이벤트가 세션 내내
 * 수집되지 않았고, 그 사실을 알 방법조차 없었다.
 *
 * 여기서 삼킨 예외는 _reportSdkError로 별도 기록해 원인을 추적할 수 있게 한다.
 * 호스트 페이지 콘솔에는 아무것도 출력하지 않는다.
 *
 * @param {Function} fn     감쌀 함수
 * @param {string} context  실패 지점 식별자 (에러 이벤트에 기록)
 * @returns {Function}
 */
function safe(fn, context = 'unknown') {
  return function wrapped(...args) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      _reportSdkError(context, err);
      return undefined;
    }
  };
}

// 같은 지점에서 반복 실패할 때 에러 이벤트가 폭주하지 않도록 지점당 1회만 보고
const _reportedErrors = new Set();

function _reportSdkError(context, err) {
  if (_reportedErrors.has(context)) return;
  _reportedErrors.add(context);

  try {
    send({
      event_id:   _newEventId(),
      session_id: getSessionId(),
      event_type: 'sdk_error',
      timestamp:  Date.now(),
      event_token: 0,
      data: {
        sdk_error: true,
        context,
        message: String(err && err.message ? err.message : err).slice(0, 200),
      },
    });
  } catch {
    // 에러 보고가 또 실패하면 조용히 포기한다
  }
}

/** 이벤트마다 붙는 고유 ID — 서버가 이걸로 재전송 중복을 걸러낸다 */
function _newEventId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  // randomUUID를 못 쓰는 환경(구형 브라우저·비보안 컨텍스트) fallback
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * sdk-A.js가 initA() 시점에 등록
 * emit() 내 사용자 활동마다 호출 → 30분 TTL 타이머 리셋 + 만료 후 세션 재시작
 */
export function setActivityCallback(cb) {
  _activityCallback = cb;
}

// rage_click 감지용
const RAGE_CLICK_WINDOW_MS   = 500;
const RAGE_CLICK_THRESHOLD   = 3;
const RAGE_CLICK_RADIUS_PX   = 20;
const RAGE_CLICK_COOLDOWN_MS = 1_000;
let _recentClicks = [];
let _rageClickLastFiredAt = null;

// cart 상태 (item count로 추적)
let _cartItemCount = 0;

// ── 공개 API ──────────────────────────────────────────────────

/**
 * B·C 레이어에서 호출하는 단일 진입점
 * @param {string} eventType  EVENT_VOCAB 키
 * @param {object} data       raw 이벤트별 데이터 (session_id, event_seq 등은 여기 넣지 않는다)
 */
function emit(eventType, data = {}) {
  const now = Date.now();

  // inactivity는 활동 이벤트가 아니므로 타이머/TTL 갱신 제외
  if (eventType !== 'inactivity') {
    recordActivity();
    touchSessionTimestamp();
    // 세션 TTL 타이머 리셋 (30분 비활성 감지 + 만료 후 세션 재시작)
    if (_activityCallback) _activityCallback();
  }

  // ── cart 상태 갱신 ────────────────────────────────────────
  if (eventType === 'add_to_cart') {
    _cartItemCount += 1;
  } else if (eventType === 'remove_from_cart') {
    _cartItemCount = Math.max(0, _cartItemCount - 1);
  } else if (eventType === 'purchase_click') {
    _cartItemCount = 0;
  }

  // ── 원본 이벤트 먼저 dispatch (event_seq 확보) ───────────
  const event_seq = _dispatch(eventType, data, now);

  // ── click 파생 이벤트 ─────────────────────────────────────
  if (eventType === 'click') {
    const ttfc = recordFirstClick();
    if (ttfc !== null) {
      // 원본 click(event_seq N) 먼저, 파생(event_seq N+1)에 derived_from_seq 첨부
      _dispatch('time_to_first_click', { duration_ms: ttfc, derived_from_seq: event_seq }, now);
    }
    _checkRageClick(data, now);
  }
}

/**
 * 세션 종료 시 sdk-A.js에서 호출
 * recordActivity() 호출 안 함 — 종료는 활동이 아님 (last_event_time 오염 방지)
 */
function emitSessionEnd(exitData = {}) {
  const now = Date.now();

  // 비활성 중 세션이 종료된 경우 → pending inactivity 먼저 flush
  const pending = getPendingInactivity();
  if (pending) {
    _dispatch('inactivity', pending, now);
  }

  if (_cartItemCount > 0) {
    _dispatch('cart_abandon_flag', {
      cart_abandon_flag: true,
      cart_item_count:   _cartItemCount,
    }, now);
  }

  _dispatch('session_end', exitData, now);
}

// ── 내부 헬퍼 ────────────────────────────────────────────────

// 공통 필드 붙여서 event 객체 완성하고 sender로 넘긴다
function _dispatch(eventType, data, timestamp) {
  if (!(eventType in EVENT_VOCAB)) {
    // 호스트 페이지 콘솔을 더럽히지 않는다 (개발 중에는 debugEmit으로 확인)
  }

  // 직전 이벤트 시각은 세션 단위로 유지된다 → 페이지를 넘어가도 gap이 이어진다
  const lastTimestamp = getLastEventTimestamp();
  const inter_event_gap = lastTimestamp !== null ? timestamp - lastTimestamp : 0;
  setLastEventTimestamp(timestamp);

  const event_seq = nextEventSeq();

  // Layer 0: 플랫폼이 알려주는 확정값 (Cafe24 meta 등).
  // 감지 안 되는 사이트면 null이라 아무 필드도 붙지 않는다 → 기존 동작 유지.
  const platform = getPlatformContext();

  const event = {
    // event_id: 재전송 중복 판정 키.
    // (session_id, event_seq)는 쓸 수 없다 — 아래 주석 참고.
    event_id:        _newEventId(),
    session_id:      getSessionId(),
    event_type:      eventType,
    timestamp,
    event_seq,
    event_token:     EVENT_VOCAB[eventType] ?? 0,
    inter_event_gap,
    ...getPageContext(),  // page_url, pathname, referrer, utm_*, device_type 등 자동 부여

    // 플랫폼 확정값 — URL 추론보다 우선하는 근거가 된다
    ...(platform ? {
      platform:      platform.platform,
      page_type:     platform.page_type,
      platform_role: platform.platform_role,
      // 상품 상세에서는 모든 이벤트에 상품 ID를 붙인다.
      // 예전에는 add_to_cart 같은 특정 이벤트의 data 안에만 있어서,
      // "이 세션이 어떤 상품을 봤는지"를 알 방법이 없었다.
      ...(platform.product_id ? { product_id: platform.product_id } : {}),
      ...(platform.product_price ? { product_price: platform.product_price } : {}),
    } : {}),

    data,
  };

  send(event);
  return event_seq;
}

/**
 * rage_click 감지: 500ms 내 ±20px 범위 3회 이상 클릭
 * B는 click_position:{x,y} 구조로 보내므로 양쪽 형식 모두 지원
 */
function _checkRageClick(data, now) {
  const pos    = data.click_position;
  const x      = pos?.x      ?? data.x      ?? 0;
  const y      = pos?.y      ?? data.y      ?? 0;
  const target = data.click_target ?? data.target ?? '';

  if (_rageClickLastFiredAt !== null && (now - _rageClickLastFiredAt) < RAGE_CLICK_COOLDOWN_MS) {
    _recentClicks = [];
    return;
  }

  _recentClicks = _recentClicks.filter(c => now - c.timestamp < RAGE_CLICK_WINDOW_MS);

  const isNearby = _recentClicks.every(
    c => Math.abs(c.x - x) <= RAGE_CLICK_RADIUS_PX &&
         Math.abs(c.y - y) <= RAGE_CLICK_RADIUS_PX
  );
  if (!isNearby) {
    _recentClicks = [];
  }

  _recentClicks.push({ x, y, target, timestamp: now });

  if (_recentClicks.length >= RAGE_CLICK_THRESHOLD) {
    _rageClickLastFiredAt = now;
    _dispatch('rage_click', { x, y, click_target: target, click_count: _recentClicks.length }, now);
    _recentClicks = [];
  }
}

// 외부로 나가는 진입점은 전부 예외 격리 래퍼를 씌운다.
// B·C의 리스너가 던진 예외가 호스트 쇼핑몰 스크립트로 전파되지 않게 하는 마지막 방어선.
const safeEmit           = safe(emit, 'eventProcessor.emit');
const safeEmitSessionEnd = safe(emitSessionEnd, 'eventProcessor.emitSessionEnd');

export {
  safeEmit as emit,
  safeEmitSessionEnd as emitSessionEnd,
  EVENT_VOCAB,
  safe,
};
