const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');

/**
 * POST /collect
 *
 * SDK sender.js 가 보내는 형식:
 *   { events: [ {...eventObj}, {...eventObj}, ... ] }
 *
 * 단일 이벤트도 허용:
 *   { ...eventObj }
 */
router.post('/', async (req, res) => {
  try {
    const origin = req.headers.origin || req.headers.referer || null;

    // 배열 or 단일 이벤트 둘 다 처리
    const raw = req.body;
    const eventList = Array.isArray(raw.events)
      ? raw.events
      : [raw];

    if (eventList.length === 0) {
      return res.status(400).json({ error: 'events 배열이 비어 있습니다.' });
    }

    // 수신 메타 주입 후 bulk insert
    const docs = eventList.map((e) => ({ ...e, origin, received_at: new Date() }));
    await Event.insertMany(docs, { ordered: false });

    res.status(201).json({ ok: true, saved: docs.length });
  } catch (err) {
    // ordered:false 로 partial success 가능하므로 insertedDocs 일부는 저장됨
    console.error('[collect] 저장 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
