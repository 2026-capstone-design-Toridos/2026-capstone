require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
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
  origin: (origin, callback) => {
    // origin 없는 요청 (서버간 호출, curl 등) 허용
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS 차단: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

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
