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
const { spawn } = require('child_process');
const Event = require('../models/Event');

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';

const META_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/cluster_meta.json',
);
const RESULTS_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/semantic_cluster_results.csv',
);
const ML_DIR = path.resolve(__dirname, '../../ml');
const RETRAIN_SCRIPT = path.join(ML_DIR, 'retrain_centroids.py');
let clusteringJob = null;

function buildLabel(clusterId, profile, labels = {}) {
  if (labels[String(clusterId)]) return labels[String(clusterId)];
  const top = (profile.top_actions || []).slice(0, 2).map(a => a.action).join(' + ');
  return top ? `Cluster ${clusterId}: ${top}` : `Cluster ${clusterId}`;
}

function runPythonClustering({ full = true } = {}) {
  if (clusteringJob) return clusteringJob;

  const startedAt = new Date().toISOString();
  clusteringJob = new Promise((resolve, reject) => {
    const args = [RETRAIN_SCRIPT];
    if (full) args.push('--full');

    const child = spawn('python', args, {
      cwd: ML_DIR,
      env: { ...process.env },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `clustering exited with code ${code}`));
        return;
      }

      const meta = fs.existsSync(META_PATH)
        ? JSON.parse(fs.readFileSync(META_PATH, 'utf-8'))
        : {};
      resolve({
        ok: true,
        mode: full ? 'full' : 'ema',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        n_clusters: meta.num_clusters ?? null,
        retrain_session_count: meta.retrain_session_count ?? null,
        last_retrain: meta.last_retrain ?? null,
        message: '클러스터링이 완료되었습니다. 분류 서버를 재시작하면 새 기준이 반영됩니다.',
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-2000),
      });
    });
  }).finally(() => {
    clusteringJob = null;
  });

  return clusteringJob;
}

function inferPage(doc) {
  const raw = `${doc.pathname || ''} ${doc.page_url || ''}`.toLowerCase();
  if (raw.includes('checkout') || raw.includes('payment') || raw.includes('order')) return 'checkout';
  if (raw.includes('cart') || raw.includes('basket')) return 'cart';
  if (raw.includes('product') || raw.includes('item') || raw.includes('prod_')) return 'product';
  if (raw.includes('search') || raw.includes('category') || raw.includes('collection')) return 'search';
  return 'home';
}

async function classifySiteSessions(origin, profiles, labels) {
  const docs = await Event.find({ origin })
    .sort({ received_at: -1 })
    .limit(2500)
    .lean();

  const grouped = new Map();
  for (const doc of docs) {
    if (!doc.session_id) continue;
    const row = grouped.get(doc.session_id) || {
      session_id: doc.session_id,
      last_at: doc.received_at,
      events: [],
    };
    if (!row.last_at || new Date(doc.received_at) > new Date(row.last_at)) {
      row.last_at = doc.received_at;
    }
    row.events.push(doc);
    grouped.set(doc.session_id, row);
  }

  const sessions = [...grouped.values()]
    .sort((a, b) => new Date(b.last_at) - new Date(a.last_at))
    .slice(0, 120)
    .map((session) => ({
      session_id: session.session_id,
      events: session.events
        .sort((a, b) => (a.event_seq || a.timestamp || 0) - (b.event_seq || b.timestamp || 0))
        .slice(0, 128)
        .map((doc) => ({
          event_type: doc.event_type,
          page: inferPage(doc),
          section: doc.data?.section || doc.section || '',
          element_section: doc.data?.element_section || doc.element_section || '',
        })),
    }))
    .filter((session) => session.events.length > 0);

  if (!sessions.length) {
    return {
      total_sessions: 0,
      n_clusters: 0,
      noise_count: 0,
      clusters: [],
      source: 'site_live',
      origin,
    };
  }

  const res = await fetch(`${CLUSTER_SERVER}/classify/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `cluster server ${res.status}`);
  }

  const body = await res.json();
  const counts = new Map();
  let noiseCount = 0;
  for (const result of body.results || []) {
    const cid = Number(result.cluster_id);
    if (!Number.isFinite(cid) || cid < 0) {
      noiseCount += 1;
      continue;
    }
    counts.set(cid, (counts.get(cid) || 0) + 1);
  }

  const clusters = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([clusterId, count]) => {
      const profile = profiles[String(clusterId)] || {};
      return {
        cluster: clusterId,
        label: buildLabel(clusterId, profile, labels),
        count,
        top_actions: profile.top_actions || [],
        page_dist: profile.page_dist || {},
      };
    });

  return {
    total_sessions: sessions.length,
    n_clusters: clusters.length,
    noise_count: noiseCount,
    clusters,
    source: 'site_live',
    origin,
    sampled_sessions: sessions.length,
  };
}

router.get('/', async (req, res) => {
  try {
    if (!fs.existsSync(META_PATH)) {
      return res.status(404).json({
        error: 'cluster_meta.json not found. Run/export clustering artifacts first.',
      });
    }

    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
    const profiles = meta.cluster_profiles || {};
    const labels = meta.cluster_labels || {};

    if (req.query.origin) {
      const result = await classifySiteSessions(req.query.origin, profiles, labels);
      return res.json({ ...result, meta });
    }

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

router.post('/run', async (req, res) => {
  try {
    if (clusteringJob) {
      return res.status(409).json({
        error: '클러스터링이 이미 실행 중입니다.',
      });
    }

    const result = await runPythonClustering({ full: req.body?.full !== false });
    res.json(result);
  } catch (err) {
    console.error('[clusters/run] error:', err.message);
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
