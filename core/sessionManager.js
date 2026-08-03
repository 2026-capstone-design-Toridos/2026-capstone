/**
 * sessionManager.js — GhostTracker SDK 세션 관리
 *
 * 역할:
 *   1. TTL 기반 세션 관리 (30분 이내 재방문 = 동일 세션 재사용)
 *   2. 공통 페이지/환경 컨텍스트 저장소 (_pageContext)
 *      → eventProcessor._dispatch()가 모든 이벤트에 자동으로 붙임
 *
 * ── 세션 정책 ───────────────────────────────────────────────────
 *  session_id: localStorage에 저장
 *  TTL: 마지막 활동 시각(gt_sid_ts) 기준 30분
 *    - TTL 이내: 기존 session_id 재사용  (페이지 이동, 새 탭 등)
 *    - TTL 초과: 새 session_id 발급 (새 방문으로 간주)
 *  is_returning: 과거 완료된 세션이 존재하면 true
 *    - gt_sid_cnt(총 세션 수)로 판단 → 0이면 첫 방문, 1 이상이면 재방문
 *  session_count: 지금까지 발급된 총 세션 수
 * ───────────────────────────────────────────────────────────────
 */

const SESSION_ID_KEY  = 'gt_sid';       // 현재 session_id
const SESSION_TS_KEY  = 'gt_sid_ts';    // 마지막 활동 시각 (TTL 갱신용)
const SESSION_CNT_KEY = 'gt_sid_cnt';   // 총 발급 세션 수 (is_returning 판단)
const SESSION_SEQ_KEY = 'gt_seq';       // 세션 내 이벤트 순번 (페이지 이동해도 이어짐)
const SESSION_LAST_TS_KEY = 'gt_last_ts'; // 마지막 이벤트 시각 (inter_event_gap 계산용)

// ── 세션 TTL ────────────────────────────────────────────────────
// 기본 30분. 코드 주석과 docs/notion-current-architecture.md의 원래 의도이자
// GA4 기본값이다. 팀 상의로 확정되면 DEFAULT_TTL_MINUTES 숫자만 바꾸면 된다.
//
// initA({ session: { ttlMinutes: N } })으로 주입해 덮어쓸 수도 있다.
const DEFAULT_TTL_MINUTES = 30;
let SESSION_TTL_MS = DEFAULT_TTL_MINUTES * 60 * 1000;

/**
 * 세션 정책을 외부에서 주입할 때 사용 (initA의 options.session으로 전달)
 * @param {{ ttlMinutes?: number }} opts
 */
function configureSession({ ttlMinutes } = {}) {
  if (Number.isFinite(ttlMinutes) && ttlMinutes > 0) {
    SESSION_TTL_MS = ttlMinutes * 60 * 1000;
  }
}

/** 현재 적용 중인 TTL(분) — 디버그·검증용 */
function getSessionTtlMinutes() {
  return SESSION_TTL_MS / 60000;
}

// ── localStorage 안전 접근 ───────────────────────────────────────
// 사파리 프라이빗 모드나 저장소 차단 환경에서 localStorage 접근만으로도
// 예외가 난다. SDK가 호스트 쇼핑몰을 죽이면 안 되므로 전부 감싼다.
function _read(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function _write(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // 저장 실패해도 수집은 계속된다 (세션이 페이지마다 새로 발급될 뿐)
  }
}

function _remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

// ── 공통 컨텍스트 저장소 ─────────────────────────────────────────
// sdk-A.js가 setPageContext()로 초기값을 세팅하고,
// navigation 발생 시 updatePageUrl()로 url/pathname만 갱신.
// eventProcessor._dispatch()가 getPageContext()로 읽어서 모든 이벤트에 첨부.
let _pageContext = null;

// ── 세션 초기화 ──────────────────────────────────────────────────

/**
 * 세션을 초기화하고 세션 컨텍스트를 반환
 * @returns {object} sessionContext
 */
