/**
 * routes/clusters.js
 * ------------------
 * Cluster analysis result API.
 *
 * GET /api/clusters
 *   Returns dashboard-ready cluster metadata from cluster_meta.json.
 *
 * GET /api/clusters/sessions
 *   Returns semantic_cluster_results.csv as JSON when that optional file exists.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const META_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/cluster_meta.json',
);
const RESULTS_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/semantic_cluster_results.csv',
);

function buildLabel(clusterId, profile, labels = {}) {
  if (labels[String(clusterId)]) return labels[String(clusterId)];
  const top = (profile.top_actions || []).slice(0, 2).map(a => a.action).join(' + ');
  return top ? `Cluster ${clusterId}: ${top}` : `Cluster ${clusterId}`;
}

router.get('/', (req, res) => {
  try {
    if (!fs.existsSync(META_PATH)) {
      return res.status(404).json({
        error: 'cluster_meta.json not found. Run/export clustering artifacts first.',
      });
    }

    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
    const profiles = meta.cluster_profiles || {};
    const labels = meta.cluster_labels || {};
    const clusters = Object.entries(profiles).map(([clusterId, profile]) => ({
      cluster: Number(clusterId),
      label: buildLabel(clusterId, profile, labels),
      count: profile.count || 0,
      top_actions: profile.top_actions || [],
      page_dist: profile.page_dist || {},
    }));

    res.json({
      total_sessions: clusters.reduce((sum, c) => sum + c.count, 0),
      n_clusters: meta.num_clusters ?? clusters.length,
      silhouette: meta.silhouette ?? null,
      davies_bouldin: meta.davies_bouldin ?? null,
      noise_count: meta.noise_count ?? 0,
      clusters,
      meta,
    });
  } catch (err) {
    console.error('[clusters] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions', (req, res) => {
  try {
    if (!fs.existsSync(RESULTS_PATH)) {
      return res.status(404).json({ error: 'semantic_cluster_results.csv not found.' });
    }
    const lines = fs.readFileSync(RESULTS_PATH, 'utf-8').trim().split('\n');
    const headers = lines[0].split(',');
    const rows = lines.slice(1).map(line => {
      const cols = line.split(',');
      return Object.fromEntries(headers.map((h, i) => [h.trim(), cols[i]?.trim()]));
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
