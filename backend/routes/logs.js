const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');

/**
 * GET /api/logs
 *
 * 쿼리 파라미터:
 *   limit      최근 N건  (기본 100, 최대 1000)
 *   event_type 이벤트 타입 필터 (예: click, product_click)
 *   session_id 특정 세션만 조회
 *   since      epoch ms 이후 이벤트만 (실시간 폴링용)
 */
router.get('/', async (req, res) => {
  try {
    const limit      = Math.min(Number(req.query.limit) || 100, 1000);
    const filter     = {};

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

/**
 * GET /api/logs/stats
 *
 * 대시보드용 집계
 *   - 이벤트 타입별 카운트
 *   - 최근 1시간 이벤트 수
 *   - 활성 세션 수 (최근 30분 내 이벤트가 있는 session_id)
 */
router.get('/stats', async (req, res) => {
  try {
    const now        = new Date();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000);

    const [typeCounts, recentCount, activeSessions] = await Promise.all([
      // 이벤트 타입별 카운트 (전체)
      Event.aggregate([
        { $group: { _id: '$event_type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      // 최근 1시간 이벤트 수
      Event.countDocuments({ received_at: { $gte: oneHourAgo } }),
      // 활성 세션 수
      Event.distinct('session_id', { received_at: { $gte: thirtyMinAgo } }),
    ]);

    res.json({
      total:           await Event.estimatedDocumentCount(),
      last_hour:       recentCount,
      active_sessions: activeSessions.length,
      by_type:         Object.fromEntries(typeCounts.map((t) => [t._id, t.count])),
    });
  } catch (err) {
    console.error('[stats] 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
