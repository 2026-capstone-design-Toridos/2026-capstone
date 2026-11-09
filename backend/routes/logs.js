/**
 * logs.js — 운영자 화면 실시간 집계 API
 * 역할: Mongo events를 집계해 KPI·최근고객·문제원인을 내려줌
 */
const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');
const { originFilter, canonicalOrigin } = require('../middleware/siteAccess');
const { buildCommerceSummary } = require('../lib/commerceSummary');
const { buildOperationalInsights, dayStartKST } = require('../lib/operationalInsights');

const RISK_EVENTS = ['tab_exit', 'inactivity', 'session_end', 'cart_abandon_flag'];

// 손실·운영 지표 계산에 필요한 필드만 읽는다. data 전체를 선택하면
// data.source의 페이지 HTML까지 수천 건 전송되어 모바일의 8초 제한을 넘는다.
const OPERATIONAL_EVENT_PROJECTION = [
  'event_id',
  'session_id',
  'event_type',
  'page_type',
  'pathname',
  'page_url',
  'timestamp',
  'received_at',
  'product_id',
  'product_price',
  'product_currency',
  'data.product_id',
  'data.product_name',
  'data.currency',
  'data.price_currency',
  'data.product_price',
  'data.unit_price',
  'data.product_price_source',
  'data.subsection_id',
  'data.subsection',
  'data.subsection_label',
  'data.section_id',
  'data.section',
  'data.section_label',
].join(' ');

const OPERATIONAL_SIGNAL_TYPES = [
  'add_to_cart_success',
  'add_to_cart',
  'cart_add',
  'basket_add',
  'add_to_wishlist_success',
  'add_to_wishlist',
  'wishlist_add',
  'favorite_add',
  'remove_from_wishlist_success',
  'order_complete',
  'order_completed',
  'order_success',
  'purchase',
  'purchase_complete',
  'payment_complete',
  'payment_success',
  'guest_purchase',
  'member_purchase',
  'purchase_click',
  'enter_product',
  'product_click',
  'product_view',
  'view_product',
  'section_enter',
  'subsection_enter',
  'section_revisit',
  'subsection_revisit',
];

function operationalSignalFilter(baseFilter) {
  return {
    $and: [
      baseFilter,
      {
        $or: [
          { event_type: { $in: OPERATIONAL_SIGNAL_TYPES } },
          { product_id: { $exists: true, $nin: [null, ''] } },
          { 'data.product_id': { $exists: true, $nin: [null, ''] } },
          { page_type: 'ORDER_SUCCESS' },
          { pathname: { $regex: '/(?:product|order)/(?:[^/]+/)?(?:result|complete|success|\\d+)', $options: 'i' } },
          { page_url: { $regex: '/(?:product|order)/(?:[^/]+/)?(?:result|complete|success|\\d+)', $options: 'i' } },
        ],
      },
    ],
  };
}

// 상품 요약에 실제로 필요한 payload만 읽는다. data.source에는 수십~수백 KB의
// 페이지 HTML이 들어올 수 있어 data 전체를 projection하면 오늘 이벤트 몇 천 건만
//으로도 응답이 수십 초까지 늘어난다.
const COMMERCE_EVENT_PROJECTION = [
  'session_id',
  'event_type',
  'pathname',
  'page_url',
  'page_type',
  'received_at',
  'timestamp',
  'data.product_id',
  'data.product_name',
  'data.category_id',
  'data.category_name',
  'data.subsection_id',
  'data.subsection_label',
  'data.ghost_role',
  'data.click_text',
  'data.text',
  'data.target_text',
  'data.element_text',
  'data.button_text',
  'data.label',
].join(' ');

const COMMERCE_EVENT_TYPES = [
  'product_click',
  'enter_product',
  'enter_category',
  'subsection_enter',
  'add_to_cart',
  'add_to_cart_success',
  'cart_add',
  'basket_add',
  'view_cart',
  'cart_view',
  'add_to_wishlist',
  'add_to_wishlist_success',
  'wishlist_add',
  'wishlist_intent',
  'favorite_add',
  'begin_checkout',
  'checkout_start',
  'order_start',
  'purchase_click',
  'order_complete',
  'order_completed',
  'order_success',
  'purchase',
  'purchase_complete',
  'payment_complete',
  'payment_success',
  'guest_purchase',
  // 장바구니·찜·결제 버튼은 일반 click payload로 들어올 수 있다.
  'click',
];

