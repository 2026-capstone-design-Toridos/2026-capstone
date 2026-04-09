const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');

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

    const [typeCounts, recentCount, activeSessions, total] = await Promise.all([
      Event.aggregate([
        { $match: filter },
        { $group: { _id: '$event_type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.countDocuments({ ...filter, received_at: { $gte: oneHourAgo } }),
      Event.distinct('session_id', { ...filter, received_at: { $gte: thirtyMinAgo } }),
      Event.countDocuments(filter),
    ]);

    res.json({
      total,
      last_hour:       recentCount,
      active_sessions: activeSessions.length,
      by_type:         Object.fromEntries(typeCounts.map((t) => [t._id, t.count])),
    });
  } catch (err) {
    console.error('[stats] 오류:', err.message);
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
