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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const META_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/cluster_meta.json',
);
const RESULTS_PATH = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/semantic_cluster_results.csv',
);
const SNAPSHOT_DIR = path.resolve(
  __dirname, '../../ml/output/unsupervised_semantic/site_snapshots',
);
const ML_DIR = path.resolve(__dirname, '../../ml');
const RETRAIN_SCRIPT = path.join(ML_DIR, 'retrain_centroids.py');
let clusteringJob = null;

function snapshotKey(origin = '') {
  return String(origin || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._-]+/g, '_');
}

function snapshotPath(origin = '') {
  return path.join(SNAPSHOT_DIR, `${snapshotKey(origin)}.json`);
}

function saveSiteSnapshot(origin, payload) {
  if (!origin) return;
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(origin), JSON.stringify({
    ...payload,
    source: 'site_snapshot',
    origin,
    snapshot_origin: origin,
    snapshot_saved_at: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function loadSiteSnapshot(origin) {
  if (!origin) return null;
  const target = snapshotPath(origin);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf-8'));
}

function buildLabel(clusterId, profile, labels = {}) {
  if (labels[String(clusterId)]) return labels[String(clusterId)];
  const top = (profile.top_actions || []).slice(0, 2).map(a => a.action).join(' + ');
  return top ? `Cluster ${clusterId}: ${top}` : `Cluster ${clusterId}`;
}

function normalizeText(text) {
  return String(text || '').replaceAll('\uC774\uD0C8', '탐색 중지');
}

function koAction(action) {
  const labels = {
    SCROLL_HOME: '홈 화면 스크롤',
    SCROLL_PRODUCT: '상품 페이지 스크롤',
    SCROLL_PAGE: '페이지 스크롤',
    ENTER_CATEGORY: '카테고리 진입',
    ENTER_PRODUCT: '상품 상세 진입',
    ENTER_CHECKOUT: '결제 화면 진입',
    VIEW_PRODUCT: '상품 확인',
    VIEW_REVIEW: '리뷰 확인',
    ZOOM_IMAGE: '상품 이미지 확대',
    HOVER_ELEMENT: '요소 위에 머무름',
    CLICK_ELEMENT: '버튼 또는 메뉴 클릭',
    SEARCH_USE: '검색 사용',
    CHECK_PRICE: '가격 확인',
    CHECK_SIZE: '사이즈 확인',
    CHECK_SHIPPING: '배송 정보 확인',
    START_INPUT: '입력 시작',
    EDIT_INPUT: '입력 수정',
    EXIT_BOUNCE: '빠른 탐색 중지',
    EXIT_SESSION: '탐색 중지',
    INACTIVE: '움직임 없음',
    RAGE_CLICK: '반복 클릭',
    CHANGE_QUANTITY: '수량 변경',
  };
  return labels[action] || String(action || '').replaceAll('_', ' ').toLowerCase();
}

function fallbackNlpLabel(clusterId, profile = {}) {
  const actions = (profile.top_actions || []).map((a) => a.action);
  const top3 = actions.slice(0, 3);
  const hasPageData = Object.keys(profile.page_dist || {}).length > 0;
  let name = '행동 데이터 부족 고객';
  let summary = '세션은 확인됐지만 대표 행동이나 방문 화면 정보가 부족해 패턴을 명확히 해석하기 어렵습니다.';
  let action = 'SDK 수집 상태와 페이지별 이벤트 매핑을 먼저 점검해 행동 데이터가 충분히 쌓이도록 보완하세요.';

  if (!actions.length && !hasPageData) {
    return { name, summary, action, source: 'fallback' };
  }

  if (top3.includes('ENTER_CHECKOUT') || top3.includes('START_INPUT') || top3.includes('EDIT_INPUT')) {
    name = '결제 단계에서 망설이는 고객';
  } else if (top3.includes('EXIT_BOUNCE') || top3.includes('EXIT_SESSION') || top3.includes('INACTIVE')) {
    name = '탐색을 빠르게 멈추는 고객';
  } else if (top3.includes('ENTER_CATEGORY') || top3.includes('SEARCH_USE')) {
    name = '상품을 찾고 비교하는 고객';
  } else if (top3.includes('CHECK_PRICE') || top3.includes('CHECK_SIZE') || top3.includes('CHECK_SHIPPING')) {
    name = '구매 조건을 확인하는 고객';
  } else if (top3.includes('VIEW_REVIEW') || top3.includes('ZOOM_IMAGE')) {
    name = '후기와 이미지를 확인하는 고객';
  } else if (top3.includes('SCROLL_HOME') || top3.includes('SCROLL_PRODUCT')) {
    name = '페이지를 훑어보는 고객';
  }
  summary = `${(profile.top_actions || []).slice(0, 3).map((a) => koAction(a.action)).join(', ') || '행동 패턴'} 중심으로 묶인 고객 유형입니다.`;
  action = '이 유형의 주요 행동이 많은 화면을 점검하고, 다음 행동으로 이어지는 안내 문구를 보강하세요.';

  return {
    name,
    summary,
    action,
    source: 'fallback',
  };
}

function clusterValidation(clusterId, profile = {}, count = 0, total = 0, meta = {}) {
  const topActions = profile.top_actions || [];
  const pageDist = profile.page_dist || {};
  const hasActions = topActions.length > 0;
  const hasPages = Object.keys(pageDist).length > 0;
  const share = total ? count / total : 0;
  const stability = meta.cluster_quality?.stability?.per_cluster?.[String(clusterId)] ?? null;
  let status = 'verified';
  let label = '검증 통과';
  const reasons = [];

  if (!hasActions || !hasPages) {
    status = 'insufficient';
    label = '데이터 부족';
    reasons.push('대표 행동 또는 방문 화면 근거가 부족합니다.');
  }
  if (count < 5) {
    status = status === 'insufficient' ? status : 'weak';
    label = status === 'insufficient' ? label : '검증 필요';
    reasons.push('세션 수가 적어 안정성이 낮을 수 있습니다.');
  }
  if (share > 0 && share < 0.05) {
    status = status === 'verified' ? 'weak' : status;
    label = status === 'verified' ? '검증 필요' : label;
    reasons.push('전체 세션에서 차지하는 비중이 작습니다.');
  }
  if (stability !== null && stability < 0.35) {
    status = status === 'verified' ? 'weak' : status;
    label = status === 'verified' ? '검증 필요' : label;
    reasons.push('이전 실행과 행동 구성이 크게 달라졌습니다.');
  }

  return {
    status,
    label,
    reasons,
    session_count: count,
    session_share: Number((share * 100).toFixed(1)),
    has_top_actions: hasActions,
    has_page_distribution: hasPages,
    stability,
  };
}

function qualitySummary(clusters = [], meta = {}, totalSessions = 0) {
  const validations = clusters.map((cluster) => cluster.validation).filter(Boolean);
  const verified = validations.filter((v) => v.status === 'verified').length;
  const weak = validations.filter((v) => v.status === 'weak').length;
  const insufficient = validations.filter((v) => v.status === 'insufficient').length;
  const rawSampleCount = meta.cluster_quality?.sample_count ?? meta.retrain_session_count ?? totalSessions;
  const noiseCount = meta.cluster_quality?.noise_count ?? meta.noise_count ?? 0;
  const sampleCount = noiseCount > rawSampleCount
    ? totalSessions + noiseCount
    : rawSampleCount;
  return {
    sample_count: sampleCount,
    clustered_session_count: meta.cluster_quality?.clustered_session_count ?? null,
    noise_count: noiseCount,
    noise_rate: meta.cluster_quality?.noise_rate ?? (sampleCount ? Number((noiseCount / sampleCount).toFixed(4)) : null),
    silhouette: meta.silhouette ?? meta.cluster_quality?.silhouette ?? null,
    davies_bouldin: meta.davies_bouldin ?? meta.cluster_quality?.davies_bouldin ?? null,
    stability: meta.cluster_quality?.stability?.avg_profile_stability ?? null,
    verified_clusters: verified,
    weak_clusters: weak,
    insufficient_clusters: insufficient,
    visible_clusters: clusters.length,
    note: meta.cluster_quality?.metrics_note || '',
  };
}

function clusterQualifier(profile = {}) {
  const pages = Object.keys(profile.page_dist || {});
  const topActions = (profile.top_actions || []).map((a) => a.action);

  if (topActions.includes('ENTER_CHECKOUT')) return '결제 진입형';
  if (topActions.includes('START_INPUT') || topActions.includes('EDIT_INPUT')) return '입력 진행형';
  if (topActions.includes('CHECK_PRICE')) return '가격 확인형';
  if (topActions.includes('EXIT_BOUNCE') || topActions.includes('EXIT_SESSION')) return '빠른 중지형';
  if (topActions.includes('SEARCH_USE') || topActions.includes('ENTER_CATEGORY')) return '카테고리 탐색형';
  if (topActions.includes('SCROLL_PRODUCT')) return '상품 페이지형';
  if (topActions.includes('SCROLL_HOME')) return '홈 화면형';
  if (topActions.includes('VIEW_REVIEW') || topActions.includes('ZOOM_IMAGE')) return '후기 확인형';
  if (pages.includes('CHECKOUT')) return '결제 화면형';
  if (pages.includes('PRODUCT')) return '상품 화면형';
  if (pages.includes('CATEGORY')) return '카테고리형';
  if (pages.includes('HOME')) return '홈 화면형';
  return '행동 패턴형';
}

function ensureUniqueClusterLabels(clusters = []) {
  const counts = new Map();
  for (const cluster of clusters) {
    const key = String(cluster.label || '').trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const used = new Map();
  return clusters.map((cluster) => {
    const baseLabel = String(cluster.label || '').trim();
    if (!baseLabel || (counts.get(baseLabel) || 0) <= 1) return cluster;

    const qualifier = clusterQualifier(cluster);
    const candidate = `${baseLabel} · ${qualifier}`;
    const next = (used.get(candidate) || 0) + 1;
    used.set(candidate, next);

    return {
      ...cluster,
      label: next === 1 ? candidate : `${candidate} ${next}`,
    };
  });
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini API 오류 (${res.status}): ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('');
}

function parseJsonObject(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('JSON 응답을 찾지 못했습니다.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function generateNlpLabels(meta, force = false) {
  const profiles = meta.cluster_profiles || {};
  if (!force && meta.nlp_labels && Object.keys(meta.nlp_labels).length) {
    return meta.nlp_labels;
  }

  const clusterPayload = Object.entries(profiles).map(([clusterId, profile]) => ({
    cluster_id: clusterId,
    session_count: profile.count || 0,
    top_actions: (profile.top_actions || []).slice(0, 8).map((a) => ({
      action: a.action,
      label: koAction(a.action),
      count: a.count,
    })),
    page_dist: profile.page_dist || {},
  }));

  try {
    const prompt = `
당신은 이커머스 행동 로그를 해석하는 CRM 분석가입니다.
아래 클러스터링 결과를 보고 각 클러스터를 쇼핑몰 운영자가 이해할 수 있는 고객 유형으로 이름 붙이세요.

규칙:
- 반드시 한국어 JSON만 반환하세요.
- "이탈"이라는 단어는 쓰지 말고 "탐색 중지"라고 표현하세요.
- name은 12자에서 18자 정도의 짧은 고객 유형명으로 쓰세요.
- summary는 행동 근거를 1문장으로 설명하세요.
- action은 운영자가 바로 할 수 있는 액션 1문장으로 쓰세요.
- 클러스터 번호를 그대로 이름으로 쓰지 마세요.

반환 형식:
{
  "clusters": {
    "0": {"name": "...", "summary": "...", "action": "..."},
    "1": {"name": "...", "summary": "...", "action": "..."}
  }
}

클러스터 데이터:
${JSON.stringify(clusterPayload, null, 2)}
`.trim();

    const parsed = parseJsonObject(await callGemini(prompt));
    const labels = {};
    for (const [clusterId, profile] of Object.entries(profiles)) {
      const item = parsed.clusters?.[String(clusterId)] || {};
      const fallback = fallbackNlpLabel(clusterId, profile);
      labels[String(clusterId)] = {
        name: normalizeText(item.name || fallback.name),
        summary: normalizeText(item.summary || fallback.summary),
        action: normalizeText(item.action || fallback.action),
        source: item.name ? 'gemini' : 'fallback',
      };
    }
    meta.nlp_labels = labels;
    meta.nlp_labels_updated_at = new Date().toISOString();
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
    return labels;
  } catch (err) {
    const labels = {};
    for (const [clusterId, profile] of Object.entries(profiles)) {
      labels[String(clusterId)] = fallbackNlpLabel(clusterId, profile);
    }
    meta.nlp_labels = labels;
    meta.nlp_labels_error = err.message;
    meta.nlp_labels_updated_at = new Date().toISOString();
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
    return labels;
  }
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
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `clustering exited with code ${code}`));
        return;
      }

      const meta = fs.existsSync(META_PATH)
        ? JSON.parse(fs.readFileSync(META_PATH, 'utf-8'))
        : {};
      if (Object.keys(meta.cluster_profiles || {}).length) {
        await generateNlpLabels(meta, true);
      }
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

  const clusters = ensureUniqueClusterLabels([...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([clusterId, count]) => {
      const profile = profiles[String(clusterId)] || {};
      const nlp = labels[String(clusterId)] || {};
      return {
        cluster: clusterId,
        label: nlp.name || buildLabel(clusterId, profile, labels),
        summary: nlp.summary || '',
        action: nlp.action || '',
        count,
        top_actions: profile.top_actions || [],
        page_dist: profile.page_dist || {},
        validation: clusterValidation(clusterId, profile, count, sessions.length, {}),
      };
    }));

  return {
    total_sessions: sessions.length,
    n_clusters: clusters.length,
    noise_count: noiseCount,
    clusters,
    quality: qualitySummary(clusters, { noise_count: noiseCount }, sessions.length),
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
    const labels = await generateNlpLabels(meta, false);

    const totalSessions = Object.values(profiles).reduce((sum, profile) => sum + (profile.count || 0), 0);
    const clusters = ensureUniqueClusterLabels(Object.entries(profiles).map(([clusterId, profile]) => {
      const nlp = labels[String(clusterId)] || {};
      const count = profile.count || 0;
      return {
        cluster: Number(clusterId),
        label: nlp.name || buildLabel(clusterId, profile, meta.cluster_labels || {}),
        summary: nlp.summary || '',
        action: nlp.action || '',
        count,
        top_actions: profile.top_actions || [],
        page_dist: profile.page_dist || {},
        validation: clusterValidation(clusterId, profile, count, totalSessions, meta),
      };
    }));
    const quality = qualitySummary(clusters, meta, totalSessions);

    const frozenMode = String(req.query.mode || '').toLowerCase() === 'frozen';

    if (req.query.origin && frozenMode) {
      const snapshot = loadSiteSnapshot(req.query.origin);
      if (snapshot) {
        return res.json({
          ...snapshot,
          meta,
        });
      }
    }

    if (req.query.origin && !frozenMode) {
      try {
        const result = await classifySiteSessions(req.query.origin, profiles, labels);
        return res.json({ ...result, meta });
      } catch (siteErr) {
        console.warn('[clusters] site live fallback:', siteErr.message);
        return res.json({
          total_sessions: totalSessions,
          n_clusters: meta.num_clusters ?? clusters.length,
          silhouette: meta.silhouette ?? null,
          davies_bouldin: meta.davies_bouldin ?? null,
          noise_count: meta.noise_count ?? 0,
          quality,
          clusters,
          source: 'artifact_fallback',
          origin: req.query.origin,
          warning: '사이트별 실시간 분류를 불러오지 못해 저장된 전체 클러스터 품질을 표시했습니다.',
          meta,
        });
      }
    }

    res.json({
      total_sessions: totalSessions,
      n_clusters: meta.num_clusters ?? clusters.length,
      silhouette: meta.silhouette ?? null,
      davies_bouldin: meta.davies_bouldin ?? null,
      noise_count: meta.noise_count ?? 0,
      quality,
      clusters,
      source: frozenMode ? 'artifact_snapshot' : 'artifact',
      origin: req.query.origin || null,
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

    const requestedOrigin = String(req.body?.origin || '').trim();
    const result = await runPythonClustering({ full: req.body?.full !== false });
    if (requestedOrigin) {
      const meta = fs.existsSync(META_PATH)
        ? JSON.parse(fs.readFileSync(META_PATH, 'utf-8'))
        : {};
      const profiles = meta.cluster_profiles || {};
      const labels = await generateNlpLabels(meta, false);
      const siteResult = await classifySiteSessions(requestedOrigin, profiles, labels);
      saveSiteSnapshot(requestedOrigin, {
        ...siteResult,
        source: 'site_snapshot',
        snapshot_basis: 'classified_from_latest_cluster_model',
        last_retrain: meta.last_retrain ?? result.last_retrain ?? null,
      });
      return res.json({
        ...result,
        snapshot_origin: requestedOrigin,
        snapshot_saved: true,
        snapshot_session_count: siteResult.total_sessions,
        snapshot_cluster_count: siteResult.n_clusters,
      });
    }
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
