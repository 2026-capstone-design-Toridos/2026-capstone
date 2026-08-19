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

/**
 * DB에 저장된 origin의 표기 흔들림을 흡수하는 값 목록을 만든다.
 *
 * 실제 수집 데이터를 보면 끝 슬래시가 붙은 것과 안 붙은 것이 섞여 있다.
 *   "https://toridos.cafe24.com"        (슬래시 없음)
 *   "https://sy-mkct7xjeg-....app/"     (슬래시 있음)
 *
 * 정규화된 값 하나로만 exact match하면 슬래시가 붙은 쪽이 0건으로 나온다.
 * $in으로 두 형태를 모두 매칭한다. 정규식이 아니라 $in을 쓰는 이유는
 * origin 인덱스를 그대로 탈 수 있어서다.
 */
function originVariants(origin) {
  const base = normalizeOrigin(origin);
  return base ? [base, `${base}/`] : [];
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
// ── DB 키 캐시 ──────────────────────────────────────────────────
// 요청마다 DB를 조회하면 대시보드가 2.5초마다 갱신하는 구조에서 부하가 크다.
// 짧은 TTL 캐시를 두고, 발급·폐기 시에는 즉시 비운다.
const KEY_CACHE_TTL_MS = 60 * 1000;
const _keyCache = new Map();   // key → { origin | null, expires }

/** 발급·폐기 후 호출해 캐시를 즉시 무효화한다 */
function invalidateKeyCache(key) {
  if (key) _keyCache.delete(key);
  else _keyCache.clear();
}

// last_used_at을 매 요청마다 쓰면 DB 쓰기가 과해진다. 5분에 한 번만 갱신.
const USED_AT_THROTTLE_MS = 5 * 60 * 1000;
const _lastUsedWrite = new Map();

function _touchLastUsed(key) {
  const now = Date.now();
  if (now - (_lastUsedWrite.get(key) || 0) < USED_AT_THROTTLE_MS) return;
  _lastUsedWrite.set(key, now);

  try {
    // 실패해도 조회는 계속돼야 하므로 기다리지 않는다
    require('../models/SiteKey')
      .updateOne({ key }, { $set: { last_used_at: new Date() } })
      .catch(() => {});
  } catch {
    /* 모델 로드 실패 시 무시 */
  }
}

/** DB에서 키를 찾아 origin을 돌려준다 (폐기된 키는 무효) */
async function _lookupKeyInDb(key) {
  const cached = _keyCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.origin;

  let origin = null;
  try {
    const SiteKey = require('../models/SiteKey');
    const doc = await SiteKey.findOne({ key, revoked: false }).lean();
    origin = doc ? normalizeOrigin(doc.origin) : null;
  } catch {
    // DB 연결 문제 등 — 캐시에 담지 않고 이번 요청만 실패 처리
    return null;
  }

  _keyCache.set(key, { origin, expires: Date.now() + KEY_CACHE_TTL_MS });
  if (origin) _touchLastUsed(key);
  return origin;
}

/**
 * 이 요청이 조회할 수 있는 origin을 결정한다.
 *
 * 조회 순서: 환경변수(SITE_KEYS) → DB(SiteKey)
 * 환경변수를 먼저 보는 이유는 기존 배포와의 호환 때문이다.
 * 서버 시작 시 자동으로 DB에 이관되므로, 이관이 끝나면 환경변수를 지워도 된다.
 */
async function resolveOrigin(req) {
  const key = extractKey(req);

  // ── 개방 모드 판단 ─────────────────────────────────────────────
  // 환경변수도 없고 DB에도 키가 하나도 없을 때만 개방 모드다.
  // 예전에는 환경변수만 봤기 때문에, DB로 이관한 뒤 환경변수를 지우면
  // 갑자기 전체 공개로 풀리는 사고가 날 수 있었다.
  if (isOpenMode() && !(await _hasAnyDbKey())) {
    const requested = normalizeOrigin(req.query.origin || '');
    return { ok: true, origin: requested || null, openMode: true };
  }

  if (!key) {
    return { ok: false, status: 401, error: '접근 키가 필요합니다.' };
  }

  // 1순위: 환경변수
  const fromEnv = SITE_KEY_MAP.get(key);
  if (fromEnv) return { ok: true, origin: fromEnv, openMode: false };

  // 2순위: DB
  const fromDb = await _lookupKeyInDb(key);
  if (fromDb) return { ok: true, origin: fromDb, openMode: false };

  return { ok: false, status: 403, error: '유효하지 않은 접근 키입니다.' };
}

// DB에 유효한 키가 하나라도 있는지 (개방 모드 판정용). 짧게 캐시한다.
let _anyKeyCache = { value: false, expires: 0 };

async function _hasAnyDbKey() {
  if (_anyKeyCache.expires > Date.now()) return _anyKeyCache.value;
  let value = false;
  try {
    const SiteKey = require('../models/SiteKey');
    value = (await SiteKey.countDocuments({ revoked: false }).limit(1)) > 0;
  } catch {
    value = false;
  }
  _anyKeyCache = { value, expires: Date.now() + KEY_CACHE_TTL_MS };
  return value;
}

/**
 * 라우터 앞에 붙이는 미들웨어.
 * 통과하면 req.siteOrigin에 조회 가능한 origin이 담긴다.
 *
 * req.siteOrigin === null 이면 "전체 조회"를 뜻하며,
 * 이는 개방 모드에서만 발생한다.
 */
async function requireSite(req, res, next) {
  try {
    const result = await resolveOrigin(req);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    req.siteOrigin   = result.origin;
    req.siteOpenMode = result.openMode;
    next();
  } catch (err) {
    // 판정 자체가 실패하면 열어주지 않는다 (안전한 쪽으로)
    console.error('[siteAccess] 접근 판정 오류:', err.message);
    res.status(500).json({ error: '접근 확인 중 오류가 발생했습니다.' });
  }
}

/**
 * 서버 시작 시 환경변수(SITE_KEYS)의 키를 DB로 옮긴다.
 *
 * 이미 있는 키는 건드리지 않는다(멱등).
 * 이관이 끝나면 환경변수를 지워도 되고, 앞으로 사장님이 늘어나도
 * 서버 환경변수를 다시 만질 일이 없다.
 */
async function migrateEnvKeysToDb() {
  if (SITE_KEY_MAP.size === 0) return { migrated: 0, skipped: 0 };

  let migrated = 0;
  let skipped  = 0;

  try {
    const SiteKey = require('../models/SiteKey');

    for (const [key, origin] of SITE_KEY_MAP.entries()) {
      const exists = await SiteKey.findOne({ key }).lean();
      if (exists) { skipped += 1; continue; }

      await SiteKey.create({
        key,
        origin,
        label: `(환경변수에서 이관) ${origin.replace(/^https?:\/\//, '')}`,
        source: 'env',
      });
      migrated += 1;
    }

    if (migrated > 0) {
      console.log(`[GhostTracker] 환경변수 키 ${migrated}개를 DB로 이관했습니다.`);
      console.log('               이제 SITE_KEYS 환경변수를 지워도 됩니다.');
    }
    invalidateKeyCache();
    _anyKeyCache = { value: false, expires: 0 };
  } catch (err) {
    console.warn('[GhostTracker] 키 이관 실패(무시하고 계속):', err.message);
  }

  return { migrated, skipped };
}

/**
 * Mongo 쿼리에 붙일 origin 조건을 만든다.
 * siteOrigin이 없으면(개방 모드) 빈 객체를 반환해 기존 동작을 유지한다.
 *
 * @example
 *   const filter = { ...originFilter(req), event_type: 'click' };
 */
function originFilter(req) {
  const variants = originVariants(req.siteOrigin);
  return variants.length ? { origin: { $in: variants } } : {};
}

/** origin 문자열만 있을 때 쓰는 버전 (req가 없는 내부 함수용) */
function originCondition(origin) {
  const variants = originVariants(origin);
  return variants.length ? { origin: { $in: variants } } : {};
}

// ══════════════════════════════════════════════════════════════
//  관리자 인증 (키 발급 화면용)
// ══════════════════════════════════════════════════════════════
//
// 키를 발급하는 화면은 아무나 열면 안 된다. 누구나 아무 사이트의 키를
// 만들어 남의 데이터를 볼 수 있게 되어, 접근 제어 자체가 무의미해진다.
//
// 사이트 키(읽기)는 미설정 시 개방 모드로 뒀지만, 발급은 쓰기 작업이라
// 기준이 다르다. ADMIN_KEY가 없으면 관리 API 자체를 막는다.
// 실수로 설정을 빠뜨렸을 때 아무나 키를 찍어내는 것보다, 아예 안 되는 편이 낫다.

const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();

function isAdminEnabled() {
  return ADMIN_KEY.length > 0;
}

/** 관리 API 앞에 붙이는 미들웨어 */
function requireAdmin(req, res, next) {
  if (!isAdminEnabled()) {
    return res.status(503).json({
      error: '키 관리 기능이 비활성 상태입니다. 서버에 ADMIN_KEY를 설정하세요.',
    });
  }

  const provided = String(req.get('x-gt-admin-key') || req.query.admin_key || '').trim();
  if (!provided) {
    return res.status(401).json({ error: '관리자 키가 필요합니다.' });
  }
  if (provided !== ADMIN_KEY) {
    return res.status(403).json({ error: '관리자 키가 올바르지 않습니다.' });
  }

  next();
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
  requireAdmin,
  isAdminEnabled,
  migrateEnvKeysToDb,
  invalidateKeyCache,
  resolveOrigin,
  originFilter,
  originCondition,
  originVariants,
  normalizeOrigin,
  isOpenMode,
  logAccessMode,
};
