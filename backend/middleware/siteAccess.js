/**
 * siteAccess.js — 사이트별 접근 제어 (멀티테넌시)
 *
 * 역할: "이 요청은 어느 쇼핑몰의 데이터를 볼 수 있는가"를 결정하는 단 하나의 지점.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 *  운영자 대시보드와 리포트 API에 사이트 구분이 없어서,
 *  A 쇼핑몰 운영자가 B 쇼핑몰의 세션·리포트·이탈 캡처를 볼 수 있었다.
 *  origin은 지금까지 "보기 필터"였을 뿐 "권한"이 아니었다.
 *
 * ── 어떻게 막는가 ────────────────────────────────────────────────
 *  사이트마다 접근 키를 발급하고, 키 → origin 매핑으로 조회 범위를 고정한다.
 *  클라이언트가 origin을 마음대로 지정할 수 없다. 키가 origin을 결정한다.
 *
 *  키 전달: X-GT-Key 헤더  (권장)
 *          ?key=... 쿼리   (최초 진입용. 대시보드가 즉시 URL에서 제거함)
 *
 * ── 나중에 로그인으로 바꾸려면 ───────────────────────────────────
 *  resolveOrigin() 하나만 세션 조회로 교체하면 된다.
 *  라우터들은 req.siteOrigin만 보므로 손댈 필요 없다.
 *
 * ── 환경변수 ────────────────────────────────────────────────────
 *  SITE_KEYS=키1:https://사이트1,키2:https://사이트2
 *
 *  설정하지 않으면 "개방 모드"로 동작한다(기존 동작 유지).
 *  로컬 개발용이며, 배포 환경에서는 반드시 설정해야 한다.
 * ───────────────────────────────────────────────────────────────
 */

// origin 문자열을 비교 가능한 형태로 정리한다 (대소문자, 끝 슬래시)
function normalizeOrigin(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
}

// SITE_KEYS 환경변수를 { 키: origin } 형태로 파싱한다
// 형식: "키1:https://사이트1,키2:https://사이트2"
function parseSiteKeys(raw) {
  const map = new Map();

  String(raw || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .forEach((pair) => {
      // origin에 ':'가 들어가므로(https://) 첫 번째 ':'에서만 자른다
      const splitAt = pair.indexOf(':');
      if (splitAt <= 0) return;

      const key    = pair.slice(0, splitAt).trim();
      const origin = normalizeOrigin(pair.slice(splitAt + 1));
      if (key && origin) map.set(key, origin);
    });

  return map;
}

const SITE_KEY_MAP = parseSiteKeys(process.env.SITE_KEYS);

/** 키가 하나도 설정되지 않은 상태 = 개방 모드 (로컬 개발용) */
function isOpenMode() {
  return SITE_KEY_MAP.size === 0;
}

// 요청에서 접근 키를 꺼낸다 (헤더 우선)
function extractKey(req) {
  return String(
    req.get('x-gt-key') || req.query.key || '',
  ).trim();
}

/**
 * 이 요청이 조회할 수 있는 origin을 결정한다.
 *
 * 나중에 로그인 방식으로 바꿀 때 이 함수만 교체하면 된다.
 *
 * @returns {{ ok: true, origin: string|null, openMode: boolean }
 *          | { ok: false, status: number, error: string }}
 */
function resolveOrigin(req) {
  // ── 개방 모드: 키 설정 전까지 기존 동작을 유지한다 ──────────────
  // 클라이언트가 지정한 origin을 그대로 쓴다. 배포 환경에서는 위험하다.
  if (isOpenMode()) {
    const requested = normalizeOrigin(req.query.origin || '');
    return { ok: true, origin: requested || null, openMode: true };
  }

  // ── 키 모드: 키가 origin을 결정한다 ────────────────────────────
  const key = extractKey(req);
  if (!key) {
    return { ok: false, status: 401, error: '접근 키가 필요합니다.' };
  }

  const origin = SITE_KEY_MAP.get(key);
  if (!origin) {
    return { ok: false, status: 403, error: '유효하지 않은 접근 키입니다.' };
  }

  return { ok: true, origin, openMode: false };
}

/**
 * 라우터 앞에 붙이는 미들웨어.
 * 통과하면 req.siteOrigin에 조회 가능한 origin이 담긴다.
 *
 * req.siteOrigin === null 이면 "전체 조회"를 뜻하며,
 * 이는 개방 모드에서만 발생한다.
 */
function requireSite(req, res, next) {
  const result = resolveOrigin(req);

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  req.siteOrigin  = result.origin;
  req.siteOpenMode = result.openMode;
  next();
}

/**
 * Mongo 쿼리에 붙일 origin 필터를 만든다.
 * siteOrigin이 없으면(개방 모드) 빈 객체를 반환해 기존 동작을 유지한다.
 */
function originFilter(req) {
  return req.siteOrigin ? { origin: req.siteOrigin } : {};
}

/** 서버 시작 시 현재 보호 상태를 알린다 */
function logAccessMode() {
  if (isOpenMode()) {
    console.warn(
      '[GhostTracker] ⚠️  SITE_KEYS 미설정 — 개방 모드로 동작합니다.\n' +
      '                  누구나 모든 쇼핑몰의 데이터를 조회할 수 있습니다.\n' +
      '                  배포 환경에서는 SITE_KEYS를 반드시 설정하세요.\n' +
      '                  예) SITE_KEYS=abc123:https://toridos.cafe24.com',
    );
  } else {
    console.log(`[GhostTracker] 사이트 접근 키 ${SITE_KEY_MAP.size}개 등록됨`);
  }
}

module.exports = {
  requireSite,
  resolveOrigin,
  originFilter,
  normalizeOrigin,
  isOpenMode,
  logAccessMode,
};
