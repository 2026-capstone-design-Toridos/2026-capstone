/**
 * clusters.js — 고객 유형(클러스터) 결과를 운영자 화면에 내려주는 API
 *
 * ml이 만들어둔 클러스터링 결과(cluster_meta.json)를 읽어와서 Gemini로 유형 이름을 붙이고,
 * 사이트별로 실시간 분류하거나 마지막 실행 시점 스냅샷으로 고정해서 보여준다.
 *
 * GET  /api/clusters           — 클러스터 메타 + 품질 지표 (origin/mode 쿼리로 필터)
 * POST /api/clusters/run       — retrain_centroids.py 돌려서 클러스터 다시 계산
 * GET  /api/clusters/sessions  — semantic_cluster_results.csv를 JSON으로
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Event = require('../models/Event');
const {
  originCondition,
  originVariants,
  normalizeOrigin,
  canonicalOrigin,
} = require('../middleware/siteAccess');

const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// API 키는 URL이 아니라 x-goog-api-key 헤더로 보낸다.
// 쿼리 스트링에 실으면 서버 로그·프록시 로그·에러 메시지에 키가 그대로 남는다.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

// origin URL을 파일명으로 쓸 수 있게 정리
function snapshotKey(origin = '') {
  // normalizeOrigin으로 끝 슬래시를 먼저 없앤다.
  // 안 그러면 "site.com"과 "site.com/"이 서로 다른 스냅샷 파일로 갈린다.
  return canonicalOrigin(origin)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._-]+/g, '_');
}

function snapshotPath(origin = '') {
  return path.join(SNAPSHOT_DIR, `${snapshotKey(origin)}.json`);
}

// 사이트별 분류 결과를 마지막 실행 시점 스냅샷으로 저장
function saveSiteSnapshot(origin, payload) {
  if (!origin) return;
  const canonical = canonicalOrigin(origin);
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(origin), JSON.stringify({
    ...payload,
    source: 'site_snapshot',
    origin: canonical,
    snapshot_origin: canonical,
    origin_variants: originVariants(origin),
    snapshot_saved_at: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

// 저장된 사이트 스냅샷 불러오기 (없으면 null)
function loadSiteSnapshot(origin) {
  if (!origin) return null;
  const target = snapshotPath(origin);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf-8'));
}

// Gemini/NLP 라벨이 없을 때 top action 두 개로 최소한의 표시명을 만든다
function buildLabel(clusterId, profile, labels = {}) {
  if (labels[String(clusterId)]) return labels[String(clusterId)];
  const top = (profile.top_actions || []).slice(0, 2).map(a => a.action).join(' + ');
  return top ? `Cluster ${clusterId}: ${top}` : `Cluster ${clusterId}`;
}

// 운영자 화면에서는 "이탈" 표현을 "탐색 중지"로 통일한다
function normalizeText(text) {
  return String(text || '').replaceAll('\uC774\uD0C8', '탐색 중지');
}

// 내부 semantic action 코드를 대시보드/리포트용 한국어 라벨로 바꾼다
// 행동 코드 → 운영자가 읽는 말.
//
// 이 사전이 유일한 출처다. 화면에서 다시 번역하지 않는다.
// (예전에는 대시보드에도 friendlyAction() 사전이 따로 있어
//  같은 코드가 화면마다 다른 말로 나오거나 영어로 남았다.)
// semantic_event_mapper.py 가 만들 수 있는 모든 SEMANTIC 값을 덮어야 한다.
function koAction(action) {
  const labels = {
    // 진입
    START_SESSION: '쇼핑몰 방문',
    ENTER_HOME: '첫 화면 진입',
    ENTER_PRODUCT: '상품 상세 진입',
    ENTER_CATEGORY: '카테고리 진입',
    ENTER_CART: '장바구니 진입',
    ENTER_CHECKOUT: '결제 화면 진입',
    ENTER_MEMBER: '회원 화면 진입',
    ENTER_UNKNOWN: '기타 화면 진입',

    // 열람
    VIEW_PRODUCT: '상품 살펴봄',
    VIEW_DETAIL: '상세정보 확인',
    VIEW_REVIEW: '리뷰 확인',
    VIEW_QNA: '상품 문의 확인',
    VIEW_IMAGE: '이미지 확인',
    VIEW_SECTION: '특정 영역 확인',
    ZOOM_IMAGE: '상품 이미지 확대',

    // 확인
    CHECK_PRICE: '가격 확인',
    CHECK_SIZE: '사이즈 확인',
    CHECK_SHIPPING: '배송 정보 확인',

    // 스크롤
    SCROLL_HOME: '첫 화면 스크롤',
    SCROLL_PRODUCT: '상품 페이지 스크롤',
    SCROLL_CATEGORY: '카테고리 스크롤',
    SCROLL_REVIEW: '리뷰 스크롤',
    SCROLL_PAGE: '페이지 스크롤',

    // 조작
    HOVER_ELEMENT: '요소 위에 머무름',
    CLICK_ELEMENT: '버튼 또는 메뉴 클릭',
    CLICK_BUY: '구매 버튼 클릭',
    SEARCH_USE: '상품 검색',

    // 장바구니
    ADD_CART: '장바구니 담기',
    REMOVE_CART: '장바구니에서 제거',
    CHANGE_QUANTITY: '수량 변경',
    CART_ABANDON: '장바구니 두고 나감',

    // 입력
    START_INPUT: '입력 시작',
    EDIT_INPUT: '입력 수정',
    ABANDON_INPUT: '입력 중단',

    // 이탈 / 주의
    TAB_OUT: '다른 탭으로 이동',
    TAB_RETURN: '탭으로 돌아옴',
    INACTIVE: '움직임 없음',
    RAGE_CLICK: '반복 클릭',
    EXIT_SESSION: '탐색 중지',
    EXIT_BOUNCE: '빠른 탐색 중지',

    // 에피소드 — 같은 의도가 짧은 구간에 반복될 때 승격되는 신호
    PRICE_REVIEW_EPISODE: '가격을 반복 확인',
    SIZE_CHECK_EPISODE: '사이즈를 반복 확인',
    SHIPPING_CHECK_EPISODE: '배송 정보를 반복 확인',
    REVIEW_EXPLORATION_EPISODE: '리뷰를 집중해서 확인',
    DISTRACTED_EPISODE: '주의가 흩어짐',
  };
  return labels[action] || String(action || '').replaceAll('_', ' ').toLowerCase();
}

// Gemini 응답이 없을 때 대표 행동만 보고 유형 이름을 추정
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
  } else if (top3.includes('VIEW_REVIEW') || top3.includes('VIEW_QNA') || top3.includes('VIEW_DETAIL') || top3.includes('ZOOM_IMAGE')) {
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

// 행동/페이지 근거, 세션 수, 비중, 안정성을 보고 클러스터를 믿을 만한지 판정
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

// 클러스터 검증 결과를 모아 전체 품질 지표로 집계
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

// 같은 고객 유형명이 중복될 때 붙일 화면/행동 기반 보조 구분명을 고른다
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

// 같은 이름의 클러스터가 여러 개면 구분 태그를 붙여 유니크하게 만든다
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

// Gemini에게 클러스터 이름/설명/액션 작명을 요청
async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
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

// 마크다운 코드블록이 섞인 응답에서 JSON 부분만 잘라낸다
function parseJsonObject(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('JSON 응답을 찾지 못했습니다.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// 클러스터별 이름을 Gemini로 받아와 메타파일에 캐싱, 실패하면 fallback으로 대체
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

// retrain_centroids.py를 별도 프로세스로 띄워 클러스터를 새로 계산
function runPythonClustering({ full = true } = {}) {
  if (clusteringJob) return clusteringJob;

  const startedAt = new Date().toISOString();
  clusteringJob = new Promise((resolve, reject) => {
    const args = [RETRAIN_SCRIPT];
    if (full) args.push('--full');

    const child = spawn('/home/opc/ghosttracker-venv/bin/python3.11', args, {
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

// pathname/page_url로 결제·장바구니·상품·검색 페이지를 구분한다
function inferPage(doc) {
  const raw = `${doc.pathname || ''} ${doc.page_url || ''}`.toLowerCase();
  if (raw.includes('checkout') || raw.includes('payment') || raw.includes('order')) return 'checkout';
  if (raw.includes('cart') || raw.includes('basket')) return 'cart';
  if (raw.includes('product') || raw.includes('item') || raw.includes('prod_')) return 'product';
  if (raw.includes('search') || raw.includes('category') || raw.includes('collection')) return 'search';
  return 'home';
}

// 과거 artifact의 active_buyer 명칭은 실제 구매 완료가 아니라 입력/장바구니
// 비율로 붙은 이름이다. 전환 지표와 혼동되지 않도록 행동 유형으로 교정한다.
function behaviorOnlyPersona(persona = {}) {
  if (persona.id !== 'active_buyer') return persona;
  return {
    ...persona,
    id: 'high_engagement',
    name: '깊게 탐색하는 활동 고객',
    summary: '여러 화면과 입력·장바구니 행동을 보이는 체류가 긴 고객 유형입니다.',
    action: '구매 고객으로 단정하지 말고 별도 전환 지표와 함께 결제 경로를 점검하세요.',
    source: 'corrected_legacy_rule',
  };
}

// 클러스터(행동 유형)와 구매 퍼널(전환 여부)은 서로 다른 축이다.
// 구매 신호가 한 번 있었다고 구매형 클러스터로 이름 붙이지 않고 별도로 센다.
function sessionFunnelSignals(events = []) {
  const types = new Set(events.map((event) => String(event.event_type || '').toLowerCase()));
  return {
    guest_purchase: types.has('guest_purchase'),
    purchase_intent: types.has('purchase_click'),
    cart: ['add_to_cart', 'add_to_cart_success'].some((type) => types.has(type)),
    wishlist: ['wishlist_intent', 'add_to_wishlist_success'].some((type) => types.has(type)),
    review: ['review_click', 'review_image_click', 'review_page_change', 'review_scroll', 'review_area_scroll']
      .some((type) => types.has(type)),
  };
}

function incrementCounts(target, source = {}) {
  for (const [key, value] of Object.entries(source)) {
    const count = Number(value) || 0;
    if (count) target.set(key, (target.get(key) || 0) + count);
  }
}

// 사이트 최근 세션을 모아 분류 서버에 한번에 보내고 결과를 클러스터별로 집계
async function classifySiteSessions(origin, profiles, labels) {
  // 끝 슬래시가 붙은 origin도 같이 매칭한다
  const docs = await Event.find(originCondition(origin))
    .sort({ received_at: -1 })
    .limit(20000)
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
    .map((session) => {
      const ordered = session.events.sort((a, b) => {
        const aTime = Number(a.timestamp) || new Date(a.received_at || 0).getTime();
        const bTime = Number(b.timestamp) || new Date(b.received_at || 0).getTime();
        return aTime - bTime || Number(a.event_seq || 0) - Number(b.event_seq || 0);
      });
      return {
        session_id: session.session_id,
        funnel: sessionFunnelSignals(ordered),
        // 비정상적으로 긴 세션만 안전 상한을 두고 최근 이벤트를 보존한다.
        // Python 전처리가 noise를 제거한 뒤 모델 길이에 맞춰 다시 자른다.
        events: ordered.slice(-1000).map((doc) => ({
          event_type: doc.event_type,
          timestamp: Number(doc.timestamp) || new Date(doc.received_at || 0).getTime(),
          event_seq: doc.event_seq,
          inter_event_gap: doc.inter_event_gap,
          pathname: doc.pathname,
          page_url: doc.page_url,
          page_type: doc.page_type || doc.data?.page_type,
          data: doc.data || {},
        })),
      };
    })
    .filter((session) => session.events.length > 0);

  if (!sessions.length) {
    return {
      total_sessions: 0,
      n_clusters: 0,
      noise_count: 0,
      clusters: [],
      source: 'site_live',
      origin: canonicalOrigin(origin),
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
  const sessionById = new Map(sessions.map((session) => [session.session_id, session]));
  const siteStats = new Map();
  let noiseCount = 0;
  const rejectionReasons = new Map();
  const funnel = {
    guest_purchase_sessions: 0,
    purchase_intent_sessions: 0,
    cart_sessions: 0,
    wishlist_sessions: 0,
    review_sessions: 0,
  };
  for (const [index, result] of (body.results || []).entries()) {
    const session = sessionById.get(result.session_id) || sessions[index];
    if (session?.funnel?.guest_purchase) funnel.guest_purchase_sessions += 1;
    if (session?.funnel?.purchase_intent) funnel.purchase_intent_sessions += 1;
    if (session?.funnel?.cart) funnel.cart_sessions += 1;
    if (session?.funnel?.wishlist) funnel.wishlist_sessions += 1;
    if (session?.funnel?.review) funnel.review_sessions += 1;

    const cid = Number(result.cluster_id);
    if (!Number.isFinite(cid) || cid < 0) {
      noiseCount += 1;
      for (const reason of result.rejection_reasons || ['unclassified']) {
        rejectionReasons.set(reason, (rejectionReasons.get(reason) || 0) + 1);
      }
      continue;
    }
    const stats = siteStats.get(cid) || {
      count: 0,
      actionCounts: new Map(),
      pageCounts: new Map(),
      funnel: {
        guest_purchase_sessions: 0,
        purchase_intent_sessions: 0,
        cart_sessions: 0,
      },
    };
    stats.count += 1;

    if (session?.funnel?.guest_purchase) stats.funnel.guest_purchase_sessions += 1;
    if (session?.funnel?.purchase_intent) stats.funnel.purchase_intent_sessions += 1;
    if (session?.funnel?.cart) stats.funnel.cart_sessions += 1;

    // Python이 학습과 같은 규칙으로 만든 semantic 분포를 사용한다.
    incrementCounts(stats.actionCounts, result.semantic_action_counts);
    incrementCounts(stats.pageCounts, result.page_counts);
    siteStats.set(cid, stats);
  }

  const clusters = ensureUniqueClusterLabels([...siteStats.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([clusterId, stats]) => {
      const profile = profiles[String(clusterId)] || {};
      const nlp = behaviorOnlyPersona(labels[String(clusterId)] || {});
      const topActions = [...stats.actionCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([action, count]) => ({ action, count }));
      const pageDist = Object.fromEntries(
        [...stats.pageCounts.entries()].sort((a, b) => b[1] - a[1]),
      );
      return {
        cluster: clusterId,
        label: nlp.name || buildLabel(clusterId, profile, labels),
        summary: nlp.summary || '',
        action: nlp.action || '',
        // 이름이 어디서 왔는지 화면에 알려준다. 없으면 화면이 자체 규칙으로 다시 명명한다.
        persona_source: nlp.source || (nlp.name ? 'meta' : null),
        persona_id: nlp.id || null,
        count: stats.count,
        // 번역은 서버에서 붙여 내려보낸다. 화면이 다시 번역하면 사전이 두 개가 된다.
        top_actions: (topActions.length ? topActions : (profile.top_actions || []))
          .map((a) => ({ ...a, label: koAction(a.action) })),
        page_dist: Object.keys(pageDist).length ? pageDist : (profile.page_dist || {}),
        funnel: stats.funnel,
        validation: clusterValidation(clusterId, profile, stats.count, sessions.length, {}),
      };
    }));

  return {
    total_sessions: sessions.length,
    n_clusters: clusters.length,
    noise_count: noiseCount,
    rejection_reasons: Object.fromEntries(rejectionReasons),
    funnel,
    clusters,
    quality: qualitySummary(clusters, { noise_count: noiseCount }, sessions.length),
    source: 'site_live',
    origin: canonicalOrigin(origin),
    sampled_sessions: sessions.length,
  };
}

// PDF 리포트처럼 사이트별 최신 분류 결과가 필요한 내부 기능에서 재사용한다.
// 원본 이벤트는 외부로 노출하지 않고, 집계된 고객 유형 결과만 반환한다.
async function buildSiteReportData(origin) {
  if (!origin) throw new Error('사이트 origin이 필요합니다.');
  if (!fs.existsSync(META_PATH)) {
    throw new Error('cluster_meta.json not found. Run/export clustering artifacts first.');
  }
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  const profiles = meta.cluster_profiles || {};
  const labels = await generateNlpLabels(meta, false);
  return classifySiteSessions(origin, profiles, labels);
}

// ── GET /api/clusters ──────────────────────────────────────────
// 기본: 저장된 cluster_meta.json 기준 전체 클러스터 표시
// origin + live mode: 해당 사이트 최근 세션을 Python 서버로 실시간 재분류
// origin + mode=frozen: 마지막 /run 때 저장한 사이트 스냅샷을 고정 표시
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
      const nlp = behaviorOnlyPersona(labels[String(clusterId)] || {});
      const count = profile.count || 0;
      return {
        cluster: Number(clusterId),
        label: nlp.name || buildLabel(clusterId, profile, meta.cluster_labels || {}),
        summary: nlp.summary || '',
        action: nlp.action || '',
        // 이름이 어디서 왔는지 화면에 알려준다.
        // 화면은 자체 명명 규칙을 갖고 있어, 서버가 준 이름이 있으면
        // 그쪽을 우선해야 두 규칙이 어긋나지 않는다.
        persona_source: nlp.source || (nlp.name ? 'meta' : null),
        persona_id: nlp.id || null,
        count,
        // 번역은 서버에서 붙여 내려보낸다. 화면이 다시 번역하면 사전이 두 개가 된다.
        top_actions: (profile.top_actions || []).map((a) => ({
          ...a,
          label: koAction(a.action),
        })),
        page_dist: profile.page_dist || {},
        validation: clusterValidation(clusterId, profile, count, totalSessions, meta),
      };
    }));
    const quality = qualitySummary(clusters, meta, totalSessions);

    const frozenMode = String(req.query.mode || '').toLowerCase() === 'frozen';

    // 운영자가 "고정" 모드를 선택하면 마지막 저장 스냅샷을 우선 사용한다
    if (req.siteOrigin && frozenMode) {
      const snapshot = loadSiteSnapshot(req.siteOrigin);
      if (snapshot) {
        return res.json({
          ...snapshot,
          meta,
        });
      }
    }

    // live 모드는 항상 최신 데이터를 분류한다. frozen 모드라도 새 대표 origin의
    // 통합 스냅샷이 아직 없으면 한 번 생성해 예전 단일-origin 결과를 쓰지 않는다.
    if (req.siteOrigin) {
      try {
        const result = await classifySiteSessions(req.siteOrigin, profiles, labels);
        if (frozenMode) {
          saveSiteSnapshot(req.siteOrigin, {
            ...result,
            snapshot_basis: 'auto_refreshed_for_origin_alias_group',
            last_retrain: meta.last_retrain ?? null,
          });
        }
        return res.json({ ...result, meta });
      } catch (siteErr) {
        console.warn('[clusters] site live fallback:', siteErr.message);
        return res.json({
          total_sessions: 0,
          n_clusters: 0,
          noise_count: meta.noise_count ?? 0,
          quality: null,
          clusters: [],
          source: 'site_unavailable',
          origin: canonicalOrigin(req.siteOrigin),
          warning: '사이트 통합 분류를 불러오지 못했습니다. 다른 쇼핑몰 데이터가 섞이지 않도록 전체 결과로 대체하지 않았습니다.',
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
      origin: req.siteOrigin || null,
      meta,
    });
  } catch (err) {
    console.error('[clusters] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/clusters/run — 클러스터링 재실행 ───────────────────
// full=false면 EMA식 부분 갱신, origin을 넘기면 실행 직후 사이트별 스냅샷까지 저장한다
router.post('/run', async (req, res) => {
  try {
    if (clusteringJob) {
      return res.status(409).json({
        error: '클러스터링이 이미 실행 중입니다.',
      });
    }

    // 키 모드에서는 키가 정한 사이트로 고정한다. body의 origin은 신뢰하지 않는다.
    const requestedOrigin = req.siteOrigin || String(req.body?.origin || '').trim();

    // 기본은 "재분류"다. 기존 인코더·centroid를 그대로 두고 최신 세션만 다시 분류한다.
    //
    // 재학습(retrain:true)을 기본으로 두면 안 되는 이유:
    //   - CPU 학습에 수 분이 걸려 HTTP 요청 안에서 끝나지 않는다
    //   - 누를 때마다 클러스터 정의가 바뀌어 어제 본 유형과 오늘 본 유형이 달라진다
    //     운영자에게는 기준이 안정적인 쪽이 중요하다
    //   - generateNlpLabels(meta, true)가 돌면서 규칙 기반 페르소나 이름을
    //     Gemini 응답으로 덮어쓴다
    // 재학습은 데이터가 쌓인 뒤 개발자가 ml/ 파이프라인으로 의도적으로 수행한다.
    const retrain = req.body?.retrain === true;

    const result = retrain
      ? await runPythonClustering({ full: req.body?.full !== false })
      : {
        ok: true,
        mode: 'reclassify',
        message: '기존 고객 유형 기준으로 최신 데이터를 다시 분류했습니다.',
      };

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
        snapshot_origin: canonicalOrigin(requestedOrigin),
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

// ── GET /api/clusters/sessions ────────────────────────────────────
// 저장된 semantic_cluster_results.csv를 운영자 화면에서 볼 수 있게 JSON으로 변환한다
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

router.buildSiteReportData = buildSiteReportData;
module.exports = router;
