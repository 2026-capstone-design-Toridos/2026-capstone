/**
 * routes/classify.js
 * ------------------
 * GhostTracker 실시간 세션 → 페르소나(클러스터) 분류 API
 * Python 추론 서버(cluster_server.py, port 5002)로 프록시한다.
 *
 * POST /api/classify
 *   Body: { session_id?, tokens?: string[] } | { session_id?, events?: object[] }
 *   → { cluster_id, persona, confidence, distances, seq_len, mode }
 *
 * POST /api/classify/batch
 *   Body: { sessions: [{ session_id?, tokens? | events? }, ...] }
 *   → { results: [...], count: number }
 *
 * POST /api/classify/session/:sessionId
 *   DB에서 해당 세션의 이벤트를 조회해 분류 (MongoDB 필요)
 *
 * GET /api/classify/health
 *   → { proxy: "ok", python: { status, mode, n_clusters } }
 */

const express = require('express');
const router  = express.Router();

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';

// ── 헬퍼: Python 클러스터 서버 호출 ──────────────────────────────────────────
async function callCluster(path, body) {
  const url = `${CLUSTER_SERVER}${path}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10_000),   // 10s timeout
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Python 서버 오류' }));
    throw Object.assign(
      new Error(err.error || '분류 실패'),
      { status: res.status },
    );
  }
  return res.json();
}

// ── POST /api/classify ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { session_id, tokens, events } = req.body;

    if (!Array.isArray(tokens) && !Array.isArray(events)) {
      return res.status(400).json({
        error: 'tokens 배열 또는 events 배열이 필요합니다.',
      });
    }

    const payload = { session_id };
    if (Array.isArray(tokens)) payload.tokens = tokens;
    else                        payload.events = events;

    const result = await callCluster('/classify', payload);
    res.json(result);
  } catch (err) {
    console.error('[classify] 오류:', err.message);
    if (err.message.includes('fetch') || err.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: '분류 서버에 연결할 수 없습니다. cluster_server.py가 실행 중인지 확인하세요.',
      });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /api/classify/batch ──────────────────────────────────────────────────
router.post('/batch', async (req, res) => {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(400).json({ error: 'sessions 배열이 필요합니다.' });
    }

    const result = await callCluster('/classify/batch', { sessions });
    res.json(result);
  } catch (err) {
    console.error('[classify/batch] 오류:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /api/classify/session/:sessionId  (DB 조회 기반) ─────────────────────
router.post('/session/:sessionId', async (req, res) => {
  try {
    const Event     = require('../models/Event');
    const { sessionId } = req.params;

    // DB에서 해당 세션 이벤트 조회 (최대 256개, 시간순)
    const docs = await Event.find({ session_id: sessionId })
      .sort({ event_seq: 1, timestamp: 1 })
      .limit(256)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({
        error: `session_id '${sessionId}' 이벤트 없음`,
      });
    }

    // 이미 토큰이 있으면 그대로, 없으면 이벤트 배열로 보내서 서버에서 변환
    const events = docs.map((d) => ({
      event_type: d.event_type,
      page:       d.page || '',
      section:    d.section || '',
      element_section: d.element_section || '',
    }));

    const result = await callCluster('/classify', {
      session_id: sessionId,
      events,
    });
    res.json(result);
  } catch (err) {
    console.error('[classify/session] 오류:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GET /api/classify/health ──────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const r = await fetch(`${CLUSTER_SERVER}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    const body = await r.json();
    res.json({ proxy: 'ok', python: body });
  } catch {
    res.status(503).json({ proxy: 'ok', python: 'unreachable' });
  }
});

module.exports = router;
