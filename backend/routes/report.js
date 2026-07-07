/**
 * routes/report.js
 * ----------------
 * GhostTracker 자연어 인사이트 리포트 API (Gemini 2.0 Flash)
 *
 * GET  /api/report/cluster/:clusterId
 *   → 클러스터 페르소나 리포트 (cluster_profiles 기반, 결과 캐시)
 *
 * POST /api/report/session
 *   Body: { session_id, cluster_id, persona, confidence, events[] }
 *   → 세션별 개인화 인사이트
 *
 * GET  /api/report/all
 *   → 전체 12개 클러스터 요약 리포트
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// cluster_meta.json 경로 (ml/output/unsupervised_semantic/)
const META_PATH = path.join(__dirname, '../../ml/output/unsupervised_semantic/cluster_meta.json');
const REPORTS_DIR = path.join(__dirname, '../../ml/output/reports');
const BLOCKED_TERM = '\uC774\uD0C8';
const REPLACEMENT_TERM = '탐색 중지';

// 인메모리 캐시 (서버 재시작 시 초기화)
const reportCache = new Map();

// ── 클러스터 메타 로드 ────────────────────────────────────────────────────────
// cluster_meta.json을 읽어온다, 없으면 에러
function loadClusterMeta() {
  if (!fs.existsSync(META_PATH)) {
    throw new Error(`cluster_meta.json 없음: ${META_PATH}`);
  }
  return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
}

// reports 폴더에서 가장 최근 생성된 PDF를 찾는다
function findLatestPdfReport() {
  if (!fs.existsSync(REPORTS_DIR)) return null;

  const files = fs.readdirSync(REPORTS_DIR)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .map((name) => {
      const fullPath = path.join(REPORTS_DIR, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0] || null;
}

// ── Gemini API 호출 (재시도 포함) ────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "이탈"은 운영자에게 부정적으로 읽혀서 "탐색 중지"로 통일
function normalizeReportText(text) {
  return String(text || '').replaceAll(BLOCKED_TERM, REPLACEMENT_TERM);
}

// Gemini 응답이 문장 중간에 끊겼는지 확인
function looksCompleteReport(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/[.!?]$/.test(value)) return true;
  if (/(입니다|합니다|됩니다|보입니다|보입니다만|좋습니다|권합니다|제안합니다|유도해 보시길 제안합니다|유도하세요|보강하세요|점검하세요)$/.test(value)) {
    return true;
  }
  return false;
}

// 재시도해볼 만한 Gemini 쪽 오류인지 판단
function isGeminiUnavailable(err) {
  const message = String(err?.message || '');
  return message.includes('503')
    || message.includes('429')
    || message.includes('UNAVAILABLE')
    || message.includes('재시도 초과')
    || message.includes('incomplete');
}

function actionLabel(action) {
  const labels = {
    START_SESSION: '쇼핑몰 방문',
    ENTER_HOME: '홈 화면 진입',
    ENTER_PRODUCT: '상품 상세 확인',
    ENTER_CART: '장바구니 진입',
    ENTER_CHECKOUT: '결제 화면 진입',
    SCROLL_HOME: '홈 화면 스크롤',
    SCROLL_PRODUCT: '상품 페이지 스크롤',
    HOVER_ELEMENT: '요소 위에 머무름',
    CLICK_ELEMENT: '버튼 또는 메뉴 클릭',
    SEARCH_USE: '상품 검색',
    CHECK_PRICE: '가격 확인',
    CHECK_SIZE: '사이즈 확인',
    VIEW_REVIEW: '리뷰 확인',
    ADD_CART: '장바구니 담기',
    EXIT_SESSION: '탐색 중지',
    INACTIVE: '움직임 없음',
    TAB_OUT: '탭을 떠남',
  };
  return labels[action] || String(action || '').replaceAll('_', ' ').toLowerCase();
}

// 자주 나오는 유형은 Gemini 호출 전에 미리 써둔 문장으로 대체
function mockReportPreset(persona = '') {
  const name = String(persona || '').trim();
  if (!name) return null;

  if (name.includes('주문을 완료한 고객')) {
    return {
      cluster: '주문을 완료한 고객 유형은 상품을 살펴본 뒤 장바구니와 주문서 작성 단계를 무리 없이 지나 실제 결제 완료까지 도달한 고객입니다. 운영자님께서는 이 고객의 흐름을 전환 성공 기준선으로 보고, 장바구니 진입 이후 배송 정보 입력과 결제 버튼 주변의 문구, 진행 순서, 안심 요소를 다른 고객에게도 동일하게 제공하는 것이 좋습니다. 특히 결제 직전 망설임을 줄이기 위해 배송 안내, 결제 혜택, 주문 완료 직전 확인 문구를 더 분명하게 보여주면 성공 흐름을 더 많이 재현할 수 있습니다.',
      session: '이 고객은 장바구니 담기 이후 주문서 입력과 주문 클릭을 이어가며 실제 주문 완료까지 도달했습니다. 운영자님께서는 이 세션을 전환 성공 예시로 보고, 어떤 화면에서 다음 행동이 자연스럽게 이어졌는지 확인한 뒤 같은 안내 구조를 다른 고객의 장바구니와 결제 화면에도 확대 적용해보세요. 특히 입력 과정이 길어지지 않도록 필수 정보, 결제 수단, 최종 버튼 주변 구성을 더 단순하게 유지하는 것이 좋습니다.',
    };
  }

  if (name.includes('결제 단계에서 망설이는 고객')) {
    return {
      cluster: '결제 단계에서 망설이는 고객 유형은 가격, 배송, 입력 단계까지는 진입하지만 마지막 확신이 부족해 멈추는 경우가 많은 유형입니다. 운영자님께서는 결제 화면에서 배송비, 환불 안내, 결제 혜택, 리뷰 신뢰 요소를 더 선명하게 보여주고 입력 피로를 줄이는 방향으로 우선 점검해보세요. 특히 마지막 버튼 직전의 불안 요소를 줄여주면 전환율 개선 가능성이 큽니다.',
      session: '이 고객은 상품과 결제 흐름에 관심을 보였지만 입력이나 가격 확인 단계에서 한 번 더 머뭇거리는 패턴이 보입니다. 운영자님께서는 결제 직전 화면에서 쿠폰, 배송 안내, 결제 완료까지 남은 단계 같은 확신 요소를 보강해 고객이 마지막 결정을 더 쉽게 내리도록 도와주세요. 입력 항목이 많다면 꼭 필요한 순서만 먼저 보이게 정리하는 것도 효과적입니다.',
    };
  }

  if (name.includes('탐색을 빠르게 멈추는 고객')) {
    return {
      cluster: '탐색을 빠르게 멈추는 고객 유형은 짧게 둘러본 뒤 다음 행동으로 이어지지 않고 빠르게 흐름이 끊기는 경우가 많은 유형입니다. 운영자님께서는 첫 화면과 상품 초반 구간에서 대표 상품, 혜택, 신뢰 요소, 다음 행동 버튼을 더 강하게 보여주어 고객이 멈추기 전에 방향을 잡을 수 있게 해주세요. 특히 첫 10초 안에 보이는 정보 구성이 중요합니다.',
      session: '이 고객은 핵심 화면을 오래 보지 않고 비교적 이른 시점에 탐색 흐름이 끊겼습니다. 운영자님께서는 첫 화면 또는 상품 초반 구간에서 고객이 다음으로 무엇을 해야 하는지 더 명확하게 알려주는 문구와 버튼을 보강해보세요. 혜택 배너나 대표 상품 묶음을 먼저 보여주는 것도 이 유형의 이탈을 줄이는 데 도움이 됩니다.',
    };
  }

  if (name.includes('페이지를 훑어보는 고객')) {
    return {
      cluster: '페이지를 훑어보는 고객 유형은 홈 화면과 상품 화면을 넓게 둘러보지만 다음 행동으로 깊게 들어가지 않는 경우가 많은 유형입니다. 운영자님께서는 스크롤만 이어지는 화면에 추천 상품, 후기, 카테고리 이동, 대표 CTA를 더 분명하게 배치해 고객이 다음 행동을 쉽게 선택할 수 있게 해주세요. 정보는 충분히 보지만 결정 계기가 부족한 상태로 해석하는 것이 좋습니다.',
      session: '이 고객은 화면을 천천히 훑고 필요한 정보를 찾는 모습은 보였지만, 핵심 행동으로 강하게 이어지지는 않았습니다. 운영자님께서는 이 고객이 머문 화면에 다음 행동 버튼, 추천 상품, 후기 요약 같은 결정 보조 요소를 보강해 탐색이 클릭과 구매 흐름으로 이어지게 만들어보세요. 상품 상세 상단에 핵심 정보 요약을 더 전진 배치하는 것도 도움이 됩니다.',
    };
  }

  if (name.includes('상품을 찾고 비교하는 고객')) {
    return {
      cluster: '상품을 찾고 비교하는 고객 유형은 검색, 카테고리 이동, 상세 확인을 반복하며 여러 선택지를 비교하는 경우가 많은 유형입니다. 운영자님께서는 필터, 정렬, 리뷰 요약, 가격 비교 요소를 더 빠르게 읽히게 정리하고 선택 피로를 줄이는 방향으로 화면을 다듬어보세요. 이 유형은 탐색 의도는 분명하므로 비교를 쉽게 만들어주면 전환으로 이어질 가능성이 높습니다.',
      session: '이 고객은 원하는 상품을 찾기 위해 검색과 비교 행동을 반복하는 흐름을 보였습니다. 운영자님께서는 비교 과정에서 필요한 가격, 리뷰, 배송 정보를 한눈에 볼 수 있게 정리해 고객이 여러 페이지를 오가며 지치지 않도록 도와주세요. 추천 상품이나 비교 포인트 요약도 좋은 보조 장치가 됩니다.',
    };
  }

  if (name.includes('행동 데이터 부족 고객')) {
    return {
      cluster: '이 유형은 아직 대표 행동 근거가 충분히 쌓이지 않아 명확한 해석보다 데이터 보완이 우선인 상태입니다. 운영자님께서는 SDK 수집 범위, 페이지별 이벤트 매핑, 주문 성공 직전/직후 이벤트 기록 여부를 먼저 점검해 행동 흐름이 더 또렷하게 남도록 보완해주세요. 데이터가 정리되면 이후 유형 해석도 훨씬 안정적으로 바뀔 수 있습니다.',
      session: '이 고객 세션은 행동 기록이 충분하지 않아 성향을 단정하기 어렵습니다. 운영자님께서는 페이지 이동, 클릭, 장바구니, 결제 단계 이벤트가 빠짐없이 수집되는지 먼저 확인해 주세요. 특히 중요한 행동이 누락되면 실제 구매 의도와 다르게 해석될 수 있습니다.',
    };
  }

  return null;
}

// Gemini 없이도 보여줄 클러스터 리포트를 직접 조립
function buildLocalClusterReport(clusterId, profile = {}, labelInfo = {}) {
  const typeName = labelInfo.name || labelInfo.label || `고객 유형 ${clusterId}`;
  const preset = mockReportPreset(typeName);
  if (preset?.cluster) {
    return normalizeReportText(preset.cluster);
  }
  const summary = labelInfo.summary || '행동 패턴을 바탕으로 묶인 고객 유형입니다.';
  const action = labelInfo.action || '대표 행동을 기준으로 상품 노출과 안내 문구를 점검하세요.';
  const topActions = (profile.top_actions || [])
    .slice(0, 3)
    .map((a) => actionLabel(a.action))
    .filter(Boolean)
    .join(', ');
  const pages = Object.entries(profile.page_dist || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([page]) => page)
    .join(', ');

  const evidence = [
    topActions ? `대표 행동은 ${topActions}입니다.` : '',
    pages ? `주로 관찰된 화면은 ${pages}입니다.` : '',
  ].filter(Boolean).join(' ');

  return normalizeReportText(`${typeName} 유형은 ${summary} ${evidence} 지금은 AI 리포트 생성 서버가 혼잡해 자동 요약으로 보여드리고 있습니다. 운영자님은 우선 ${action}`);
}

// Gemini 없이도 보여줄 세션 리포트를 직접 조립
function buildLocalSessionReport(body, profile = {}) {
  const persona = body.persona || `고객 유형 ${body.cluster_id}`;
  const preset = mockReportPreset(persona);
  if (preset?.session) {
    return normalizeReportText(preset.session);
  }
  const summary = body.summary || '이 고객은 최근 행동 흐름을 기준으로 가장 가까운 유형에 분류됐습니다.';
  const action = body.action || '상세 행동 흐름을 확인해 상품 안내, 혜택, 다음 클릭 유도를 점검하세요.';
  const events = (body.events || []).slice(0, 5).map((e) => actionLabel(e.event_type)).filter(Boolean);
  const topActions = (profile.top_actions || []).slice(0, 3).map((a) => actionLabel(a.action)).filter(Boolean);
  const flow = events.length ? `최근 행동 흐름은 ${events.join(' → ')} 순서로 관찰됐습니다.` : '';
  const average = topActions.length ? `이 유형의 대표 행동은 ${topActions.join(', ')}입니다.` : '';

  return normalizeReportText(`${persona} 고객은 ${summary} ${flow} ${average} 지금은 AI 리포트 생성 서버가 혼잡해 자동 요약으로 보여드리고 있습니다. 운영자님은 우선 ${action}`);
}

// Gemini 호출, 503/429면 잠깐 쉬었다가 재시도
async function callGemini(prompt, retries = 3) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:     0.7,
          maxOutputTokens: 2048,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    // 503/429는 재시도
    if ((res.status === 503 || res.status === 429) && attempt < retries) {
      const wait = (attempt + 1) * 5000;   // 5s, 10s, 15s
      console.log(`[Gemini] ${res.status} → ${wait / 1000}초 후 재시도 (${attempt + 1}/${retries})`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini API 오류 (${res.status}): ${JSON.stringify(err)}`);
    }

    const data  = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text  = parts
      .filter(p => !p.thought)
      .map(p => p.text ?? '')
      .join('');
    return text || '리포트 생성 실패';
  }

  throw new Error('Gemini API 재시도 초과');
}

// ── 클러스터 리포트 프롬프트 생성 ────────────────────────────────────────────
function buildClusterPrompt(clusterId, profile, labelInfo = {}) {
  const topActions = (profile.top_actions || [])
    .slice(0, 7)
    .map(a => `${a.action}(${a.count}회)`)
    .join(', ');

  const pageEntries = Object.entries(profile.page_dist || {})
    .sort((a, b) => b[1] - a[1])
    .map(([page, cnt]) => `${page}: ${cnt}회`)
    .join(', ');

  const typeName = labelInfo.name || labelInfo.label || `고객 유형 ${clusterId}`;
  const typeSummary = labelInfo.summary || '행동 패턴을 바탕으로 묶인 고객 유형입니다.';
  const typeAction = labelInfo.action || '대표 행동과 방문 페이지를 바탕으로 운영 액션을 제안하세요.';

  return `
당신은 이커머스 사용자 행동 분석 전문가입니다.
아래는 GhostTracker가 수집한 패션 쇼핑몰 고객 유형 "${typeName}"의 행동 데이터입니다.
운영자가 보는 리포트이므로 "클러스터", "클러스터 ${clusterId}번", "C${clusterId}" 같은 기술 용어는 본문에 쓰지 마세요.

[NLP 고객 유형 해석]
- 유형명: ${typeName}
- 쉬운 설명: ${typeSummary}
- 기본 추천 액션: ${typeAction}

[클러스터 통계]
- 세션 수: ${profile.count}개
- 주요 행동 (빈도순): ${topActions}
- 페이지 분포: ${pageEntries}

위 데이터를 바탕으로 다음을 한국어로 작성하세요 (총 4~6문장):
1. 먼저 "${typeName}"이라는 이름이 왜 붙었는지 쉬운 말로 설명
2. 대표 행동과 방문 페이지를 근거로 구매 의향 또는 탐색 중지 가능성 판단
3. 운영자가 오늘 바로 해볼 수 있는 개선 제안 1~2가지

문장 형태로만 작성하고, 번호나 불릿 포인트 없이 자연스럽게 이어지는 단락으로 써주세요.
첫 문장은 반드시 "${typeName} 유형은" 또는 "${typeName} 고객은"으로 시작하세요.
데이터가 아주 적더라도 "정보가 없어 판단하기 어렵다"로 끝내지 말고, 제공된 대표 행동과 NLP 해석을 근거로 조심스럽지만 실무적인 제안을 하세요.
"${BLOCKED_TERM}"이라는 단어는 사용하지 말고 반드시 "${REPLACEMENT_TERM}"라고 표현하세요.
`.trim();
}

// ── 세션 리포트 프롬프트 생성 ─────────────────────────────────────────────────
function buildSessionPrompt(body, profile) {
  const { cluster_id, persona, summary, action, confidence, events = [] } = body;

  const eventSummary = events
    .slice(0, 20)
    .map(e => `${e.event_type}@${e.page || '?'}`)
    .join(' → ');

  const topActions = (profile?.top_actions || [])
    .slice(0, 5)
    .map(a => a.action)
    .join(', ');

  return `
당신은 이커머스 사용자 행동 분석 전문가입니다.
아래는 GhostTracker가 분석한 특정 유저 세션 정보입니다.

[세션 정보]
- 고객 유형 ID: C${cluster_id}
- 고객 유형명: ${persona}
- NLP 유형 설명: ${summary || '(설명 없음)'}
- 기본 추천 액션: ${action || '(추천 액션 없음)'}
- 분류 신뢰도: ${(confidence * 100).toFixed(1)}%
- 이벤트 수: ${events.length}개
- 행동 흐름: ${eventSummary || '(데이터 없음)'}

[같은 유형의 대표 행동]
- 대표 행동: ${topActions}

위 정보를 바탕으로 다음을 한국어로 작성하세요 (총 3~5문장):
1. 이 세션 유저가 보인 핵심 행동 특징
2. 구매 전환 가능성 및 탐색 중지 위험 판단
3. 이 유저에게 추천할 운영/마케팅 액션 1가지

문장 형태로만, 번호 없이 자연스럽게 이어지는 단락으로 써주세요.
운영자가 보는 리포트이므로 "클러스터", "C${cluster_id}" 같은 기술 용어는 본문에 쓰지 마세요.
유형명, 유형 설명, 실제 행동 흐름을 함께 반영해서 운영자가 바로 이해할 수 있는 말로 작성하세요.
"${BLOCKED_TERM}"이라는 단어는 사용하지 말고 반드시 "${REPLACEMENT_TERM}"라고 표현하세요.
`.trim();
}

// ── GET /api/report/cluster/:clusterId ───────────────────────────────────────
router.get('/cluster/:clusterId', async (req, res) => {
  const clusterId = req.params.clusterId;

  try {
    const meta     = loadClusterMeta();
    const profiles = meta.cluster_profiles || {};
    const profile  = profiles[clusterId];
    const labelInfo = (meta.nlp_labels || {})[clusterId] || {};
    const cacheKey = `${clusterId}:${meta.nlp_labels_updated_at || ''}`;

    // 캐시 확인
    if (reportCache.has(cacheKey)) {
      return res.json({ cluster_id: clusterId, report: normalizeReportText(reportCache.get(cacheKey)), cached: true });
    }

    if (!profile) {
      return res.status(404).json({ error: `클러스터 ${clusterId} 프로파일 없음` });
    }

    if (String(req.query.prefer_local || '') === '1') {
      const overrideLabel = req.query.completed === '1'
        ? { ...labelInfo, name: String(req.query.persona || '주문을 완료한 고객') }
        : (req.query.persona ? { ...labelInfo, name: String(req.query.persona) } : labelInfo);
      const report = buildLocalClusterReport(clusterId, profile, overrideLabel);
      return res.json({ cluster_id: clusterId, report, cached: false, fallback: true, local_preferred: true });
    }

    try {
      const prompt = buildClusterPrompt(clusterId, profile, labelInfo);
      const report = normalizeReportText(await callGemini(prompt));
      if (!looksCompleteReport(report)) {
        throw new Error('Gemini report incomplete');
      }

      reportCache.set(cacheKey, report);

      res.json({ cluster_id: clusterId, report, cached: false });
    } catch (err) {
      if (!isGeminiUnavailable(err)) throw err;
      const report = buildLocalClusterReport(clusterId, profile, labelInfo);
      res.json({ cluster_id: clusterId, report, cached: false, fallback: true, warning: 'AI 리포트 서버가 혼잡해 자동 요약을 표시했습니다.' });
    }
  } catch (err) {
    console.error('[report/cluster] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/report/all ───────────────────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const meta     = loadClusterMeta();
    const profiles = meta.cluster_profiles || {};
    const labels   = meta.nlp_labels || {};
    const results  = [];

    for (const [clusterId, profile] of Object.entries(profiles)) {
      const cacheKey = `${clusterId}:${meta.nlp_labels_updated_at || ''}`;
      if (reportCache.has(cacheKey)) {
        results.push({ cluster_id: clusterId, report: normalizeReportText(reportCache.get(cacheKey)), cached: true });
        continue;
      }
      try {
        const prompt = buildClusterPrompt(clusterId, profile, labels[clusterId] || {});
        const report = normalizeReportText(await callGemini(prompt));
        if (!looksCompleteReport(report)) {
          throw new Error('Gemini report incomplete');
        }
        reportCache.set(cacheKey, report);
        results.push({ cluster_id: clusterId, report, cached: false });
      } catch (e) {
        if (isGeminiUnavailable(e)) {
          results.push({
            cluster_id: clusterId,
            report: buildLocalClusterReport(clusterId, profile, labels[clusterId] || {}),
            cached: false,
            fallback: true,
            warning: 'AI 리포트 서버가 혼잡해 자동 요약을 표시했습니다.',
          });
        } else {
          results.push({ cluster_id: clusterId, report: null, error: e.message });
        }
      }
      // 호출 간 1.5초 간격 (rate limit 방지)
      await sleep(1500);
    }

    res.json({ total: results.length, clusters: results });
  } catch (err) {
    console.error('[report/all] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/report/session ──────────────────────────────────────────────────
router.post('/session', async (req, res) => {
  try {
    const body = req.body;
    if (!body || body.cluster_id === undefined) {
      return res.status(400).json({ error: 'cluster_id 필요' });
    }

    const meta     = loadClusterMeta();
    const profiles = meta.cluster_profiles || {};
    const profile  = profiles[String(body.cluster_id)];

    let report;
    let fallback = false;
    let warning;
    if (body.prefer_local) {
      report = buildLocalSessionReport(body, profile);
      return res.json({
        session_id: body.session_id,
        cluster_id: body.cluster_id,
        persona: body.persona,
        confidence: body.confidence,
        report,
        fallback: true,
        local_preferred: true,
      });
    }
    try {
      const prompt = buildSessionPrompt(body, profile);
      report = normalizeReportText(await callGemini(prompt));
      if (!looksCompleteReport(report)) {
        throw new Error('Gemini report incomplete');
      }
    } catch (err) {
      if (!isGeminiUnavailable(err)) throw err;
      report = buildLocalSessionReport(body, profile);
      fallback = true;
      warning = 'AI 리포트 서버가 혼잡해 자동 요약을 표시했습니다.';
    }

    res.json({
      session_id: body.session_id,
      cluster_id: body.cluster_id,
      persona:    body.persona,
      confidence: body.confidence,
      report,
      fallback,
      warning,
    });
  } catch (err) {
    console.error('[report/session] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/report/cache/clear ───────────────────────────────────────────────
router.get('/cache/clear', (req, res) => {
  reportCache.clear();
  res.json({ message: '캐시 초기화 완료' });
});

// ── GET /api/report/weekly/download ───────────────────────────────────────────
router.get('/weekly/download', (req, res) => {
  try {
    const report = findLatestPdfReport();
    if (!report) {
      return res.status(404).json({
        error: '다운로드할 PDF 리포트가 없습니다. ml/report_html.py로 리포트를 먼저 생성하세요.',
      });
    }

    const filename = `ghosttracker_weekly_report_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.download(report.fullPath, filename);
  } catch (err) {
    console.error('[report/weekly/download] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
