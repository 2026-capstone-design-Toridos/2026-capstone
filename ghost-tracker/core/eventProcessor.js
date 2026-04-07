/**
 * eventProcessor.js  —  A 담당
 *
 * 역할: 모든 이벤트의 중앙 처리기 (Event Dispatcher)
 *   1. B·C에서 emit()으로 넘어온 raw 이벤트에 공통 필드 자동 부여
 *      session_id / seq / timestamp / event_token / inter_event_gap
 *      + page_url / pathname / referrer / utm_* / device_type / screen_width / os_type / browser_type
 *   2. 파생 이벤트 생성: rage_click, cart_abandon_flag, time_to_first_click
 *   3. sender.js로 전달
 */

import { getSessionId, getPageContext, touchSessionTimestamp } from './sessionManager.js';
import { recordActivity, recordFirstClick } from './timeTracker.js';
import { send } from './sender.js';

// ── event_token vocab ──────────────────────────────────────────
// AI 팀과 공유하는 고정 매핑. 변경 시 반드시 BE/AI 팀에 공지.
const EVENT_VOCAB = Object.freeze({
  // Session / Page
  session_start:        1,
  session_end:          2,
  page_enter:           3,
  page_exit:            4,
  navigation:           5,
  bounce:               6,
  // Click (B)
  click:               10,
  rage_click:          11,
  // Mouse (B)
  mousemove:           20,
  hover:               21,
  // Tab (B)
  tab_exit:            30,
  tab_return:          31,
  // Form (B)
  input:               40,
  form_abandon:        41,
  paste:               42,
  // Media (B)
  image_slide:         50,
  image_zoom:          51,
  video_play:          52,
  // Scroll (C)
  scroll:              60,
  scroll_milestone:    61,
  scroll_stop:         62,
  // Section (C)
  section_enter:       70,
  section_exit:        71,
  subsection_enter:    72,
  subsection_exit:     73,
  // Ecommerce (C)
  product_click:       80,
  option_select:       81,
  add_to_cart:         82,
  remove_from_cart:    83,
  purchase_click:      84,
  cart_abandon_flag:   85,
  // Time-derived (A)
  inactivity:          90,
  time_to_first_click: 91,
});

// ── 내부 상태 ─────────────────────────────────────────────────

let _seq = 0;
let _lastTimestamp = null;

// rage_click 감지용
const RAGE_CLICK_WINDOW_MS  = 500;
const RAGE_CLICK_THRESHOLD  = 3;
const RAGE_CLICK_RADIUS_PX  = 20;     // ±20px 이내를 동일 위치로 판정
const RAGE_CLICK_COOLDOWN_MS = 1_000; // 감지 후 1초간 재감지 억제
let _recentClicks = [];
let _rageClickLastFiredAt = null;

// cart_abandon_flag 감지용
// 불리언 대신 count로 추적 → add/remove가 여러 번 오가도 정확하게 반응
let _cartItemCount = 0;

// ── 공개 API ──────────────────────────────────────────────────

/**
 * B·C 레이어에서 호출하는 단일 진입점
 *
 * @param {string} eventType  EVENT_VOCAB 키
 * @param {object} data       이벤트별 원시 데이터 (session_id, seq 등 공통 필드는 여기 넣지 않는다)
 */
