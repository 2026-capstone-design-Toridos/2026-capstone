const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');

const RISK_EVENTS = ['tab_exit', 'inactivity', 'session_end', 'cart_abandon_flag'];

function prettySourceName(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '직접 방문';
  if (value.includes('notion')) return 'Notion';
  if (value.includes('instagram') || value.includes('insta')) return 'Instagram';
  if (value.includes('facebook')) return 'Facebook';
  if (value.includes('github')) return 'GitHub';
  if (value.includes('kakao')) return 'Kakao';
  if (value.includes('google')) return 'Google';
  if (value.includes('naver')) return 'Naver';
  return String(raw).replace(/^www\./i, '');
}

function hostFromUrl(raw) {
  if (!raw) return '';
  try {
    return new URL(raw).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function buildSessionPipeline(filter = {}) {
  return [
    { $match: filter },
    { $sort: { received_at: 1 } },
    {
      $group: {
        _id: '$session_id',
        session_id: { $last: '$session_id' },
        first_referrer: { $first: '$referrer' },
        first_utm_source: { $first: '$utm_source' },
        first_utm_campaign: { $first: '$utm_campaign' },
        last_at: { $last: '$received_at' },
        pathname: { $last: '$pathname' },
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
        completed_hits: {
          $sum: {
            $cond: [
              {
                $or: [
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
                  {
                    $regexMatch: {
                      input: {
                        $toLower: {
                          $concat: [
                            { $ifNull: ['$data.hover_target', ''] },
                            ' ',
                            { $ifNull: ['$data.click_target', ''] },
                          ],
                        },
                      },
                      regex: 'complete',
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
        utm_campaign: { $ifNull: ['$first_utm_campaign', ''] },
        last_at: 1,
        pathname: { $ifNull: ['$pathname', '/'] },
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
}

/**
 * GET /api/logs/sites
 * 이벤트가 수집된 사이트(origin) 목록 반환
 */
router.get('/sites', async (req, res) => {
  try {
    const sites = await Event.distinct('origin');
    res.json(sites.filter(Boolean).sort());
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
    if (req.query.origin) filter.origin = req.query.origin;

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

function screenLabel(pathname = '') {
  const path = String(pathname || '').toLowerCase();
  if (path.includes('checkout') || path.includes('payment') || path.includes('order')) return '결제 화면';
  if (path.includes('cart') || path.includes('basket')) return '장바구니';
  if (path.includes('product') || path.includes('item') || path.includes('prod_')) return '상품 상세';
  if (path.includes('search') || path.includes('category') || path.includes('collection')) return '검색/카테고리';
  return '홈 화면';
}

function deriveSourceName(session = {}) {
  return session.utm_source
    ? prettySourceName(session.utm_source)
    : prettySourceName(hostFromUrl(session.referrer));
}

function causeLabel(session = {}) {
  if (session.completed) return '주문 성공';
  if (session.checkout_hits > 0 && session.input_hits > 0) return '입력 도중 멈춤';
  if (session.cart_hits > 0) return '장바구니에서 멈춤';
  if (session.tab_exit_hits > 0) return '탭을 떠남';
  if (session.inactivity_hits > 0) return '화면을 보다가 멈춤';
  if (session.search_hits > 0) return '상품 탐색 중 멈춤';
  return '마지막 화면에서 멈춤';
}

router.get('/sessions', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50);
    const filter = {};
    if (req.query.origin) filter.origin = req.query.origin;

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

router.get('/operator-summary', async (req, res) => {
  try {
    const filter = {};
    if (req.query.origin) filter.origin = req.query.origin;

    const sessions = await Event.aggregate(buildSessionPipeline(filter));
    const riskySessions = sessions.filter((session) => session.risky && !session.completed);
    const totalRisky = riskySessions.length || 1;

    const blockedPagesMap = new Map();
    riskySessions.forEach((session) => {
      const key = screenLabel(session.pathname);
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
      const page = screenLabel(session.pathname);
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

    res.json({
      blocked_pages,
      issue_causes,
      priorities: priorities.slice(0, 3),
      source_performance,
      risky_session_count: riskySessions.length,
      total_sessions: sessions.length,
    });
  } catch (err) {
    console.error('[operator-summary] 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/sources', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 3, 1), 10);
    const filter = {};
    if (req.query.origin) filter.origin = req.query.origin;

    const sessions = await Event.aggregate(buildSessionPipeline(filter));
    const counts = new Map();
    for (const session of sessions) {
      const source = session.utm_source
        ? prettySourceName(session.utm_source)
        : prettySourceName(hostFromUrl(session.referrer));
      counts.set(source, (counts.get(source) || 0) + 1);
    }

    const sources = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

    res.json({
      total_sessions: sessions.length,
      sources,
    });
  } catch (err) {
    console.error('[sources] 오류:', err.message);
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

    if (req.query.origin)     filter.origin     = req.query.origin;
    if (req.query.event_type) filter.event_type = req.query.event_type;
    if (req.query.session_id) filter.session_id = req.query.session_id;
    if (req.query.since)      filter.received_at = { $gt: new Date(Number(req.query.since)) };

    const events = await Event.find(filter)
      .sort({ received_at: -1 })
      .limit(limit)
      .lean();

    res.json(events);
  } catch (err) {
    console.error('[logs] 조회 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
