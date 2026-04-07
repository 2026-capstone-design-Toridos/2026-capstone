/**
 * eventProcessor.js  —  A 담당
 *
 * 역할: 모든 이벤트의 중앙 처리기 (Event Dispatcher)
 *   1. B·C에서 emit()으로 넘어온 raw 이벤트에 공통 필드 자동 부여
 *   2. 파생 이벤트 생성: rage_click, cart_abandon_flag, time_to_first_click
 *   3. sender.js로 전달
 */

import { getSessionId, getPageContext, touchSessionTimestamp } from './sessionManager.js';
import { recordActivity, recordFirstClick } from './timeTracker.js';
import { send } from './sender.js';

// ── event_token vocab ──────────────────────────────────────────
// AI 팀과 공유하는 고정 매핑. 변경 시 반드시 BE/AI 팀에 공지.
// B/C가 실제로 emit하는 이벤트명과 1:1로 맞춤.
const EVENT_VOCAB = Object.freeze({
  // Session / Page (A)
  session_start:            1,
  session_end:              2,
  navigation:               3,
  bounce:                   4,

  // Click (B)
  click:                   10,
  rage_click:              11,   // A 파생

  // Hover (B) — 300ms 이상 hover 시 B가 emit
  hover_dwell:             20,

  // Tab (B)
  tab_exit:                30,
  tab_return:              31,

  // Form (B) — B 실제 이벤트명과 맞춤
  input_change:            40,   // B: input 발생 시
  field_focus:             41,   // B: form 요소 focus 시
  field_blur:              42,   // B: form 요소 blur 시
  input_abandon:           43,   // B: blur 시 value가 비어있을 때
  paste_event:             44,   // B: paste 이벤트

  // Media
  image_slide:             50,
  image_zoom:              51,
  video_play:              52,

  // Scroll (C) — C 실제 이벤트명과 맞춤
  scroll_depth:            60,   // C: 5% 단위 depth 변화
  scroll_milestone:        61,   // C: 25/50/75/100% 도달
  scroll_stop:             62,   // C: 300ms 정지
  scroll_direction_change: 63,   // C: 방향 전환
  scroll_speed:            64,   // C: 속도

  // Section (C)
  section_enter:           70,
  section_exit:            71,
  section_revisit:         72,   // C: 섹션 재진입
  section_transition:      73,   // C: 섹션 간 이동
  subsection_enter:        74,
  subsection_exit:         75,

  // Ecommerce (C)
  product_click:           80,
  option_select:           81,
  add_to_cart:             82,
  remove_from_cart:        83,
  purchase_click:          84,
  cart_abandon_flag:       85,   // A 파생

  // A 파생 / A 전용
  inactivity:              90,
  time_to_first_click:     91,   // A 파생
  subsection_dwell:        92,   // A 파생 (window.__GT bridge를 통해)
  screen_resize:           93,   // A 전용
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

// cart_abandon_flag 감지용 — count로 추적
let _cartItemCount = 0;

// ── 공개 API ──────────────────────────────────────────────────

/**
 * B·C 레이어에서 호출하는 단일 진입점
 * @param {string} eventType  EVENT_VOCAB 키
 * @param {object} data       raw 데이터 (session_id, seq 등 공통 필드는 포함하지 않는다)
 */
function emit(eventType, data = {}) {
  const now = Date.now();

  // inactivity는 활동 이벤트가 아니므로 타이머/TTL을 갱신하지 않는다
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

  // ── 원본 이벤트 먼저 dispatch (seq 확보) ─────────────────
  const seq = _dispatch(eventType, data, now);

  // ── 파생 이벤트: 원본 seq 확보 후 처리 ───────────────────
  if (eventType === 'click') {
    const ttfc = recordFirstClick();
    if (ttfc !== null) {
      // derived_from_seq로 원본 click과 연결 — inter_event_gap 0이 자연스럽게 표현됨
      _dispatch('time_to_first_click', { duration_ms: ttfc, derived_from_seq: seq }, now);
    }
    _checkRageClick(data, now);
  }
}

/**
 * 세션 종료 시 sdk-A.js에서 호출
 * recordActivity()를 호출하지 않는다 — 종료는 활동이 아님 (last_event_time 오염 방지)
 * @param {object} exitData
 */
function emitSessionEnd(exitData = {}) {
  const now = Date.now();

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
    seq:             _seq,
    event_token:     EVENT_VOCAB[eventType] ?? 0,
    inter_event_gap,
    ...getPageContext(),
    data,
  };

  send(event);
  return _seq;
}

function _checkRageClick(data, now) {
  // B는 click_position: {x, y} 구조로 보냄.
  // 직접 x/y가 오는 경우(테스트·직접 호출)도 지원.
  const pos = data.click_position;
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
    // click_target: B의 필드명(click_target)과 통일 — AI 팀이 일관되게 파싱 가능
    _dispatch('rage_click', { x, y, click_target: target, click_count: _recentClicks.length }, now);
    _recentClicks = [];
  }
}

export { emit, emitSessionEnd, EVENT_VOCAB };