function emit(eventType, data = {}) {
  const now = Date.now();

  // inactivity는 활동 이벤트가 아니므로 last_event_time/타이머를 갱신하지 않는다.
  if (eventType !== 'inactivity') {
    recordActivity();
    // TTL은 "마지막 활동 시각" 기준으로 유지되어야 하므로 활동 시점마다 갱신.
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

  // ── 파생 이벤트는 원본 seq 확보 후 처리 ──────────────────
  // time_to_first_click: 원본 click(seq N)이 먼저 나간 뒤 파생 이벤트(seq N+1)에
  //   derived_from_seq: N을 붙여서 둘의 관계를 명확히 함.
  //   이로써 click의 inter_event_gap은 실제 이전 이벤트와의 간격이 되고,
  //   time_to_first_click의 inter_event_gap은 0(즉각 파생)으로 자연스럽게 표현됨.
  if (eventType === 'click') {
    const ttfc = recordFirstClick();
    if (ttfc !== null) {
      _dispatch('time_to_first_click', {
        duration_ms: ttfc,
        derived_from_seq: seq,
      }, now);
    }
    _checkRageClick(data, now);
  }
}

/**
 * beforeunload/pagehide 시 sdk-A.js에서 호출
 * — 세션 종료 이벤트 + cart_abandon_flag 파생 처리
 * — recordActivity()를 호출하지 않는다: 세션 종료는 사용자 활동이 아님
 *   (last_event_time이 오염되지 않도록)
 *
 * @param {object} exitData  { exit_page, page_dwell_time, last_viewport_scrollY, ... }
 */
function emitSessionEnd(exitData = {}) {
  const now = Date.now();
  // recordActivity() 제거 — 종료 처리를 활동으로 보지 않음

  if (_cartItemCount > 0) {
    _dispatch('cart_abandon_flag', {
      cart_abandon_flag: true,
      cart_item_count: _cartItemCount,
    }, now);
  }

  _dispatch('session_end', exitData, now);
}

// ── 내부 헬퍼 ────────────────────────────────────────────────

/**
 * 공통 필드를 붙여 sender로 전달하고, 부여된 seq를 반환
 * @returns {number} 이 이벤트에 부여된 seq
 */
function _dispatch(eventType, data, timestamp) {
  const inter_event_gap = _lastTimestamp !== null ? timestamp - _lastTimestamp : 0;
  _lastTimestamp = timestamp;
  _seq += 1;

  const event = {
    // ── 식별자 ──────────────────────────────────────────────
    session_id:       getSessionId(),
    event_type:       eventType,
    timestamp,
    seq:              _seq,
    event_token:      EVENT_VOCAB[eventType] ?? 0,
    inter_event_gap,
    // ── 공통 페이지/환경 문맥 (B·C는 신경 안 써도 됨) ────────
    // getPageContext()는 sessionManager의 _pageContext를 반환.
    // sdk-A.js가 initA()에서 setPageContext()로 세팅하고,
    // navigation 발생 시 updatePageUrl()로 url/pathname을 갱신함.
    ...getPageContext(),
    // ── 이벤트별 원시 데이터 ─────────────────────────────────
    data,
  };

  send(event);
  return _seq;
}

/**
 * rage_click 감지: 500ms 내 ±20px 범위 3회 이상 클릭
 */
function _checkRageClick(data, now) {
  const { x = 0, y = 0, target = '' } = data;

  // rage_click을 실제로 한 번 쏜 뒤에만 쿨다운을 적용한다.
  if (_rageClickLastFiredAt !== null && (now - _rageClickLastFiredAt) < RAGE_CLICK_COOLDOWN_MS) {
    _recentClicks = [];
    return;
  }

  _recentClicks = _recentClicks.filter(c => now - c.timestamp < RAGE_CLICK_WINDOW_MS);

  const isNearby = _recentClicks.every(
    c => Math.abs(c.x - x) <= RAGE_CLICK_RADIUS_PX &&
         Math.abs(c.y - y) <= RAGE_CLICK_RADIUS_PX
  );
  if (!isNearby) _recentClicks = [];

  _recentClicks.push({ x, y, target, timestamp: now });

  if (_recentClicks.length >= RAGE_CLICK_THRESHOLD) {
    _rageClickLastFiredAt = now;
    _dispatch('rage_click', {
      x,
      y,
      target,
      click_count: _recentClicks.length,
    }, now);
    _recentClicks = [];
  }
}

export { emit, emitSessionEnd, EVENT_VOCAB };
