require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { connectDB } = require('./db');

const collectRouter = require('./routes/collect');
const logsRouter    = require('./routes/logs');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: true,   // 모든 출처 허용 (팀원 사이트 연동용)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ── Static (Dashboard) ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Body Parser ───────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── 라우터 ────────────────────────────────────────────────────
app.use('/collect', collectRouter);
app.use('/api/logs', logsRouter);

// ── 헬스체크 ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ── 서버 시작 ─────────────────────────────────────────────────
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
