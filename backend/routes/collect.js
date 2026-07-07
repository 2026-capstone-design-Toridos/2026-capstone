/**
 * collect.js — SDK 이벤트 수집 API
 *
 * 역할: sender.js가 보낸 단일/배치 이벤트를 받아 origin·received_at 메타를 붙인 뒤
 *      MongoDB events 컬렉션에 bulk insert한다.
 *
 * POST /collect
 *   Body: { events: [eventObj, ...] } 또는 단일 eventObj
 */

const express = require('express');
const router  = express.Router();
const Event   = require('../models/Event');

// SDK 버퍼 전송 형식과 디버그용 단일 이벤트 형식을 모두 허용한다
router.post('/', async (req, res) => {
  try {
    const origin = req.headers.origin || req.headers.referer || null;

    const raw = req.body;
    const eventList = Array.isArray(raw.events)
      ? raw.events
      : [raw];

    if (eventList.length === 0) {
      return res.status(400).json({ error: 'events 배열이 비어 있습니다.' });
    }

    // 수신 시점 메타는 서버에서 붙여 원본 이벤트와 분리해 추적한다
    const docs = eventList.map((e) => ({ ...e, origin, received_at: new Date() }));
    await Event.insertMany(docs, { ordered: false });

    res.status(201).json({ ok: true, saved: docs.length });
  } catch (err) {
    // ordered:false라 partial success 가능 — 클라이언트에는 재전송 판단용 오류만 반환
    console.error('[collect] 저장 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
