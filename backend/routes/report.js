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
const { execFile } = require('child_process');
const router  = express.Router();
const { canonicalOrigin } = require('../middleware/siteAccess');
const clustersRouter = require('./clusters');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// API 키는 URL이 아니라 x-goog-api-key 헤더로 보낸다.
// 쿼리 스트링에 실으면 서버 로그·프록시 로그·에러 메시지에 키가 그대로 남는다.
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// cluster_meta.json 경로 (ml/output/unsupervised_semantic/)
const META_PATH = path.join(__dirname, '../../ml/output/unsupervised_semantic/cluster_meta.json');
const REPORTS_DIR = path.join(__dirname, '../../ml/output/reports');
const SNAPSHOT_DIR = path.join(__dirname, '../../ml/output/unsupervised_semantic/site_snapshots');
const BLOCKED_TERM = '\uC774\uD0C8';
const REPLACEMENT_TERM = '탐색 중지';

// 인메모리 캐시 (서버 재시작 시 초기화)
const reportCache = new Map();
const reportGenerationJobs = new Map();
const REPORT_INPUT_DIR = path.join(REPORTS_DIR, 'inputs');

// ── 사이트 식별 ───────────────────────────────────────────────────────────────
// origin을 파일명에 쓸 수 있는 형태로 바꾼다 (clusters.js의 snapshotKey와 같은 규칙)
function siteKey(origin = '') {
  // 끝 슬래시를 먼저 없앤다. 안 그러면 "site.com"과 "site.com/"이
  // 서로 다른 PDF 파일명으로 갈려서 리포트를 못 찾는다.
  return canonicalOrigin(origin)
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9._-]+/g, '_');
}

function localDateValue(date = new Date(), compact = false) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return compact ? `${year}${month}${day}` : `${year}-${month}-${day}`;
}

// ── 클러스터 메타 로드 ────────────────────────────────────────────────────────
// cluster_meta.json을 읽어온다, 없으면 에러
function loadClusterMeta() {
  if (!fs.existsSync(META_PATH)) {
    throw new Error(`cluster_meta.json 없음: ${META_PATH}`);
  }
  return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
}

/**
 * 사이트별 클러스터 프로파일을 가져온다.
 *
 * 예전에는 어느 사이트를 보고 있든 cluster_meta.json(모든 사이트를 합쳐 학습한
 * 전역 결과)만 읽었다. 그래서 A몰 운영자가 B몰 고객까지 섞인 리포트를 봤다.
 * clusters.js가 저장해 둔 사이트 스냅샷이 있으면 그것을 우선 사용한다.
 *
 * @returns {{ profiles, labels, source, version, meta }}
 */
function loadSiteProfiles(origin) {
  const meta   = loadClusterMeta();
  const labels = meta.nlp_labels || {};

  if (origin) {
    const snapPath = path.join(SNAPSHOT_DIR, `${siteKey(origin)}.json`);

    if (fs.existsSync(snapPath)) {
      try {
        const snapshot   = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        const profiles   = {};
        const snapLabels = {};

        // 스냅샷의 clusters 배열을 cluster_profiles 형태로 변환
        for (const c of snapshot.clusters || []) {
          const id = String(c.cluster);
          profiles[id] = {
            count:       c.count || 0,
            top_actions: c.top_actions || [],
            page_dist:   c.page_dist || {},
          };
          snapLabels[id] = {
            name:    c.label   || labels[id]?.name    || '',
            summary: c.summary || labels[id]?.summary || '',
            action:  c.action  || labels[id]?.action  || '',
          };
        }

        if (Object.keys(profiles).length > 0) {
          return {
            profiles,
            labels:  snapLabels,
            source:  'site_snapshot',
            version: snapshot.snapshot_saved_at || '',
            meta,
          };
        }
      } catch (err) {
        console.warn('[report] 사이트 스냅샷 로드 실패, 전체 메타로 대체:', err.message);
      }
    }
  }

  // 스냅샷이 없으면 전역 메타로 떨어진다 — 응답의 profile_source로 구분 가능
  return {
    profiles: meta.cluster_profiles || {},
    labels,
    source:   origin ? 'global_meta_fallback' : 'global_meta',
    version:  meta.nlp_labels_updated_at || '',
    meta,
  };
}

