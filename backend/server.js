/**
 * server.js — GhostTracker 백엔드 진입점
 * 역할: Express 서버를 띄우고 수집·로그·분류·클러스터·리포트 라우터를 한곳에 연결
 */
require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { connectDB } = require('./db');

const collectRouter  = require('./routes/collect');
const logsRouter     = require('./routes/logs');
const predictRouter  = require('./routes/predict');
const clustersRouter = require('./routes/clusters');
const classifyRouter = require('./routes/classify');
const reportRouter   = require('./routes/report');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS ──────────────────────────────────────────────────────
// SDK를 심은 쇼핑몰은 이 서버랑 다른 도메인이라, CORS 안 열어주면 fetch가 다 막힘
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// allowedOrigins는 사실 안 쓰는 중 — 어디에 SDK가 붙을지 아직 다 모르는 데모 단계라 origin: true로 일단 다 열어둠
app.use(cors({
  origin: true,   // 모든 출처 허용 (팀원 사이트 연동용)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ── Static (Dashboard) ────────────────────────────────────────
// public 폴더에 있는 운영자/전문가 대시보드 html을 파일째로 내려줌
app.use(express.static(path.join(__dirname, 'public')));

// ── Body Parser ───────────────────────────────────────────────
// SDK가 보내는 이벤트 JSON을 req.body로 파싱, 배치가 너무 커지지 않게 1mb로 제한
app.use(express.json({ limit: '1mb' }));

// ── 라우터 ────────────────────────────────────────────────────
// 경로별로 역할 나눠서 각 routes/ 파일에 위임 (수집 / 로그조회 / 옛 predict 호환 / 클러스터 / 분류 / 리포트)
app.use('/collect', collectRouter);
app.use('/api/logs', logsRouter);
app.use('/api/predict', predictRouter);
app.use('/api/clusters', clustersRouter);
app.use('/api/classify', classifyRouter);
app.use('/api/report',  reportRouter);

// ── 헬스체크 ──────────────────────────────────────────────────
// 서버 살아있는지만 확인하는 용도, 배포 후 모니터링이나 uptime 체크할 때 씀
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────
// 위 라우터 어디에도 안 걸리는 요청은 다 여기로 떨어져서 404로 정리
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── 서버 시작 ─────────────────────────────────────────────────
// DB 연결 없이 띄워봤자 의미 없어서, connectDB 끝나야 listen 시작. 연결 실패하면 그냥 프로세스 종료
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[GhostTracker] 서버 실행 중 → http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[GhostTracker] DB 연결 실패:', err.message);
    process.exit(1);
  });
