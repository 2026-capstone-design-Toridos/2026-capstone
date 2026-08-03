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

    // SDK가 전송 실패 시 재시도하므로 같은 이벤트가 두 번 도착할 수 있다.
    // (서버가 저장은 했는데 응답만 유실된 경우를 클라이언트는 구분할 수 없다)
    // event_id unique 인덱스가 중복을 막고, 여기서 그 에러를 정상으로 처리한다.
    // ordered:false라 중복 하나 때문에 나머지 저장이 중단되지 않는다.
    let saved = 0;
    let duplicates = 0;

    try {
      const result = await Event.insertMany(docs, { ordered: false });
      saved = result.length;
    } catch (err) {
      // BulkWriteError: 일부는 저장되고 일부는 중복인 상황
      const isDuplicateOnly = err.code === 11000
        || (Array.isArray(err.writeErrors) && err.writeErrors.every((e) => e.err?.code === 11000 || e.code === 11000));

      if (!isDuplicateOnly) throw err;

      duplicates = Array.isArray(err.writeErrors) ? err.writeErrors.length : 1;
      saved = docs.length - duplicates;
    }

    // 중복은 "이미 저장됨"이므로 클라이언트에는 성공으로 응답한다.
    // 실패로 응답하면 SDK가 또 재시도해서 무한 반복된다.
    res.status(201).json({ ok: true, saved, duplicates });
  } catch (err) {
    console.error('[collect] 저장 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
