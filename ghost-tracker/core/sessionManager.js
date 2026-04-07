/**
 * sessionManager.js  —  A 담당
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
const SESSION_TTL_MS  = 30 * 60 * 1000; // 30분

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
  const storedId  = localStorage.getItem(SESSION_ID_KEY);
  const storedTs  = Number(localStorage.getItem(SESSION_TS_KEY)  || '0');
  const storedCnt = Number(localStorage.getItem(SESSION_CNT_KEY) || '0');

  let session_id;
  let is_new_session;

  if (storedId && (now - storedTs) < SESSION_TTL_MS) {
    // TTL 이내 → 기존 세션 재사용 (SPA 내 페이지 이동, 새 탭 열기 등)
    session_id = storedId;
    is_new_session = false;
  } else {
    // TTL 초과 or 최초 방문 → 새 세션 발급
    session_id = crypto.randomUUID();
    is_new_session = true;
    localStorage.setItem(SESSION_ID_KEY, session_id);
    localStorage.setItem(SESSION_CNT_KEY, String(storedCnt + 1));
  }

  // 활동 시각 갱신 (TTL 기준점)
  localStorage.setItem(SESSION_TS_KEY, String(now));

  const utm = _parseUTM();

  return {
    session_id,
    is_new_session,                            // 이번 페이지 로드에서 새로 발급됐는지
    is_returning: storedCnt > 0,               // 과거 완료 세션이 존재하면 재방문
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
  localStorage.setItem(SESSION_TS_KEY, String(Date.now()));
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
 * SPA navigation 발생 시 url/pathname만 갱신
 * 나머지 env 정보는 세션 동안 고정
 */
function updatePageUrl() {
  if (_pageContext) {
    _pageContext.page_url = window.location.href;
    _pageContext.pathname = window.location.pathname;
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
  return localStorage.getItem(SESSION_ID_KEY) || '';
}

// ── 내부 헬퍼 ────────────────────────────────────────────────────

function _parseUTM() {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source:   params.get('utm_source')   || '',
    utm_campaign: params.get('utm_campaign') || '',
  };
}

export {
  initSession,
  touchSessionTimestamp,
  setPageContext,
  updatePageUrl,
  getPageContext,
  getSessionId,
};
