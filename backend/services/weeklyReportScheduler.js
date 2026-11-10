const SiteKey = require('../models/SiteKey');
const WeeklyReport = require('../models/WeeklyReport');
const SiteReportSetting = require('../models/SiteReportSetting');
const { canonicalOrigin } = require('../middleware/siteAccess');
const { sendWeeklyReportEmail } = require('./weeklyReportMailer');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TICK_MS = Math.max(Number(process.env.WEEKLY_REPORT_SCHEDULER_TICK_MS) || 60_000, 10_000);
let ticking = false;
let timer = null;

function kstClock(now = new Date()) {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

async function ensureCurrentWeekRecords(service) {
  const period = service.previousCompletedWeek();
  const recentlyUsed = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
  const origins = await SiteKey.distinct('origin', {
    revoked: false,
    $or: [
      { source: 'admin' },
      { last_used_at: { $gte: recentlyUsed } },
    ],
  });
  for (const rawOrigin of origins) {
    const origin = canonicalOrigin(rawOrigin);
    const setting = await SiteReportSetting.findOne({ origin }).lean();
    await WeeklyReport.findOneAndUpdate(
      { origin, week_start: period.weekStart },
      {
        $setOnInsert: {
          week_end: period.weekEnd,
          timezone: 'Asia/Seoul',
          status: 'pending',
          next_generation_attempt_at: new Date(),
          email_status: setting?.weekly_email_enabled ? 'pending' : 'disabled',
          email_recipients: setting?.weekly_email_recipients || [],
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  return { period, origins: [...new Set(origins.map(canonicalOrigin))] };
}

async function tick(service) {
  if (ticking) return;
  ticking = true;
  try {
    const { period, origins } = await ensureCurrentWeekRecords(service);
    const now = new Date();
    const clock = kstClock(now);
    // 현재 완료 주의 리포트가 준비될 때까지 요일·시간과 관계없이 backoff에
    // 맞춰 재시도한다. 이전 구현은 화요일 06:00에 재시도를 예약하면서 동시에
    // 06:00부터 생성 창을 닫아 failed 상태가 영구히 남을 수 있었다.
    const generationWindow = true;

    // 한 번에 한 쇼핑몰만 시작해 MongoDB·분류 서버 부하가 대시보드에 번지지 않게 한다.
    const dueGeneration = generationWindow && origins.length ? await WeeklyReport.findOne({
      origin: { $in: origins },
      week_start: period.weekStart,
      $or: [
        { status: 'pending' },
        { status: 'failed', next_generation_attempt_at: { $lte: now } },
        { status: 'generating', generation_lease_until: { $lte: now } },
        { status: 'generating', generation_lease_until: { $exists: false } },
      ],
    }).sort({ created_at: 1 }).lean() : null;
    if (dueGeneration) service.queueWeeklyReport(dueGeneration.origin, period);

    const mondayNineHasPassed = clock.weekday > 1 || (clock.weekday === 1 && clock.hour >= 9);
    if (mondayNineHasPassed) {
      const dueEmail = await WeeklyReport.findOne({
        week_start: period.weekStart,
        status: 'ready',
        email_status: { $in: ['pending', 'failed'] },
        $or: [
          { next_email_attempt_at: { $exists: false } },
          { next_email_attempt_at: { $lte: now } },
        ],
      }).sort({ generated_at: 1 }).lean();
      if (dueEmail) {
        sendWeeklyReportEmail(dueEmail._id).catch((err) => {
          console.error('[weekly-report/email] 발송 실패:', err.message);
        });
      }
    }
  } catch (err) {
    console.error('[weekly-report/scheduler] 작업 실패:', err.message);
  } finally {
    ticking = false;
  }
}

function startWeeklyReportScheduler(service) {
  if (timer) return timer;
  setTimeout(() => tick(service), 2_000).unref?.();
  timer = setInterval(() => tick(service), TICK_MS);
  timer.unref?.();
  console.log('[SEER] 주간 리포트 스케줄러 시작 (월요일 기준, KST)');
  return timer;
}

module.exports = { startWeeklyReportScheduler, tick, kstClock };
