/**
 * reportMetrics.js — 주간 보고서의 마케팅 지표 집계
 *
 * ml/report_marketing.py 가 읽는 metrics JSON을 만든다. 스키마는 ml/dev/sample_metrics.json 참고.
 *
 * 숫자가 대시보드(routes/logs.js)와 어긋나지 않게 하려고 세션 단위 정의를 새로 만들지 않고
 * logs.js 의 buildSessionPipeline / deriveSourceName / screenLabel / causeLabel 을 그대로 쓴다.
 *   - 주문 완료(completed)와 탐색 중지(risky) 판정은 파이프라인이 이미 계산한 값이다.
 *   - 채널 이름은 deriveSourceName 이 정한다.
 * 이 파일이 추가로 정하는 것은 "상품 조회 / 장바구니 / 결제 시작" 도달 여부뿐이다.
 *
 * 퍼널은 누적 도달로 센다. 주문을 완료한 세션은 결제 시작·장바구니·상품 조회를 거친 것으로 본다.
 * (비회원 구매 이벤트처럼 중간 화면 이벤트 없이 완료만 잡히는 세션이 있어, 이렇게 안 세면
 * 뒤 단계 숫자가 앞 단계보다 커지는 역전이 생긴다.)
 *
 * 시간은 모두 한국 시간(KST) 기준이다.
 */
const Event = require('../models/Event');
const { originCondition } = require('../middleware/siteAccess');
const { sessionHelpers } = require('../routes/logs');

const { buildSessionPipeline, deriveSourceName, screenLabel, causeLabel } = sessionHelpers;

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const QUERY_TIMEOUT_MS = Math.max(Number(process.env.REPORT_METRICS_QUERY_TIMEOUT_MS) || 30000, 1000);
const MAX_CHANNELS = 7;     // 이보다 많으면 나머지는 '기타'로 합친다
const TOP_ROWS = 3;

const DEVICE_LABEL = { mobile: '모바일', desktop: '데스크톱', tablet: '태블릿' };

// ── 파이프라인 확장 ───────────────────────────────────────────────────────────
// page_type(플랫폼 확정값)을 우선 보고, 값이 없던 구버전 데이터만 경로로 보충한다.
// 경로는 '^/product/' 처럼 맨 앞에서만 맞춘다. 'product'만 찾으면 /board/product/list.html
// (리뷰 게시판)까지 상품 상세로 잡힌다.
const BLANK_TYPE = { $in: [{ $ifNull: ['$page_type', ''] }, ['', 'UNKNOWN']] };
const pathMatches = (regex) => ({
  $regexMatch: { input: { $toLower: { $ifNull: ['$pathname', ''] } }, regex },
});
const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

const EXTRA_FIELDS = {
  group: {
    first_device: { $first: '$device_type' },
    first_at: { $first: '$received_at' },
    product_hits: countIf({
      $or: [
        { $eq: ['$page_type', 'PRODUCT'] },
        { $and: [BLANK_TYPE, pathMatches('^/(product|products|goods|item|items)/')] },
      ],
    }),
    cart_type_hits: countIf({ $eq: ['$page_type', 'CART'] }),
    checkout_type_hits: countIf({
      $or: [
        { $eq: ['$page_type', 'CHECKOUT'] },
        { $and: [BLANK_TYPE, pathMatches('orderform|checkout|payment')] },
      ],
    }),
  },
  project: {
    first_device: { $ifNull: ['$first_device', ''] },
    first_at: 1,
    product_hits: 1,
    cart_type_hits: 1,
    checkout_type_hits: 1,
  },
};

// ── 날짜 ──────────────────────────────────────────────────────────────────────
/** Date → 한국 날짜 문자열 'YYYY-MM-DD' */
function kstDateString(date = new Date()) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── 세션 → 단계 ───────────────────────────────────────────────────────────────
function reach(session) {
  const completed = Boolean(session.completed);
  const checkout = completed || session.checkout_type_hits > 0;
  const cart = checkout || session.cart_hits > 0 || session.cart_type_hits > 0;
  const product = cart || session.product_hits > 0;
  return { completed, checkout, cart, product };
}

function overviewOf(sessions) {
  const out = { sessions: sessions.length, product_sessions: 0, cart_sessions: 0, checkout_sessions: 0, orders: 0, risky_sessions: 0 };
  for (const s of sessions) {
    const r = reach(s);
    if (r.product) out.product_sessions += 1;
    if (r.cart) out.cart_sessions += 1;
    if (r.checkout) out.checkout_sessions += 1;
    if (r.completed) out.orders += 1;
    if (s.risky && !s.completed) out.risky_sessions += 1;
  }
  return out;
}

