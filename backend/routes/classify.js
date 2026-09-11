/*
 * classify.js — GhostTracker 세션 분류 API
 * 역할: 실시간 세션을 페르소나(클러스터)로 분류, Python 추론 서버(cluster_server.py, 5002번 포트)로 그대로 넘겨줌
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

const { originCondition } = require('../middleware/siteAccess');

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';

// 주문완료 이벤트가 따로 없어 클릭/호버 문구로 주문 성공 여부를 판별
function isOrderSuccessDoc(doc = {}) {
  if (doc.event_type === 'guest_purchase') return true;
  const text = `${doc.data?.hover_text || ''} ${doc.data?.click_text || ''}`;
  const target = `${doc.data?.hover_target || ''} ${doc.data?.click_target || ''}`.toLowerCase();
  return text.includes('주문이 완료') || target.includes('complete');
}

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

    // 다른 쇼핑몰의 세션 ID를 알아내면 그 세션까지 분석할 수 있었다.
    // 조회 범위를 이 요청이 접근 가능한 사이트로 제한한다.
    const scope = { session_id: sessionId, ...originCondition(req.siteOrigin) };

    // 긴 세션의 앞부분만 남겨 구매·결제 신호가 잘리던 문제를 피하기 위해
    // 최근 이벤트를 넉넉히 읽은 뒤 다시 시간순으로 정렬한다.
    const docs = await Event.find(scope)
      .sort({ received_at: -1 })
      .limit(1000)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({
        error: `session_id '${sessionId}' 이벤트 없음`,
      });
    }

    const completed = docs.some(isOrderSuccessDoc);

    // raw 필드를 보내 Python이 학습 때와 같은 semantic mapper를 사용하게 한다.
    const events = docs
      .sort((a, b) => {
        const aTime = Number(a.timestamp) || new Date(a.received_at || 0).getTime();
        const bTime = Number(b.timestamp) || new Date(b.received_at || 0).getTime();
        return aTime - bTime || Number(a.event_seq || 0) - Number(b.event_seq || 0);
      })
      .map((d) => ({
        event_type: d.event_type,
        timestamp: Number(d.timestamp) || new Date(d.received_at || 0).getTime(),
        event_seq: d.event_seq,
        inter_event_gap: d.inter_event_gap,
        pathname: d.pathname,
        page_url: d.page_url,
        page_type: d.page_type || d.data?.page_type,
        data: d.data || {},
      }));

    const result = await callCluster('/classify', {
      session_id: sessionId,
      events,
    });
    res.json({
      ...result,
      completed,
      raw_event_count: events.length,
      meaningful_event_count: Number(result.seq_len) || 0,
    });
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