/**
 * 해당 사이트의 최신 PDF 리포트를 찾는다.
 *
 * 예전에는 reports 폴더에서 mtime이 가장 최근인 PDF 하나를 무조건 돌려줬다.
 * 누가 어떤 사이트를 보고 있든 같은 파일이 내려가서, 다른 쇼핑몰의
 * 주간 리포트가 그대로 다운로드됐다.
 *
 * 파일명 규칙: ghosttracker_report_{siteKey}_{YYYYMMDD}.pdf
 * (ml/report_html.py --origin 옵션이 이 규칙으로 저장한다)
 */
function findCurrentPdfReport(origin) {
  if (!fs.existsSync(REPORTS_DIR)) return null;

  const key = origin ? siteKey(origin) : '';
  const stamp = localDateValue(new Date(), true);
  const expectedName = key ? `ghosttracker_report_${key}_${stamp}.pdf` : '';

  const files = fs.readdirSync(REPORTS_DIR)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    // 당일 보고서만 재사용한다. 전날 파일을 '이번 주' 보고서로 내려주지 않는다.
    .filter((name) => (key
      ? name.toLowerCase() === expectedName.toLowerCase()
      : name.includes(stamp) && !name.includes('.generating.')))
    .map((name) => {
      const fullPath = path.join(REPORTS_DIR, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0] || null;
}

function findCurrentHtmlReport(origin) {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const key = origin ? siteKey(origin) : '';
  const stamp = localDateValue(new Date(), true);
  const expectedName = key ? `ghosttracker_report_${key}_${stamp}.html` : '';
  const files = fs.readdirSync(REPORTS_DIR)
    .filter((name) => name.toLowerCase().endsWith('.html'))
    .filter((name) => (key
      ? name.toLowerCase() === expectedName.toLowerCase()
      : name.includes(stamp) && !name.includes('.generating.')))
    .map((name) => {
      const fullPath = path.join(REPORTS_DIR, name);
      return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] || null;
}

/**
 * 사이트 전용 PDF가 없을 때 보고서 생성기를 한 번만 실행한다.
 * execFile을 사용해 origin을 셸 문자열로 해석하지 않으며, 동일 사이트의
 * 동시 요청은 같은 Promise를 공유해 중복 생성을 막는다.
 */
function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${String(text).replaceAll('"', '""')}"`;
}

function removeGeneratedArtifact(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn('[report/generate] 임시 파일 정리 실패:', err.message);
  }
}

async function writeSiteResultCsv(origin) {
  const result = await clustersRouter.buildSiteReportData(origin);
  if (!result.total_sessions || !result.clusters?.length) {
    throw new Error('이 쇼핑몰의 분석 가능한 고객 행동이 아직 없습니다. 고객 행동을 수집한 뒤 다시 시도해주세요.');
  }

  fs.mkdirSync(REPORT_INPUT_DIR, { recursive: true });
  const csvPath = path.join(REPORT_INPUT_DIR, `${siteKey(origin)}_result.csv`);
  const headers = [
    'origin', 'total_sessions', 'cluster_id', 'name', 'count',
    'summary', 'action', 'top_actions_json', 'page_dist_json',
  ];
  const rows = result.clusters.map((cluster) => [
    canonicalOrigin(origin), result.total_sessions, cluster.cluster, cluster.label,
    cluster.count, cluster.summary || '', cluster.action || '',
    cluster.top_actions || [], cluster.page_dist || {},
  ].map(csvCell).join(','));
  fs.writeFileSync(csvPath, [headers.join(','), ...rows].join('\n'), 'utf8');
  return csvPath;
}

async function generatePdfReport(origin) {
  const key = siteKey(origin);
  if (!key) return Promise.reject(new Error('보고서를 생성할 사이트 정보가 없습니다.'));
  if (reportGenerationJobs.has(key)) return reportGenerationJobs.get(key);

  const scriptPath = path.join(__dirname, '../../ml/report_html.py');
  const stamp = localDateValue(new Date(), true);
  const outputPath = path.join(REPORTS_DIR, `ghosttracker_report_${key}_${stamp}.pdf`);
  const stagingPath = path.join(REPORTS_DIR, `.ghosttracker_report_${key}_${stamp}_${process.pid}.generating.pdf`);
  const stagingHtmlPath = stagingPath.replace(/\.pdf$/i, '.html');
  const oraclePython = '/home/opc/ghosttracker-venv/bin/python3.11';
  const pythonBin = process.env.PYTHON_BIN
    || (fs.existsSync(oraclePython) ? oraclePython : (process.platform === 'win32' ? 'python' : 'python3'));
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6);
  const dateValue = (date) => localDateValue(date);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const job = (async () => {
    const resultCsv = await writeSiteResultCsv(origin);
    return new Promise((resolve, reject) => {
      execFile(
        pythonBin,
        [
          scriptPath,
          '--origin', canonicalOrigin(origin),
          '--result-csv', resultCsv,
          '--start', dateValue(startDate),
          '--end', dateValue(endDate),
          '--output', stagingPath,
        ],
        {
          cwd: path.join(__dirname, '../../ml'),
          timeout: 180000,
          maxBuffer: 2 * 1024 * 1024,
          // GEMINI_API_KEY를 그대로 전달해 사이트별 result.csv를 기반으로
          // 보고서 문장을 생성한다. API 장애 시 Python 템플릿이 폴백한다.
          env: { ...process.env },
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[report/generate] 실패:', stderr || stdout || err.message);
            removeGeneratedArtifact(stagingPath);
            removeGeneratedArtifact(stagingHtmlPath);
            reject(new Error('주간 보고서를 생성하지 못했습니다. 잠시 후 다시 시도해주세요.'));
            return;
          }
          if (!fs.existsSync(stagingPath)) {
            removeGeneratedArtifact(stagingHtmlPath);
            reject(new Error('보고서 생성은 완료됐지만 PDF 파일을 찾지 못했습니다.'));
            return;
          }
          try {
            const outputHtmlPath = outputPath.replace(/\.pdf$/i, '.html');
            removeGeneratedArtifact(outputPath);
            removeGeneratedArtifact(outputHtmlPath);
            fs.renameSync(stagingPath, outputPath);
            if (fs.existsSync(stagingHtmlPath)) fs.renameSync(stagingHtmlPath, outputHtmlPath);
            resolve(outputPath);
          } catch (moveErr) {
            removeGeneratedArtifact(stagingPath);
            removeGeneratedArtifact(stagingHtmlPath);
            reject(new Error('완성된 주간 보고서를 저장하지 못했습니다.'));
          }
        },
      );
    });
  })().finally(() => reportGenerationJobs.delete(key));

  reportGenerationJobs.set(key, job);
  return job;
}

