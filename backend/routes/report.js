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

// 인메모리 캐시 (서버 재시작 시 초기화)
const reportCache = new Map();

// ── 클러스터 메타 로드 ────────────────────────────────────────────────────────
function loadClusterMeta() {
  if (!fs.existsSync(META_PATH)) {
    throw new Error(`cluster_meta.json 없음: ${META_PATH}`);
  }
  return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
}

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
function buildClusterPrompt(clusterId, profile) {
  const topActions = profile.top_actions
    .slice(0, 7)
    .map(a => `${a.action}(${a.count}회)`)
    .join(', ');

  const pageEntries = Object.entries(profile.page_dist)
    .sort((a, b) => b[1] - a[1])
    .map(([page, cnt]) => `${page}: ${cnt}회`)
    .join(', ');

  return `
당신은 이커머스 사용자 행동 분석 전문가입니다.
아래는 GhostTracker가 수집한 패션 쇼핑몰 세션 클러스터 ${clusterId}번의 행동 데이터입니다.

[클러스터 통계]
- 세션 수: ${profile.count}개
- 주요 행동 (빈도순): ${topActions}
- 페이지 분포: ${pageEntries}

위 데이터를 바탕으로 다음을 한국어로 작성하세요 (총 4~6문장):
1. 이 클러스터 유저의 행동 패턴 요약 (어떤 페이지에서 뭘 주로 하는지)
2. 이 유저의 구매 의향 수준 판단 (높음/중간/낮음 + 근거)
3. 비즈니스 관점에서의 개선 제안 1~2가지

문장 형태로만 작성하고, 번호나 불릿 포인트 없이 자연스럽게 이어지는 단락으로 써주세요.
`.trim();
}

// ── 세션 리포트 프롬프트 생성 ─────────────────────────────────────────────────
function buildSessionPrompt(body, profile) {
  const { cluster_id, persona, confidence, events = [] } = body;

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
- 배정된 클러스터: ${cluster_id}번 (${persona})
- 분류 신뢰도: ${(confidence * 100).toFixed(1)}%
- 이벤트 수: ${events.length}개
- 행동 흐름: ${eventSummary || '(데이터 없음)'}

[클러스터 평균 행동]
- 이 클러스터의 대표 행동: ${topActions}

위 정보를 바탕으로 다음을 한국어로 작성하세요 (총 3~5문장):
1. 이 세션 유저가 보인 핵심 행동 특징
2. 구매 전환 가능성 및 이탈 위험 판단
3. 이 유저에게 추천할 운영/마케팅 액션 1가지

문장 형태로만, 번호 없이 자연스럽게 이어지는 단락으로 써주세요.
`.trim();
}

// ── GET /api/report/cluster/:clusterId ───────────────────────────────────────
router.get('/cluster/:clusterId', async (req, res) => {
  const clusterId = req.params.clusterId;

  // 캐시 확인
  if (reportCache.has(clusterId)) {
    return res.json({ cluster_id: clusterId, report: reportCache.get(clusterId), cached: true });
  }

  try {
    const meta     = loadClusterMeta();
    const profiles = meta.cluster_profiles || {};
    const profile  = profiles[clusterId];

    if (!profile) {
      return res.status(404).json({ error: `클러스터 ${clusterId} 프로파일 없음` });
    }

    const prompt = buildClusterPrompt(clusterId, profile);
    const report = await callGemini(prompt);

    reportCache.set(clusterId, report);

    res.json({ cluster_id: clusterId, report, cached: false });
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
    const results  = [];

    for (const [clusterId, profile] of Object.entries(profiles)) {
      if (reportCache.has(clusterId)) {
        results.push({ cluster_id: clusterId, report: reportCache.get(clusterId), cached: true });
        continue;
      }
      try {
        const prompt = buildClusterPrompt(clusterId, profile);
        const report = await callGemini(prompt);
        reportCache.set(clusterId, report);
        results.push({ cluster_id: clusterId, report, cached: false });
      } catch (e) {
        results.push({ cluster_id: clusterId, report: null, error: e.message });
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

    const prompt = buildSessionPrompt(body, profile);
    const report = await callGemini(prompt);

    res.json({
      session_id: body.session_id,
      cluster_id: body.cluster_id,
      persona:    body.persona,
      confidence: body.confidence,
      report,
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
