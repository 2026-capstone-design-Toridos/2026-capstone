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

/**
 * 수집 출처를 하나의 사이트로 통일한다.
 *
 * Cafe24는 모바일을 m.도메인으로 서비스한다. 그대로 두면 같은 쇼핑몰이
 * 대시보드 사이트 목록에 둘로 뜨고, 클러스터 스냅샷도 따로 생기고,
 * 접근 키도 두 개가 필요해진다.
 *
 * m. 접두어를 떼어 데스크톱 도메인 기준으로 합친다.
 * 기기 구분은 이미 device_type 필드가 하고 있다.
 */
function normalizeOrigin(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hostname = url.hostname.replace(/^m\./i, '');
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return raw;
  }
}

// SDK 버퍼 전송 형식과 디버그용 단일 이벤트 형식을 모두 허용한다
router.post('/', async (req, res) => {
  try {
    const origin = normalizeOrigin(req.headers.origin || req.headers.referer || null);

    const raw = req.body;

    // beacon은 text/plain으로 오기 때문에 파싱에 실패하면 문자열이 그대로 남는다.
    // 검증 없이 진행하면 쓰레기 문서가 DB에 쌓인다.
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ error: '이벤트 형식이 올바르지 않습니다.' });
    }

    const eventList = (Array.isArray(raw.events) ? raw.events : [raw])
      .filter((e) => e && typeof e === 'object' && typeof e.event_type === 'string');

    if (eventList.length === 0) {
      return res.status(400).json({ error: '저장할 이벤트가 없습니다.' });
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
