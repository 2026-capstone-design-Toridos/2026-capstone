/**
 * Compatibility route for older /api/predict clients.
 *
 * The current classifier is implemented by /api/classify and the Python
 * cluster server. This route keeps server startup working and forwards simple
 * prediction requests to that classifier.
 */
const express = require('express');
const router = express.Router();

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';

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
