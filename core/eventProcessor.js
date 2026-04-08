/**
 * eventProcessor.js  —  A 담당
 *
 * 역할: 모든 이벤트의 중앙 처리기 (Event Dispatcher)
 *   1. B·C에서 emit()으로 넘어온 raw 이벤트에 공통 필드 자동 부여
 *   2. 파생 이벤트 생성: rage_click, cart_abandon_flag, time_to_first_click
 *   3. sender.js로 전달
 */

import { getSessionId, getPageContext, touchSessionTimestamp } from './sessionManager.js';
import { recordActivity, recordFirstClick, getPendingInactivity } from './timeTracker.js';
import { send } from './sender.js';

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

  // A 파생 / A 전용
  inactivity:              90,
  time_to_first_click:     91,  // A 파생
  subsection_dwell:        92,  // C 계산 후 emit
  screen_resize:           93,  // A 전용
});

// ── 내부 상태 ─────────────────────────────────────────────────

let _seq = 0;
let _lastTimestamp = null;

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

function _dispatch(eventType, data, timestamp) {
  const inter_event_gap = _lastTimestamp !== null ? timestamp - _lastTimestamp : 0;
  _lastTimestamp = timestamp;
  _seq += 1;

  const event = {
    session_id:      getSessionId(),
    event_type:      eventType,
    timestamp,
    event_seq:       _seq,
    event_token:     EVENT_VOCAB[eventType] ?? 0,
    inter_event_gap,
    ...getPageContext(),  // page_url, pathname, referrer, utm_*, device_type 등 자동 부여
    data,
  };

  send(event);
  return _seq;
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

export { emit, emitSessionEnd, EVENT_VOCAB };