// ── Gemini API 호출 (재시도 포함) ────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "이탈"은 운영자에게 부정적으로 읽혀서 "탐색 중지"로 통일한다.
//
// 단순 치환은 조사를 깨뜨린다.
// "이탈"은 받침이 있고 "중지"는 없어서 붙는 조사가 달라지기 때문이다.
//   이탈이 → 탐색 중지이 (X)  → 탐색 중지가 (O)
//   이탈을 → 탐색 중지을 (X)  → 탐색 중지를 (O)
// 조사가 붙은 형태를 먼저 처리하고, 남은 것을 마지막에 바꾼다.
// 반드시 긴 것부터. "이탈이나"가 "이탈이"에 먼저 걸리면 "탐색 중지가나"가 된다.
const TERM_REPLACEMENTS = [
  [`${BLOCKED_TERM}이나`, `${REPLACEMENT_TERM}나`],
  [`${BLOCKED_TERM}이라`, `${REPLACEMENT_TERM}라`],
  [`${BLOCKED_TERM}으로`, `${REPLACEMENT_TERM}로`],
  [`${BLOCKED_TERM}이`, `${REPLACEMENT_TERM}가`],
  [`${BLOCKED_TERM}을`, `${REPLACEMENT_TERM}를`],
  [`${BLOCKED_TERM}은`, `${REPLACEMENT_TERM}는`],
  [`${BLOCKED_TERM}과`, `${REPLACEMENT_TERM}와`],
  [BLOCKED_TERM, REPLACEMENT_TERM],
];