function commerceEventFilter(baseFilter) {
  return {
    $and: [
      baseFilter,
      {
        $or: [
          { event_type: { $in: COMMERCE_EVENT_TYPES } },
          { pathname: { $regex: '/(?:product|category|order|cart|basket)(?:/|$)', $options: 'i' } },
          { page_url: { $regex: '/(?:product|category|order|cart|basket)(?:/|$)', $options: 'i' } },
        ],
      },
    ],
  };
}

// 유입값을 운영자가 알아보기 쉬운 채널명으로 바꿔준다
function prettySourceName(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'direct') return '직접 방문';
  if (value.includes('notion')) return 'Notion';
  if (value === 'ig' || value.includes('instagram') || value.includes('insta')) return 'Instagram';
  if (value.includes('threads')) return 'Threads';
  if (value.includes('facebook') || value.includes('fban')) return 'Facebook';
  if (value.includes('github')) return 'GitHub';
  if (value.includes('kakao')) return 'Kakao';
  if (value.includes('google')) return 'Google';
  if (value.includes('naver')) return 'Naver';
  if (value.includes('daum')) return 'Daum';
  if (value.includes('tiktok')) return 'TikTok';
  if (value.includes('youtube')) return 'YouTube';
  if (value.includes('line')) return 'Line';
  return String(raw).replace(/^www\./i, '');
}

