const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { canonicalOrigin } = require('../middleware/siteAccess');

const ROOT = path.resolve(__dirname, '../..');
const CAPTURE_ROOT = path.join(ROOT, 'ml/output/reports/exit_captures/agent');
const RUN_RE = /^[A-Za-z0-9_-]{8,100}$/;
const FILE_RE = /^exit_hotspot_[1-3]_[a-f0-9]{10}\.png$/;

function tenantHash(origin) {
  return crypto.createHash('sha256').update(canonicalOrigin(origin)).digest('hex').slice(0, 16);
}

function runIdFor(plan) {
  return `${plan.period.startDate}_${plan.period.endDate}`.replace(/[^0-9_-]/g, '_');
}

function runPython(args, timeoutMs = 90_000) {
  const python = process.env.PYTHON_BIN || process.env.PYTHON || 'python';
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('화면 캡처 시간이 초과됐습니다.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `캡처 프로세스 종료 (${code})`));
      try { resolve(JSON.parse(stdout.trim() || '[]')); }
      catch { reject(new Error(`캡처 결과를 읽지 못했습니다: ${stderr.trim().slice(-300)}`)); }
    });
  });
}

function decorateCaptures(rows, runId) {
  return rows.filter((row) => FILE_RE.test(row.filename || '')).map((row) => ({
    ...row,
    image_url: `/api/agent/captures/${encodeURIComponent(runId)}/${encodeURIComponent(row.filename)}`,
    title: `${row.section === 'unknown' ? '화면 구역' : row.section} 이탈 집중 구역`,
    description: `${row.count.toLocaleString('ko-KR')}개 세션 · 전체 종료 신호의 ${row.share_pct}%`,
  }));
}

async function captureVisualHotspots(origin, plan) {
  const runId = runIdFor(plan);
  const outDir = path.join(CAPTURE_ROOT, tenantHash(origin), runId);
  const metadataPath = path.join(outDir, 'captures.json');
  if (!plan.refresh_snapshot && fs.existsSync(metadataPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const captures = decorateCaptures(cached, runId);
      if (captures.length && captures.every((row) => fs.existsSync(path.join(outDir, row.filename)))) {
        return { run_id: runId, captures, cached: true };
      }
    } catch { /* 손상된 캐시는 새로 생성한다. */ }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const script = path.join(ROOT, 'ml/agent_visual_capture.py');
  const rows = await runPython([
    script,
    '--start', plan.period.startDate,
    '--end', plan.period.endDate,
    '--origin', canonicalOrigin(origin),
    '--out-dir', outDir,
    '--limit', '2',
  ]);
  fs.writeFileSync(metadataPath, JSON.stringify(rows, null, 2), 'utf8');
  return { run_id: runId, captures: decorateCaptures(rows, runId), cached: false };
}

function resolveCapturePath(origin, runId, filename) {
  if (!RUN_RE.test(runId || '') || !FILE_RE.test(filename || '')) return null;
  const target = path.join(CAPTURE_ROOT, tenantHash(origin), runId, filename);
  const tenantRoot = path.join(CAPTURE_ROOT, tenantHash(origin)) + path.sep;
  if (!target.startsWith(tenantRoot) || !fs.existsSync(target)) return null;
  return target;
}

module.exports = { captureVisualHotspots, resolveCapturePath, tenantHash, runIdFor };