function normalizeReportText(text) {
  let value = String(text || '');
  for (const [from, to] of TERM_REPLACEMENTS) {
    value = value.replaceAll(from, to);
  }
  return value;
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
// "Gemini를 못 쓰는 상황"인지 판정한다. true면 로컬 요약으로 조용히 대체한다.
//
// GEMINI_API_KEY 미설정을 여기 포함시키는 이유:
// 키가 없는 환경(로컬 개발, 아직 환경변수를 못 넣은 배포)에서 이게 빠지면
// 예외가 그대로 올라가 리포트 요청이 500으로 실패한다.
// 리포트는 없어도 되는 부가 기능이므로, 못 만들면 로컬 문장으로 내려가야지
// 화면 전체를 깨뜨리면 안 된다.
function isGeminiUnavailable(err) {
  const message = String(err?.message || '');
  return message.includes('GEMINI_API_KEY')
    || message.includes('503')
    || message.includes('429')
    || message.includes('500')
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
    VIEW_DETAIL: '상세정보 확인',
    VIEW_REVIEW: '리뷰 확인',
    VIEW_QNA: '상품 문의 확인',
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
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
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
  const origin    = req.siteOrigin || null;

  try {
    const { profiles, labels, source, version } = loadSiteProfiles(origin);
    const profile   = profiles[clusterId];
    const labelInfo = labels[clusterId] || {};

    // 캐시 키에 사이트를 포함한다. 넣지 않으면 A몰에서 만든 리포트가
    // B몰 운영자에게 그대로 재사용된다.
    const cacheKey = `${siteKey(origin)}:${clusterId}:${version}`;

    // 같은 사이트·같은 버전에서는 Gemini 결과를 재사용해 비용과 지연을 줄인다
    if (reportCache.has(cacheKey)) {
      return res.json({
        cluster_id: clusterId,
        report: normalizeReportText(reportCache.get(cacheKey)),
        cached: true,
        origin,
        profile_source: source,
      });
    }

    if (!profile) {
      return res.status(404).json({ error: `클러스터 ${clusterId} 프로파일 없음` });
    }

    // 데모/장애 대응용: Gemini 호출 없이 로컬 preset/요약만으로 즉시 응답
    if (String(req.query.prefer_local || '') === '1') {
      const overrideLabel = req.query.completed === '1'
        ? { ...labelInfo, name: String(req.query.persona || '주문을 완료한 고객') }
        : (req.query.persona ? { ...labelInfo, name: String(req.query.persona) } : labelInfo);
      const report = buildLocalClusterReport(clusterId, profile, overrideLabel);
      return res.json({
        cluster_id: clusterId, report, cached: false, fallback: true,
        local_preferred: true, origin, profile_source: source,
      });
    }

    try {
      const prompt = buildClusterPrompt(clusterId, profile, labelInfo);
      const report = normalizeReportText(await callGemini(prompt));
      if (!looksCompleteReport(report)) {
        throw new Error('Gemini report incomplete');
      }

      reportCache.set(cacheKey, report);

      res.json({ cluster_id: clusterId, report, cached: false, origin, profile_source: source });
    } catch (err) {
      if (!isGeminiUnavailable(err)) throw err;
      // 왜 로컬로 내려갔는지 로그에 남긴다.
      // 이게 없으면 키 미설정인지 API 장애인지 구분할 방법이 없다.
      console.warn(`[report] Gemini 미사용 → 로컬 요약: ${err.message}`);
      const report = buildLocalClusterReport(clusterId, profile, labelInfo);
      res.json({
        cluster_id: clusterId, report, cached: false, fallback: true,
        origin, profile_source: source,
        warning: 'AI 리포트 서버가 혼잡해 자동 요약을 표시했습니다.',
      });
    }
  } catch (err) {
    console.error('[report/cluster] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/report/all ───────────────────────────────────────────────────────
router.get('/all', async (req, res) => {
  const origin = req.siteOrigin || null;

  try {
    const { profiles, labels, source, version } = loadSiteProfiles(origin);
    const results = [];

    for (const [clusterId, profile] of Object.entries(profiles)) {
      const cacheKey = `${siteKey(origin)}:${clusterId}:${version}`;
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
      // 전체 생성은 Gemini rate limit에 걸리기 쉬워 호출 간격을 둔다
      await sleep(1500);
    }

    res.json({ total: results.length, clusters: results, origin, profile_source: source });
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

    // 세션 리포트도 이 사이트 기준 프로파일로 설명한다
    const { profiles } = loadSiteProfiles(req.siteOrigin || null);
    const profile = profiles[String(body.cluster_id)];

    let report;
    let fallback = false;
    let warning;
    // 프론트에서 빠른 응답을 원할 때는 외부 AI 호출 없이 로컬 문장 생성
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
      // 왜 로컬로 내려갔는지 로그에 남긴다.
      // 이게 없으면 키 미설정인지 API 장애인지 구분할 방법이 없다.
      console.warn(`[report] Gemini 미사용 → 로컬 요약: ${err.message}`);
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
// 자기 쇼핑몰 리포트만 다시 만들게 한다.
//
// 예전에는 reportCache.clear()로 전체를 날렸다. 이 라우터는 requireSite만
// 통과하면 되므로, 사장님 아무나 다른 모든 쇼핑몰의 캐시까지 지울 수 있었다.
// 그러면 남의 리포트가 전부 Gemini 재호출로 넘어가 비용과 지연이 같이 튄다.
//
// 캐시 키가 `${siteKey(origin)}:${clusterId}:${version}` 형태라
// 앞부분만 보고 자기 것만 골라 지울 수 있다.
router.get('/cache/clear', (req, res) => {
  const origin = req.siteOrigin || null;

  // 개방 모드(로컬 개발)에서는 볼 수 있는 사이트가 고정돼 있지 않으므로 기존대로 전체 삭제
  if (!origin) {
    const total = reportCache.size;
    reportCache.clear();
    return res.json({ message: '캐시 초기화 완료', cleared: total, scope: 'all' });
  }

  const prefix = `${siteKey(origin)}:`;
  let cleared = 0;

  for (const key of [...reportCache.keys()]) {
    if (key.startsWith(prefix)) {
      reportCache.delete(key);
      cleared += 1;
    }
  }

  res.json({ message: '캐시 초기화 완료', cleared, scope: origin });
});

// ── GET /api/report/weekly/download ───────────────────────────────────────────
router.get('/weekly/download', async (req, res) => {
  try {
    const origin = req.siteOrigin || null;
    let report = findCurrentPdfReport(origin);

    if (!report) {
      if (!origin) {
        return res.status(400).json({ error: '보고서를 생성할 쇼핑몰을 먼저 선택해주세요.' });
      }
      await generatePdfReport(origin);
      report = findCurrentPdfReport(origin);
      if (!report) throw new Error('생성된 PDF 보고서를 찾지 못했습니다.');
    }

    const datePart = localDateValue();
    const filename = origin
      ? `ghosttracker_weekly_report_${siteKey(origin)}_${datePart}.pdf`
      : `ghosttracker_weekly_report_${datePart}.pdf`;
    res.download(report.fullPath, filename);
  } catch (err) {
    console.error('[report/weekly/download] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PDF 변환 직전의 동일한 HTML 원본을 대시보드 안에서 보여준다.
// 화면과 PDF가 서로 다른 요약 규칙을 갖지 않도록 한 생성 결과를 함께 사용한다.
router.get('/weekly/view', async (req, res) => {
  try {
    const origin = req.siteOrigin || null;
    if (!origin) {
      return res.status(400).send('<p>리포트를 볼 쇼핑몰을 먼저 선택해주세요.</p>');
    }
    let report = findCurrentHtmlReport(origin);
    if (!report) {
      await generatePdfReport(origin);
      report = findCurrentHtmlReport(origin);
    }
    if (!report) throw new Error('생성된 웹 리포트를 찾지 못했습니다.');
    res.sendFile(report.fullPath);
  } catch (err) {
    console.error('[report/weekly/view] 오류:', err.message);
    res.status(500).send(`<html lang="ko"><body><p>리포트를 준비하지 못했습니다. ${String(err.message).replace(/[<>&"]/g, '')}</p></body></html>`);
  }
});

module.exports = router;
