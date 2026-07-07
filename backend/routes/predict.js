/**
 * predict.js — 옛 /api/predict 클라이언트용 호환 라우트
 *
 * 지금은 분류 로직을 /api/classify와 Python 클러스터 서버가 맡고 있어서,
 * 이 라우트는 서버가 안 죽게 살려두면서 들어오는 요청을 그쪽으로 그대로 넘겨준다.
 */
const express = require('express');
const router = express.Router();

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';

// 분류 서버에 프록시 요청을 보내고 실패하면 그대로 에러를 던진다
async function callCluster(path, body) {
  const res = await fetch(`${CLUSTER_SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Cluster server error' }));
    throw Object.assign(new Error(err.error || 'Prediction failed'), { status: res.status });
  }

  return res.json();
}

router.get('/health', async (req, res) => {
  try {
    const r = await fetch(`${CLUSTER_SERVER}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    const python = await r.json();
    res.json({ status: 'ok', proxy: 'predict', python });
  } catch {
    res.status(503).json({ status: 'unavailable', proxy: 'predict', python: 'unreachable' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { session_id, tokens, events } = req.body || {};
    if (!Array.isArray(tokens) && !Array.isArray(events)) {
      return res.status(400).json({ error: 'tokens or events array is required' });
    }

    const result = await callCluster('/classify', { session_id, tokens, events });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
