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

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';

// pathname/page_url로 결제·장바구니·상품·검색 페이지를 구분한다
function inferPage(doc = {}) {
  const raw = `${doc.pathname || ''} ${doc.page_url || ''}`.toLowerCase();
  if (raw.includes('checkout') || raw.includes('payment') || raw.includes('order')) return 'checkout';
  if (raw.includes('cart') || raw.includes('basket')) return 'cart';
  if (raw.includes('product') || raw.includes('item') || raw.includes('prod_')) return 'product';
  if (raw.includes('search') || raw.includes('category') || raw.includes('collection')) return 'search';
  return 'home';
}

// 섹션 기반 클러스터링 보조 정보 — data 우선, 없으면 최상위 필드 fallback
function inferSection(doc = {}) {
  return doc.data?.section || doc.section || '';
}

// 클릭/호버 대상이 속한 화면 영역을 분류 서버 입력 형식으로 보존한다
function inferElementSection(doc = {}) {
  return doc.data?.element_section || doc.element_section || '';
}

// 주문완료 이벤트가 따로 없어 클릭/호버 문구로 주문 성공 여부를 판별
function isOrderSuccessDoc(doc = {}) {
  const text = `${doc.data?.hover_text || ''} ${doc.data?.click_text || ''}`;
  const target = `${doc.data?.hover_target || ''} ${doc.data?.click_target || ''}`.toLowerCase();
  return text.includes('주문이 완료') || target.includes('complete');
}

// DB에 쌓인 raw 이벤트를 클러스터 서버가 아는 액션 토큰으로 매핑
function normalizeEventType(doc = {}) {
  const eventType = String(doc.event_type || '');
  const page = inferPage(doc);

  if (isOrderSuccessDoc(doc)) return 'CLICK_BUY';
  if (eventType === 'purchase_click') return 'CLICK_BUY';
  if (eventType === 'add_to_cart') return 'ADD_CART';
  if (eventType === 'product_click') return page === 'product' ? 'ENTER_PRODUCT' : 'CLICK_ELEMENT';
  if (eventType === 'tab_exit') return 'TAB_OUT';
  if (eventType === 'tab_return') return 'TAB_RETURN';
  if (eventType === 'inactivity') return 'INACTIVE';
  if (eventType === 'search_use') return 'SEARCH_USE';
  if (eventType === 'hover_dwell') return 'HOVER_ELEMENT';
  if (eventType === 'section_exit') return 'EXIT_SESSION';
  if (eventType === 'session_start') return 'START_SESSION';
  if (eventType === 'click') return page === 'checkout' ? 'CLICK_BUY' : 'CLICK_ELEMENT';
  if (eventType === 'scroll_depth' || eventType === 'scroll_speed' || eventType === 'scroll_stop' || eventType === 'scroll_milestone') {
    if (page === 'product') return 'SCROLL_PRODUCT';
    if (page === 'home') return 'SCROLL_HOME';
  }
  return eventType;
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

    const completed = docs.some(isOrderSuccessDoc);

    // 클러스터 서버가 이해할 수 있는 이벤트 형식으로 정규화
    const events = docs.map((d) => ({
      event_type: normalizeEventType(d),
      page: inferPage(d),
      section: inferSection(d),
      element_section: inferElementSection(d),
    }));

    const result = await callCluster('/classify', {
      session_id: sessionId,
      events,
    });
    res.json({
      ...result,
      completed,
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