function initSession() {
  const now = Date.now();
  const storedId  = _read(SESSION_ID_KEY);
  const storedTs  = Number(_read(SESSION_TS_KEY,  '0'));
  const storedCnt = Number(_read(SESSION_CNT_KEY, '0'));

  let session_id;
  let is_new_session;

  if (storedId && (now - storedTs) < SESSION_TTL_MS) {
    // TTL 이내 → 기존 세션 재사용 (페이지 이동, 새 탭 열기 등)
    session_id = storedId;
    is_new_session = false;
  } else {
    // TTL 초과 or 최초 방문 → 새 세션 발급
    session_id = crypto.randomUUID();
    is_new_session = true;
    _write(SESSION_ID_KEY, session_id);
    _write(SESSION_CNT_KEY, storedCnt + 1);

    // 새 세션이므로 이벤트 순번과 직전 이벤트 시각을 초기화한다.
    // 세션이 유지되는 경우에는 건드리지 않아야 페이지를 넘어가도 순번이 이어진다.
    _remove(SESSION_SEQ_KEY);
    _remove(SESSION_LAST_TS_KEY);
  }

  // 활동 시각 갱신 (TTL 기준점)
  _write(SESSION_TS_KEY, now);

  const utm = _parseUTM();

  return {
    session_id,
    is_new_session,                            // 이번 페이지 로드에서 새로 발급됐는지
    // is_returning: 새 세션을 발급받을 때 AND 이전에 완료된 세션이 있을 때만 true.
    // 기존 세션을 재사용(is_new_session=false)하는 경우는 동일 세션 유지이므로 false.
    is_returning: is_new_session && storedCnt > 0,
    session_count: storedCnt + (is_new_session ? 1 : 0),
    page_url:    window.location.href,
    pathname:    window.location.pathname,
    referrer:    document.referrer || '',
    utm_source:  utm.utm_source,
    utm_campaign: utm.utm_campaign,
    visit_time:  now,
  };
}

/**
 * 페이지 언로드 시 호출 — TTL 기준점을 현재 시각으로 갱신
 * 다음 방문이 30분 이내면 동일 세션으로 이어짐
 */
function touchSessionTimestamp() {
  _write(SESSION_TS_KEY, Date.now());
}

// ── 이벤트 순번 / 직전 이벤트 시각 ───────────────────────────────
//
// 왜 localStorage에 두는가:
//   Cafe24 같은 다중 페이지 쇼핑몰은 페이지를 넘길 때마다 전체 새로고침이
//   일어나고, 그때 SDK 모듈이 재초기화된다. 순번을 모듈 변수로만 들고 있으면
//   페이지마다 1부터 다시 시작해서
//     - 세션 타임라인 정렬(classify.js, clusters.js, exit_capture.py)이 뒤섞이고
//     - 중복 판정 키로 쓸 수 없게 된다
//   세션 단위로 이어져야 "행동 순서" 분석이 성립한다.

/** 다음 이벤트 순번을 발급한다 (세션 내 단조 증가) */
function nextEventSeq() {
  const next = Number(_read(SESSION_SEQ_KEY, '0')) + 1;
  _write(SESSION_SEQ_KEY, next);
  return next;
}

/** 직전 이벤트 시각을 읽는다 (없으면 null) */
function getLastEventTimestamp() {
  const raw = _read(SESSION_LAST_TS_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 직전 이벤트 시각을 갱신한다 */
function setLastEventTimestamp(timestamp) {
  _write(SESSION_LAST_TS_KEY, timestamp);
}

// ── 공통 컨텍스트 관리 ───────────────────────────────────────────

/**
 * sdk-A.js 초기화 시 session + env 정보를 한 번에 저장
 * @param {object} ctx  { page_url, pathname, referrer, utm_*, device_type, ... }
 */
function setPageContext(ctx) {
  _pageContext = { ...ctx };
}

/**
 * SPA navigation 발생 시 url/pathname/utm 갱신
 * 나머지 env 정보는 세션 동안 고정
 */
function updatePageUrl() {
  if (_pageContext) {
    const utm = _parseUTM();
    _pageContext.page_url     = window.location.href;
    _pageContext.pathname     = window.location.pathname;
    _pageContext.utm_source   = utm.utm_source;
    _pageContext.utm_campaign = utm.utm_campaign;
  }
}

/**
 * eventProcessor._dispatch()에서 호출 — 모든 이벤트에 붙일 공통 필드 반환
 * @returns {object}
 */
function getPageContext() {
  return _pageContext || {};
}

/** @returns {string} */
function getSessionId() {
  return _read(SESSION_ID_KEY, '') || '';
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────

// URL 쿼리에서 utm_source/utm_campaign만 뽑아온다
function _parseUTM() {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source:   params.get('utm_source')   || '',
    utm_campaign: params.get('utm_campaign') || '',
  };
}

export {
  initSession,
  configureSession,
  getSessionTtlMinutes,
  touchSessionTimestamp,
  nextEventSeq,
  getLastEventTimestamp,
  setLastEventTimestamp,
  setPageContext,
  updatePageUrl,
  getPageContext,
  getSessionId,
};