// referrer에서 도메인만 추출
function hostFromUrl(raw) {
  if (!raw) return '';
  try {
    return new URL(raw).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 세션 단위로 묶어 이탈 위험 여부를 판정한다
// extra.group / extra.project 로 세션별 필드를 더 뽑을 수 있다(보고서 지표용).
// 완료·위험 판정 등 기존 필드는 그대로라 대시보드 결과는 달라지지 않는다.
function buildSessionPipeline(filter = {}, extra = {}) {
  const pipeline = [
    { $match: filter },
    { $sort: { received_at: 1 } },
    {
      $group: {
        _id: '$session_id',
        session_id: { $last: '$session_id' },
        // SDK가 세션 전체에 동일한 first-touch 값을 붙여주므로 $first로 하나만
        // 집어오면 된다. 예전에는 이 $first가 "도착 순서로 추정"하는 역할이라
        // 배치 전송 순서가 뒤집히면 틀린 유입 경로가 나왔다.
        first_referrer: { $first: '$referrer' },
        first_utm_source: { $first: '$utm_source' },
        first_utm_medium: { $first: '$utm_medium' },
        first_utm_campaign: { $first: '$utm_campaign' },
        first_channel: { $first: '$channel' },
        first_in_app: { $first: '$in_app_browser' },
        first_landing: { $first: '$landing_page' },
        last_at: { $last: '$received_at' },
        pathname: { $last: '$pathname' },
        page_type: { $last: '$page_type' },   // 마지막으로 머문 화면 종류
        count: { $sum: 1 },
        tab_exit_hits: {
          $sum: { $cond: [{ $eq: ['$event_type', 'tab_exit'] }, 1, 0] },
        },
        inactivity_hits: {
          $sum: { $cond: [{ $eq: ['$event_type', 'inactivity'] }, 1, 0] },
        },
        cart_hits: {
          $sum: {
            $cond: [
              {
                $regexMatch: {
                  input: {
                    $toLower: {
                      $concat: [
                        { $ifNull: ['$pathname', ''] },
                        ' ',
                        { $ifNull: ['$page_url', ''] },
                      ],
                    },
                  },
                  regex: 'cart|basket',
                },
              },
              1,
              0,
            ],
          },
        },
        checkout_hits: {
          $sum: {
            $cond: [
              {
                $regexMatch: {
                  input: {
                    $toLower: {
                      $concat: [
                        { $ifNull: ['$pathname', ''] },
                        ' ',
                        { $ifNull: ['$page_url', ''] },
                      ],
                    },
                  },
                  regex: 'checkout|payment|order',
                },
              },
              1,
              0,
            ],
          },
        },
        search_hits: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$event_type', 'search_use'] },
                  {
                    $regexMatch: {
                      input: {
                        $toLower: {
                          $concat: [
                            { $ifNull: ['$pathname', ''] },
                            ' ',
                            { $ifNull: ['$page_url', ''] },
                          ],
                        },
                      },
                      regex: 'search|category|collection',
                    },
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        input_hits: {
          $sum: {
            $cond: [
              { $in: ['$event_type', ['input_change', 'field_focus', 'field_blur']] },
              1,
              0,
            ],
          },
        },
        risky_hits: {
          $sum: {
            $cond: [{ $in: ['$event_type', RISK_EVENTS] }, 1, 0],
          },
        },
        // ── 주문 성공 판정 ───────────────────────────────────────
        //
        // 1순위: 주문 완료 페이지에 도달했는가 (page_type === 'ORDER_SUCCESS')
        //
        // 예전에는 클릭·호버 텍스트에 '주문이 완료'라는 문자열이 있는지로
        // 판정했다. 그러면 주문 완료 화면에서 사용자가 그 문구를 클릭하거나
        // 마우스를 올려야만 전환으로 집계된다. 결제하고 창을 닫으면 0건이라
        // 대시보드의 "주문 성공 수"가 실제 주문 수와 무관했다.
        //
        // 이제는 그 화면에 "도달"하기만 하면 잡힌다. 도달은 페이지 로드마다
        // 반드시 이벤트가 발생하므로 놓칠 수 없다.
        //
        // 아래 두 줄은 page_type이 없던 구버전 데이터를 위한 fallback이다.
        completed_hits: {
          $sum: {
            $cond: [
              {
                $or: [
                  // 주문 완료 SDK를 심을 수 없는 Cafe24 스킨의 전환 대리 기준
                  { $eq: ['$event_type', 'guest_purchase'] },

                  // 1순위 — 플랫폼이 알려준 확정값
                  { $eq: ['$page_type', 'ORDER_SUCCESS'] },

                  // fallback — 주문 완료 페이지 경로
                  {
                    $regexMatch: {
                      input: {
                        $toLower: {
                          $concat: [
                            { $ifNull: ['$pathname', ''] },
                            ' ',
                            { $ifNull: ['$page_url', ''] },
                          ],
                        },
                      },
                      regex: 'order_result|order_complete|/complete|/thank',
                    },
                  },

                  // fallback — 구버전 텍스트 판정 (기존 데이터 호환)
                  {
                    $regexMatch: {
                      input: {
                        $concat: [
                          { $ifNull: ['$data.hover_text', ''] },
                          ' ',
                          { $ifNull: ['$data.click_text', ''] },
                        ],
                      },
                      regex: '주문이 완료',
                    },
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        session_id: 1,
        referrer: { $ifNull: ['$first_referrer', ''] },
        utm_source: { $ifNull: ['$first_utm_source', ''] },
        utm_medium: { $ifNull: ['$first_utm_medium', ''] },
        utm_campaign: { $ifNull: ['$first_utm_campaign', ''] },
        channel: { $ifNull: ['$first_channel', ''] },
        in_app_browser: { $ifNull: ['$first_in_app', ''] },
        landing_page: { $ifNull: ['$first_landing', ''] },
        last_at: 1,
        pathname: { $ifNull: ['$pathname', '/'] },
        page_type: { $ifNull: ['$page_type', ''] },
        count: 1,
        tab_exit_hits: 1,
        inactivity_hits: 1,
        cart_hits: 1,
        checkout_hits: 1,
        search_hits: 1,
        input_hits: 1,
        completed: { $gt: ['$completed_hits', 0] },
        risky: {
          $cond: [
            { $gt: ['$completed_hits', 0] },
            false,
            { $gt: ['$risky_hits', 0] },
          ],
        },
      },
    },
  ];
  if (extra.group) Object.assign(pipeline[2].$group, extra.group);
  if (extra.project) Object.assign(pipeline[3].$project, extra.project);
  return pipeline;
}

/**
 * GET /api/logs/sites
 * 조회 가능한 사이트(origin) 목록 반환
 *
 * 접근 키가 설정된 경우 자기 사이트 하나만 돌려준다.
 * 예전에는 Event.distinct('origin')으로 수집된 모든 쇼핑몰 도메인을
 * 그대로 노출했고, 대시보드에서 남의 사이트를 골라볼 수 있었다.
 */
router.get('/sites', async (req, res) => {
  try {
    // 키 모드: 이 요청이 볼 수 있는 사이트는 하나뿐이다
    if (req.siteOrigin) {
      return res.json([canonicalOrigin(req.siteOrigin)]);
    }

    // 개방 모드(SITE_KEYS 미설정, 로컬 개발): 기존처럼 전체 목록
    const sites = await Event.distinct('origin');
    res.json([...new Set(sites.filter(Boolean).map(canonicalOrigin))].sort());
  } catch (err) {
    res.status(500).json({ error: '서버 오류' });
  }
});

/**
 * GET /api/logs/stats
 * 쿼리: origin (사이트 필터)
 */
router.get('/stats', async (req, res) => {
  try {
    const filter = {};
    Object.assign(filter, originFilter(req));   // 끝 슬래시 변형까지 매칭

    const now           = new Date();
    const oneHourAgo    = new Date(now - 60 * 60 * 1000);
    const thirtyMinAgo  = new Date(now - 30 * 60 * 1000);

    const [typeCounts, recentCount, activeSessions, visitorSessions, total] = await Promise.all([
      Event.aggregate([
        { $match: filter },
        { $group: { _id: '$event_type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.countDocuments({ ...filter, received_at: { $gte: oneHourAgo } }),
      Event.distinct('session_id', { ...filter, received_at: { $gte: thirtyMinAgo } }),
      Event.distinct('session_id', filter),
      Event.countDocuments(filter),
    ]);

    res.json({
      total,
      visitor_count:   visitorSessions.filter(Boolean).length,
      last_hour:       recentCount,
      active_sessions: activeSessions.length,
      by_type:         Object.fromEntries(typeCounts.map((t) => [t._id, t.count])),
    });
  } catch (err) {
    console.error('[stats] 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// pathname을 운영자가 보는 화면 이름으로 단순화
/**
 * 화면 이름을 운영자가 알아보는 말로 바꾼다.
 *
 * 1순위는 SDK가 실어 보낸 page_type(Layer 0 — 플랫폼 meta 확정값),
 * 없으면 pathname으로 추론한다. ml/semantic_event_mapper.py의 infer_page와
 * 같은 규칙을 쓴다. 두 곳이 어긋나면 대시보드와 분석 결과가 서로 다른
 * 화면을 가리키게 된다.
 *
 * 예전 규칙은 Cafe24에서 크게 틀렸다.
 *   /order/basket.html       '/order'가 먼저 걸려 장바구니가 '결제 화면'
 *   /order/order_result.html 주문 완료도 '결제 화면'
 *   /board/product/list.html 리뷰 게시판이 '상품 상세'
 *   /myshop, /member         전부 '홈 화면'
 */
const PAGE_TYPE_LABEL = {
  HOME:          '홈 화면',
  PRODUCT:       '상품 상세',
  CATEGORY:      '검색/카테고리',
  SEARCH:        '검색/카테고리',
  CART:          '장바구니',
  CHECKOUT:      '결제 화면',
  ORDER_SUCCESS: '주문 완료',
  REVIEW:        '리뷰',
  BOARD:         '게시판',
  MYPAGE:        '마이페이지',
  MEMBER:        '로그인/회원',
};

function firstSegment(path) {
  return String(path || '').replace(/^\/+/, '').split('/')[0].toLowerCase();
}

function screenLabel(pathname = '', pageType = '') {
  // 1순위: 플랫폼이 알려준 확정값
  const byType = PAGE_TYPE_LABEL[String(pageType || '').toUpperCase()];
  if (byType) return byType;

  // 2순위: 경로 추론 (구버전 데이터·비지원 플랫폼)
  const path = String(pathname || '').toLowerCase();
  const seg  = firstSegment(path);

  // 순서 주의: order_result → basket → orderform 순으로 봐야 한다
  if (path.includes('order_result') || path.includes('/complete')) return '주문 완료';
  if (path.includes('basket') || path.includes('/cart'))           return '장바구니';
  if (path.includes('orderform') || path.includes('checkout')
      || path.includes('payment') || path.includes('/pay'))        return '결제 화면';

  if (path.includes('/board')) return '게시판';
  if (seg === 'myshop' || seg === 'mypage') return '마이페이지';
  if (seg === 'member') return '로그인/회원';

  if (['product', 'products', 'item', 'items', 'goods', 'shop'].includes(seg)) {
    return path.includes('search') ? '검색/카테고리' : '상품 상세';
  }
  if (['category', 'categories', 'collection', 'collections'].includes(seg)) return '검색/카테고리';
  if (path.includes('search')) return '검색/카테고리';

  if (path === '' || path === '/' || path.includes('index.html')) return '홈 화면';
  return '기타 화면';
}

/**
 * 세션 하나의 대표 유입 채널 이름 뽑기
 *
 * 우선순위: SDK가 확정한 channel → utm_source → referrer 도메인 → 직접 방문
 *
 * channel은 신규 SDK가 붙여주는 값이라, 그게 있으면 서버에서 다시 추론할
 * 필요가 없다. UTM·인앱 브라우저·referrer를 이미 종합해 판정한 결과다.
 * 구버전 SDK로 수집된 기존 데이터를 위해 아래 경로를 fallback으로 남긴다.
 */
function deriveSourceName(session = {}) {
  if (session.channel) return prettySourceName(session.channel);
  if (session.in_app_browser) return prettySourceName(session.in_app_browser);
  if (session.utm_source) return prettySourceName(session.utm_source);
  return prettySourceName(hostFromUrl(session.referrer));
}

// 멈춘 흔적 우선순위대로 훑어서 가장 그럴듯한 이탈 원인 하나를 고른다
function causeLabel(session = {}) {
  if (session.completed) return '주문 성공';
  if (session.checkout_hits > 0 && session.input_hits > 0) return '입력 도중 멈춤';
  if (session.cart_hits > 0) return '장바구니에서 멈춤';
  if (session.tab_exit_hits > 0) return '탭을 떠남';
  if (session.inactivity_hits > 0) return '화면을 보다가 멈춤';
  if (session.search_hits > 0) return '상품 탐색 중 멈춤';
  return '마지막 화면에서 멈춤';
}

/**
 * GET /api/logs/sessions
 * 쿼리: limit, origin — 최근 세션을 한 행씩 묶어서 반환
 */
router.get('/sessions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50);
    const filter = {};
    Object.assign(filter, originFilter(req));   // 끝 슬래시 변형까지 매칭

    const sessions = await Event.aggregate([
      ...buildSessionPipeline(filter),
      { $sort: { last_at: -1 } },
      { $limit: limit },
    ]);

    res.json(sessions);
  } catch (err) {
    console.error('[sessions] 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

/**
 * GET /api/logs/operator-summary
 * 위험 세션을 모아 막히는 화면 · 원인 · 우선순위 · 채널 성과로 정리
 */

// Expensive insight queries have a short, tenant-scoped cache independent of live polling.
const operationalCache = new Map();
const dashboardSummaryCache = new Map();
const commerceSummaryCache = new Map();
const commerceSummaryInFlight = new Map();
const sourceSummaryCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 30 * 1000;
const COMMERCE_CACHE_TTL_MS = 5 * 60 * 1000;

function cachedDashboardValue(cache, key) {
  const row = cache.get(key);
  return row && Date.now() - row.at < DASHBOARD_CACHE_TTL_MS ? row.value : null;
}

function rememberDashboardValue(cache, key, value) {
  if (cache.size >= 100) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

function cachedCommerceValue(key) {
  const row = commerceSummaryCache.get(key);
  return row && Date.now() - row.at < COMMERCE_CACHE_TTL_MS ? row.value : null;
}

async function loadCommerceSummary(cacheKey, filter) {
  const cached = cachedCommerceValue(cacheKey);
  if (cached) return cached;
  if (commerceSummaryInFlight.has(cacheKey)) return commerceSummaryInFlight.get(cacheKey);

  const task = Event.find(commerceEventFilter(filter))
    .select(COMMERCE_EVENT_PROJECTION)
    .sort({ received_at: -1 })
    .limit(20000)
    .maxTimeMS(15000)
    .lean()
    .then((events) => {
      const value = buildCommerceSummary(events);
      if (commerceSummaryCache.size >= 100) commerceSummaryCache.delete(commerceSummaryCache.keys().next().value);
      commerceSummaryCache.set(cacheKey, { at: Date.now(), value });
      return value;
    })
    .finally(() => commerceSummaryInFlight.delete(cacheKey));

  commerceSummaryInFlight.set(cacheKey, task);
  return task;
}

router.get('/operator-insights', async (req, res) => {
  const origin = req.siteOrigin || req.query.origin;
  if (!origin) return res.status(400).json({ error: '분석할 쇼핑몰을 먼저 선택해주세요.' });

  const sessionId = req.query.session_id;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)) {
    return res.status(400).json({ error: '잘못된 방문 식별자입니다.' });
  }

  const cacheKey = JSON.stringify([canonicalOrigin(origin), sessionId || '']);
  const now = Date.now();
  const cached = operationalCache.get(cacheKey);
  if (cached && now - cached.at < 20000) return res.json(cached.value);

  try {
    const filter = { ...originFilter(req) };
    if (!Object.keys(filter).length) return res.status(400).json({ error: '사이트 범위를 확인할 수 없습니다.' });
    if (sessionId) filter.session_id = sessionId;
    else filter.received_at = { $gte: new Date(dayStartKST(now) - 30 * 60000), $lte: new Date(now) };

    const limit = sessionId ? 5000 : 30000;
    const [rows, sessionMarkers] = await Promise.all([
      Event.find(operationalSignalFilter(filter))
        .select(OPERATIONAL_EVENT_PROJECTION)
        .sort({ received_at: -1 })
        .limit(limit + 1)
        .maxTimeMS(12000)
        .lean(),
      // 신호 이벤트만 읽어도 활성/종료 판정은 전체 방문의 마지막 활동 시각을
      // 사용해야 한다. 세션당 한 행만 추가해 기존 판정 정확도를 유지한다.
      Event.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$session_id',
            received_at: { $max: '$received_at' },
            timestamp: { $max: '$timestamp' },
          },
        },
        {
          $project: {
            _id: 0,
            session_id: '$_id',
            event_type: { $literal: '__session_last__' },
            received_at: 1,
            timestamp: 1,
          },
        },
      ]).option({ maxTimeMS: 12000 }),
    ]);
    const value = buildOperationalInsights(rows.slice(0, limit).concat(sessionMarkers), {
      now,
      truncated: rows.length > limit,
      selection: Boolean(sessionId),
      start: sessionId ? 0 : dayStartKST(now),
    });

    if (operationalCache.size >= 100) operationalCache.delete(operationalCache.keys().next().value);
    operationalCache.set(cacheKey, { at: now, value });
    return res.json(value);
  } catch (err) {
    console.error('[operator-insights]', err.message);
    const stale = operationalCache.get(cacheKey)?.value;
    if (stale) return res.json({ ...stale, stale: true });
    return res.status(500).json({ error: '운영 지표를 불러오지 못했습니다.' });
  }
});

router.get('/commerce-summary', async (req, res) => {
  const cacheKey = canonicalOrigin(req.siteOrigin || req.query.origin || '') || '__all__';
  const now = Date.now();
  const filter = { received_at: { $gte: new Date(dayStartKST(now)), $lte: new Date(now) } };
  Object.assign(filter, originFilter(req));

  try {
    return res.json(await loadCommerceSummary(cacheKey, filter));
  } catch (err) {
    console.error('[commerce-summary] 오류:', err.message);
    const stale = commerceSummaryCache.get(cacheKey)?.value;
    if (stale) return res.json({ ...stale, stale: true });
    return res.status(503).json({ error: '상품 행동 집계가 지연되고 있습니다.' });
  }
});

router.get('/operator-summary', async (req, res) => {
  const cacheKey = canonicalOrigin(req.siteOrigin || req.query.origin || '') || '__all__';
  const cached = cachedDashboardValue(dashboardSummaryCache, cacheKey);
  if (cached) return res.json(cached);

  try {
    const now = Date.now();
    const filter = { received_at: { $gte: new Date(dayStartKST(now)), $lte: new Date(now) } };
    Object.assign(filter, originFilter(req));   // 끝 슬래시 변형까지 매칭

    // 손실·운영 요약은 빠른 세션 집계만 기다린다. 상품 행동은 별도 API에서
    // 느리게 갱신하므로 이 쿼리가 대시보드 전체 연결 상태를 막지 않는다.
    const sessions = await Event.aggregate(buildSessionPipeline(filter)).option({ maxTimeMS: 7000 });
    const riskySessions = sessions.filter((session) => session.risky && !session.completed);
    const totalRisky = riskySessions.length || 1;

    const blockedPagesMap = new Map();
    riskySessions.forEach((session) => {
      const key = screenLabel(session.pathname, session.page_type);
      blockedPagesMap.set(key, (blockedPagesMap.get(key) || 0) + 1);
    });
    const blocked_pages = [...blockedPagesMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => ({
        label,
        count,
        share: Math.round((count / totalRisky) * 100),
      }));

    const causeMap = new Map();
    riskySessions.forEach((session) => {
      const key = causeLabel(session);
      causeMap.set(key, (causeMap.get(key) || 0) + 1);
    });
    const issue_causes = [...causeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => ({
        label,
        count,
        share: Math.round((count / totalRisky) * 100),
      }));

    const sourceMap = new Map();
    sessions.forEach((session) => {
      const key = deriveSourceName(session);
      const row = sourceMap.get(key) || {
        name: key,
        total: 0,
        completed: 0,
        risky: 0,
        pageCounts: new Map(),
      };
      row.total += 1;
      if (session.completed) row.completed += 1;
      if (session.risky) row.risky += 1;
      const page = screenLabel(session.pathname, session.page_type);
      row.pageCounts.set(page, (row.pageCounts.get(page) || 0) + 1);
      sourceMap.set(key, row);
    });

    const source_performance = [...sourceMap.values()]
      .map((row) => {
        const topPage = [...row.pageCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '홈 화면';
        return {
          name: row.name,
          total: row.total,
          completed: row.completed,
          risky: row.risky,
          completion_rate: row.total ? Math.round((row.completed / row.total) * 100) : 0,
          risk_rate: row.total ? Math.round((row.risky / row.total) * 100) : 0,
          top_page: topPage,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 4);

    const priorities = [];
    if (blocked_pages[0]) {
      priorities.push({
        title: `${blocked_pages[0].label} 점검`,
        detail: `${blocked_pages[0].label}에서 탐색 중지 세션이 가장 많습니다. 첫 화면 문구, 버튼 위치, 다음 행동 안내를 먼저 점검하세요.`,
      });
    }
    if (issue_causes[0]) {
      priorities.push({
        title: `${issue_causes[0].label} 대응`,
        detail: `${issue_causes[0].label} 패턴이 가장 많이 보입니다. 멈춘 지점 바로 위에 안내 문구나 혜택 정보를 보강하는 것이 좋습니다.`,
      });
    }
    const riskySource = source_performance
      .filter((source) => source.total >= 3)
      .sort((a, b) => b.risk_rate - a.risk_rate)[0];
    if (riskySource) {
      priorities.push({
        title: `${riskySource.name} 유입 보강`,
        detail: `${riskySource.name} 유입 고객은 탐색 중지 비율이 ${riskySource.risk_rate}%입니다. 랜딩 화면과 첫 메시지를 이 채널에 맞게 조정해보세요.`,
      });
    }

    const value = {
      blocked_pages,
      issue_causes,
      priorities: priorities.slice(0, 3),
      source_performance,
      risky_session_count: riskySessions.length,
      total_sessions: sessions.length,
    };
    rememberDashboardValue(dashboardSummaryCache, cacheKey, value);
    res.json(value);
  } catch (err) {
    console.error('[operator-summary] 오류:', err.message);
    const stale = dashboardSummaryCache.get(cacheKey)?.value;
    if (stale) return res.json({ ...stale, stale: true });
    res.status(500).json({ error: '서버 오류' });
  }
});

/**
 * GET /api/logs/period-report
 * 선택 기간의 전체 이벤트와 세션을 DB에서 직접 집계한다. 대시보드가 최근
 * 200개 이벤트/8개 세션만 들고 있으므로 브라우저 상태로 기간 리포트를
 * 계산하면 모든 기간이 같은 값으로 보이는 문제가 있었다.
 */
router.get('/period-report', async (req, res) => {
  try {
    const start = new Date(String(req.query.start || ''));
    const end = new Date(String(req.query.end || ''));
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return res.status(400).json({ error: '올바른 시작일과 종료일이 필요합니다.' });
    }

    const filter = {
      ...originFilter(req),
      received_at: { $gte: start, $lte: end },
    };
    const [eventCount, sessions] = await Promise.all([
      Event.countDocuments(filter),
      Event.aggregate(buildSessionPipeline(filter)),
    ]);
    const completed = sessions.filter((session) => session.completed);
    const risky = sessions.filter((session) => session.risky && !session.completed);

    const blockedMap = new Map();
    const causeMap = new Map();
    const sourceMap = new Map();
    for (const session of sessions) {
      const source = deriveSourceName(session);
      const sourceRow = sourceMap.get(source) || { name: source, total: 0, completed: 0, risky: 0 };
      sourceRow.total += 1;
      if (session.completed) sourceRow.completed += 1;
      if (session.risky) sourceRow.risky += 1;
      sourceMap.set(source, sourceRow);
      if (!session.risky || session.completed) continue;
      const page = screenLabel(session.pathname, session.page_type);
      blockedMap.set(page, (blockedMap.get(page) || 0) + 1);
      const cause = causeLabel(session);
      causeMap.set(cause, (causeMap.get(cause) || 0) + 1);
    }

    const topRows = (map) => [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label, count]) => ({ label, count }));
    const sources = [...sourceMap.values()]
      .map((row) => ({
        ...row,
        completion_rate: row.total ? Math.round((row.completed / row.total) * 100) : 0,
        risk_rate: row.total ? Math.round((row.risky / row.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    res.json({
      start: start.toISOString(),
      end: end.toISOString(),
      visitor_count: sessions.length,
      event_count: eventCount,
      completed_count: completed.length,
      completion_rate: sessions.length ? Math.round((completed.length / sessions.length) * 100) : 0,
      risky_count: risky.length,
      blocked_pages: topRows(blockedMap),
      issue_causes: topRows(causeMap),
      source_performance: sources,
    });
  } catch (err) {
    console.error('[period-report] 오류:', err.message);
    res.status(500).json({ error: '기간 리포트를 집계하지 못했습니다.' });
  }
});

/**
 * GET /api/logs/sources
 * 쿼리: limit, origin — 유입 채널별 세션 수 TOP N
 */
router.get('/sources', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 3, 1), 10);
  const cacheKey = `${canonicalOrigin(req.siteOrigin || req.query.origin || '') || '__all__'}:${limit}`;
  const cached = cachedDashboardValue(sourceSummaryCache, cacheKey);
  if (cached) return res.json(cached);

  try {
    const now = Date.now();
    const filter = { received_at: { $gte: new Date(dayStartKST(now)), $lte: new Date(now) } };
    Object.assign(filter, originFilter(req));   // 끝 슬래시 변형까지 매칭

    const sessions = await Event.aggregate(buildSessionPipeline(filter));
    const counts = new Map();
    for (const session of sessions) {
      // deriveSourceName과 같은 규칙을 쓴다 (예전엔 여기만 따로 판정해 결과가 갈렸다)
      const source = deriveSourceName(session);
      counts.set(source, (counts.get(source) || 0) + 1);
    }

    const sources = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

    const value = {
      total_sessions: sessions.length,
      sources,
    };
    rememberDashboardValue(sourceSummaryCache, cacheKey, value);
    res.json(value);
  } catch (err) {
    console.error('[sources] 오류:', err.message);
    const stale = sourceSummaryCache.get(cacheKey)?.value;
    if (stale) return res.json({ ...stale, stale: true });
    res.status(500).json({ error: '서버 오류' });
  }
});

/**
 * GET /api/logs
 * 쿼리: limit, event_type, session_id, since, origin
 */
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 100, 1000);
    const filter = {};

    Object.assign(filter, originFilter(req));
    if (req.query.event_type) filter.event_type = req.query.event_type;
    if (req.query.session_id) filter.session_id = req.query.session_id;
    if (req.query.since)      filter.received_at = { $gt: new Date(Number(req.query.since)) };

    const events = await Event.find(filter)
      // 타임라인에는 수집 당시의 페이지 HTML 원문이 필요하지 않다. 이 필드는
      // 한 세션에서 수백 MB까지 커져 고객 분석 버튼을 수분간 멈추게 할 수 있다.
      .select('-data.source')
      .sort({ received_at: -1 })
      .limit(limit)
      .maxTimeMS(15000)
      .lean();

    res.json(events);
  } catch (err) {
    console.error('[logs] 조회 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
// 보고서 지표 집계(lib/reportMetrics.js)가 대시보드와 같은 세션·채널 정의를 쓰도록 노출한다.
module.exports.sessionHelpers = { buildSessionPipeline, deriveSourceName, screenLabel, causeLabel };
