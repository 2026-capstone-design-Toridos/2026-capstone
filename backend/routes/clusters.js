/**
 * routes/clusters.js
 * ------------------
 * 클러스터 분석 결과 API
 *
 * GET /api/clusters          → cluster_profiles.json 전체 반환
 * GET /api/clusters/sessions → semantic_cluster_results.csv → JSON 반환
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const PROFILES_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/cluster_profiles.json'
);
const RESULTS_PATH  = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/semantic_cluster_results.csv'
);

// ── GET /api/clusters ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(PROFILES_PATH)) {
      return res.status(404).json({ error: 'cluster_profiles.json 없음. 클러스터링을 먼저 실행하세요.' });
    }
    const data = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf-8'));
    res.json(data);
  } catch (err) {
    console.error('[clusters] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/clusters/sessions ────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  try {
    if (!fs.existsSync(RESULTS_PATH)) {
      return res.status(404).json({ error: 'semantic_cluster_results.csv 없음.' });
    }
    const lines   = fs.readFileSync(RESULTS_PATH, 'utf-8').trim().split('\n');
    const headers = lines[0].split(',');
    const rows    = lines.slice(1).map(line => {
      const cols = line.split(',');
      return Object.fromEntries(headers.map((h, i) => [h.trim(), cols[i]?.trim()]));
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
