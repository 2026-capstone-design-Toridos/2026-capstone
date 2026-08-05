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
const FIRST_TOUCH_KEY = 'gt_first_touch'; // 세션의 최초 유입 경로 (아래 설명 참고)

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

  // 유입 경로는 세션 최초 진입 시점 값으로 고정한다.
  // 새 세션이면 지금 값으로 다시 계산하고, 유지 중이면 저장된 값을 그대로 쓴다.
  const touch = _resolveFirstTouch(is_new_session);

  return {
    session_id,
    is_new_session,                            // 이번 페이지 로드에서 새로 발급됐는지
    // is_returning: 새 세션을 발급받을 때 AND 이전에 완료된 세션이 있을 때만 true.
    // 기존 세션을 재사용(is_new_session=false)하는 경우는 동일 세션 유지이므로 false.
    is_returning: is_new_session && storedCnt > 0,
    session_count: storedCnt + (is_new_session ? 1 : 0),
    page_url:    cleanUrl(),          // icid 등 추적 파라미터 제거
    pathname:    window.location.pathname,
    visit_time:  now,

    // ── 유입 경로 (세션 고정값) ─────────────────────────────────
    referrer:      touch.referrer,        // 자사·PG 도메인은 걸러진 값
    referrer_host: touch.referrer_host,
    utm_source:    touch.utm_source,
    utm_medium:    touch.utm_medium,
    utm_campaign:  touch.utm_campaign,
    utm_term:      touch.utm_term,
    utm_content:   touch.utm_content,
    channel:       touch.channel,         // 운영자 화면이 바로 쓰는 최종 채널명
    in_app_browser: touch.in_app_browser, // Instagram / KakaoTalk / ...
    landing_page:  touch.landing_page,
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
 * SPA navigation 발생 시 url/pathname만 갱신한다.
 *
 * UTM은 여기서 다시 읽지 않는다. 예전에는 매 이동마다 현재 URL의 UTM으로
 * 덮어써서, 파라미터가 없는 2번째 페이지부터 유입 정보가 빈 값이 됐다.
 * 유입 경로는 세션 최초 진입 시점 값(first-touch)으로 고정한다.
 */
function updatePageUrl() {
  if (_pageContext) {
    _pageContext.page_url = cleanUrl();
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
  return _read(SESSION_ID_KEY, '') || '';
}

// ══════════════════════════════════════════════════════════════════
//  유입 경로 (first-touch attribution)
// ══════════════════════════════════════════════════════════════════
//
// 왜 "최초 진입 시점"을 따로 저장하는가:
//
//  1) UTM은 랜딩 페이지 URL에만 붙는다.
//     ?utm_source=instagram 으로 들어와도 다음 페이지부터는 파라미터가 사라진다.
//
//  2) referrer는 페이지를 넘길 때마다 자사 도메인으로 바뀐다.
//     상품 상세에서 본 referrer는 "우리 홈"이지 "인스타그램"이 아니다.
//
//  3) Cafe24 결제는 별도 팝업으로 PG사(이니시스·토스 등)에 다녀온다.
//     돌아오면 referrer가 PG사 도메인이 된다. 저장해두지 않으면
//     "주문에 성공한 고객"의 유입 경로가 전부 PG사로 기록된다.
//     하필 가장 중요한 세그먼트다.
//
//  예전에는 서버가 $first(received_at 순)로 추정했는데, 배치 전송이라
//  도착 순서가 뒤집히면 틀린 값이 나왔다. 이제 SDK가 확정해서 보낸다.
//
//  저장 시점: 세션이 새로 발급될 때 1회. 세션이 유지되는 동안은 고정.

// 결제대행사(PG) 도메인 — 여기서 돌아온 건 유입이 아니라 결제 왕복이다
const PG_HOSTS = [
  'inicis', 'kcp', 'nicepay', 'kgmobilians', 'settlebank',
  'tosspayments', 'toss.im', 'kakaopay', 'naverpay', 'payco',
  'smartro', 'ksnet', 'allat', 'kicc', 'danal', 'eximbay',
  'pay.naver.com', 'paypal',
];

// 인앱 브라우저 판별 규칙 — [정규식, 채널명]
//
// Instagram·KakaoTalk 인앱 브라우저는 document.referrer를 보내지 않는다.
// 그래서 지금까지 이 유입이 전부 "직접 방문"으로 집계됐다.
// UA로 앱을 식별하면 referrer 없이도 채널을 알 수 있다.
const IN_APP_BROWSERS = [
  [/Instagram/i,            'Instagram'],
  [/KAKAOTALK/i,            'KakaoTalk'],
  [/NAVER\(inapp/i,         'Naver'],
  [/DaumApps|daumcafe/i,    'Daum'],
  [/FBAN|FBAV|FB_IAB/i,     'Facebook'],
  [/Line\//i,               'Line'],
  [/Threads/i,              'Threads'],
  [/TikTok|Musical_ly/i,    'TikTok'],
];

/** UA로 인앱 브라우저를 식별한다 (아니면 '') */
function _detectInAppBrowser(ua = navigator.userAgent) {
  for (const [pattern, name] of IN_APP_BROWSERS) {
    if (pattern.test(ua)) return name;
  }
  return '';
}

/**
 * page_url에서 수집에 방해되는 추적 파라미터를 제거한다.
 *
 * Cafe24는 모든 상품 링크에 ?icid=MAIN.product_listmain_5 같은 내부 클릭
 * 추적 파라미터를 붙인다. 같은 상품 페이지인데 진입 경로마다 URL이 달라져
 * page_url 기준 집계("많이 멈춘 화면" 등)가 흩어진다.
 *
 * UTM은 first-touch로 이미 따로 저장하므로 여기서 지워도 안전하다.
 */
const TRACKING_PARAMS = [
  'icid',                       // Cafe24 내부 클릭 추적
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'igshid',  // 광고 플랫폼 클릭 ID
  'n_media', 'n_query', 'n_ad_group', 'NaPm',  // 네이버 광고
];

function cleanUrl(rawUrl = window.location.href) {
  try {
    const url = new URL(rawUrl);
    TRACKING_PARAMS.forEach((p) => url.searchParams.delete(p));
    // 남은 파라미터가 없으면 물음표도 떼어 URL을 하나로 통일한다
    url.search = url.searchParams.toString();
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/** referrer URL에서 host만 뽑는다 */
function _hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 유입으로 인정할 수 없는 referrer인지 판정한다.
 *  - 자사 도메인: 내부 이동이지 유입이 아니다
 *  - PG 도메인: 결제 왕복이지 유입이 아니다
 */
function _isIgnoredReferrer(host) {
  if (!host) return true;

  const self = String(window.location.hostname || '').replace(/^www\./i, '').toLowerCase();
  // 모바일 서브도메인(m.도메인)도 자사로 본다
  if (host === self) return true;
  if (self.endsWith(`.${host}`) || host.endsWith(`.${self}`)) return true;

  return PG_HOSTS.some((pg) => host.includes(pg));
}

/** 이번 페이지 URL에서 UTM 5종을 모두 읽는다 */
function _parseUTM() {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source:   params.get('utm_source')   || '',
    utm_medium:   params.get('utm_medium')   || '',   // 스키마엔 있었는데 수집이 빠져 있었다
    utm_campaign: params.get('utm_campaign') || '',
    utm_term:     params.get('utm_term')     || '',
    utm_content:  params.get('utm_content')  || '',
  };
}

/**
 * 지금 이 페이지 로드의 유입 정보를 계산한다.
 * 채널 판정 우선순위: UTM → 인앱 브라우저 → referrer → 직접 방문
 */
function _computeTouch() {
  const utm         = _parseUTM();
  const referrer    = document.referrer || '';
  const host        = _hostOf(referrer);
  const ignored     = _isIgnoredReferrer(host);
  const inApp       = _detectInAppBrowser();

  let channel;
  if (utm.utm_source)      channel = utm.utm_source;
  else if (inApp)          channel = inApp;          // referrer 없는 인앱 유입 구제
  else if (!ignored)       channel = host;
  else                     channel = 'direct';

  return {
    ...utm,
    referrer:        ignored ? '' : referrer,   // 자사·PG referrer는 버린다
    referrer_host:   ignored ? '' : host,
    in_app_browser:  inApp,
    channel,
    landing_page:    window.location.pathname,
    touch_at:        Date.now(),
  };
}

/**
 * 세션의 first-touch를 읽는다. 없으면 지금 값으로 만들어 저장한다.
 * @param {boolean} forceNew  새 세션이면 true — 기존 값을 버리고 다시 계산
 */
function _resolveFirstTouch(forceNew) {
  if (!forceNew) {
    const raw = _read(FIRST_TOUCH_KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') return saved;
      } catch {
        // 저장값이 깨졌으면 새로 계산한다
      }
    }
  }

  const touch = _computeTouch();
  try {
    _write(FIRST_TOUCH_KEY, JSON.stringify(touch));
  } catch {
    /* 저장 실패해도 이번 페이지 값은 그대로 쓴다 */
  }
  return touch;
}

/** 현재 세션의 first-touch 값 (sdk-A가 pageContext에 실어 보낸다) */
function getFirstTouch() {
  return _resolveFirstTouch(false);
}

export {
  initSession,
  configureSession,
  getSessionTtlMinutes,
  getFirstTouch,
  cleanUrl,
  touchSessionTimestamp,
  nextEventSeq,
  getLastEventTimestamp,
  setLastEventTimestamp,
  setPageContext,
  updatePageUrl,
  getPageContext,
  getSessionId,
};