function funnelOf(overview) {
  return [
    { stage: '방문', sessions: overview.sessions },
    { stage: '상품 조회', sessions: overview.product_sessions },
    { stage: '장바구니', sessions: overview.cart_sessions },
    { stage: '결제 시작', sessions: overview.checkout_sessions },
    { stage: '주문 완료', sessions: overview.orders },
  ];
}

function channelsOf(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const name = deriveSourceName(s);
    const row = map.get(name) || { name, sessions: 0, product_sessions: 0, cart_sessions: 0, orders: 0 };
    const r = reach(s);
    row.sessions += 1;
    if (r.product) row.product_sessions += 1;
    if (r.cart) row.cart_sessions += 1;
    if (r.completed) row.orders += 1;
    map.set(name, row);
  }
  const rows = [...map.values()].sort((a, b) => b.sessions - a.sessions);
  if (rows.length <= MAX_CHANNELS + 1) return rows;
  const rest = rows.slice(MAX_CHANNELS).reduce(
    (acc, r) => ({
      name: '기타',
      sessions: acc.sessions + r.sessions,
      product_sessions: acc.product_sessions + r.product_sessions,
      cart_sessions: acc.cart_sessions + r.cart_sessions,
      orders: acc.orders + r.orders,
    }),
    { name: '기타', sessions: 0, product_sessions: 0, cart_sessions: 0, orders: 0 },
  );
  return [...rows.slice(0, MAX_CHANNELS), rest];
}

function devicesOf(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const name = DEVICE_LABEL[String(s.first_device || '').toLowerCase()] || '기타';
    const row = map.get(name) || { name, sessions: 0, cart_sessions: 0, orders: 0 };
    const r = reach(s);
    row.sessions += 1;
    if (r.cart) row.cart_sessions += 1;
    if (r.completed) row.orders += 1;
    map.set(name, row);
  }
  return [...map.values()].sort((a, b) => b.sessions - a.sessions);
}

/** 탐색 중지 세션만 모아 라벨별 상위 N개. share 는 대시보드와 같은 정수 % 이다. */
function topLabels(sessions, labelOf) {
  const risky = sessions.filter((s) => s.risky && !s.completed);
  const total = risky.length || 1;
  const map = new Map();
  for (const s of risky) {
    const key = labelOf(s);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ROWS)
    .map(([label, count]) => ({ label, sessions: count, share: Math.round((count / total) * 100) }));
}

/** 세션 시작 시각을 한국 시간 기준 시간대(0~23)·요일(월=0)로 센다. */
function timeOf(sessions) {
  const hourly = Array(24).fill(0);
  const weekday = Array(7).fill(0);
  for (const s of sessions) {
    if (!s.first_at) continue;
    const kst = new Date(new Date(s.first_at).getTime() + KST_OFFSET_MS);
    hourly[kst.getUTCHours()] += 1;
    weekday[(kst.getUTCDay() + 6) % 7] += 1;
  }
  return { hourly, weekday };
}

// ── 조회 ──────────────────────────────────────────────────────────────────────
function loadSessions(origin, from, to) {
  const filter = { ...originCondition(origin), received_at: { $gte: from, $lt: to } };
  return Event.aggregate(buildSessionPipeline(filter, EXTRA_FIELDS))
    .option({ maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: true });
}

/**
 * @param {string} origin
 * @param {{startDate: string, endDate: string}} period 한국 날짜 'YYYY-MM-DD' (양 끝 포함)
 * @returns 이번 기간과 직전 같은 길이 기간의 지표
 */
async function buildReportMetrics(origin, { startDate, endDate }) {
  const from = new Date(`${startDate}T00:00:00+09:00`);
  const to = new Date(new Date(`${endDate}T00:00:00+09:00`).getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new Error(`보고서 기간이 올바르지 않습니다: ${startDate} ~ ${endDate}`);
  }
  const span = to.getTime() - from.getTime();

  const [current, previous] = await Promise.all([
    loadSessions(origin, from, to),
    loadSessions(origin, new Date(from.getTime() - span), from),
  ]);

  const overview = overviewOf(current);
  return {
    period: { start: startDate, end: endDate, timezone: 'Asia/Seoul' },
    overview,
    prev_overview: overviewOf(previous),
    funnel: funnelOf(overview),
    channels: channelsOf(current),
    devices: devicesOf(current),
    exit_pages: topLabels(current, (s) => screenLabel(s.pathname, s.page_type)),
    exit_causes: topLabels(current, causeLabel),
    ...timeOf(current),
  };
}

module.exports = { buildReportMetrics, kstDateString };
