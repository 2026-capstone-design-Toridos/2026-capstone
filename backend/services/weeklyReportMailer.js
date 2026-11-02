const nodemailer = require('nodemailer');
const WeeklyReport = require('../models/WeeklyReport');
const SiteReportSetting = require('../models/SiteReportSetting');

function smtpConfigured() {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'REPORT_EMAIL_FROM'];
  return required.every((name) => String(process.env[name] || '').trim());
}

function smtpConfigurationStatus() {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'REPORT_EMAIL_FROM'];
  const missing = required.filter((name) => !String(process.env[name] || '').trim());
  return { configured: missing.length === 0, missing };
}

function transporter() {
  if (!smtpConfigured()) throw new Error('SMTP_HOST와 REPORT_EMAIL_FROM 설정이 필요합니다.');
  const port = Number(process.env.SMTP_PORT) || 587;
  const auth = process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
    : undefined;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

async function sendWeeklyReportEmail(reportId) {
  const report = await WeeklyReport.findById(reportId).lean();
  if (!report || report.status !== 'ready' || report.email_status === 'sent') return report;

  const setting = await SiteReportSetting.findOne({ origin: report.origin }).lean();
  const recipients = (setting?.weekly_email_recipients || []).filter(Boolean);
  if (!setting?.weekly_email_enabled || !recipients.length) {
    return WeeklyReport.findByIdAndUpdate(reportId, {
      $set: { email_status: 'disabled', email_recipients: recipients },
    }, { new: true });
  }

  const now = new Date();
  const claimed = await WeeklyReport.findOneAndUpdate(
    {
      _id: reportId,
      status: 'ready',
      email_status: { $in: ['pending', 'failed'] },
      $or: [
        { next_email_attempt_at: { $exists: false } },
        { next_email_attempt_at: { $lte: now } },
      ],
    },
    {
      $set: {
        email_status: 'sending',
        email_recipients: recipients,
        email_error: '',
        email_lease_until: new Date(now.getTime() + 5 * 60_000),
      },
      $inc: { email_attempts: 1 },
    },
    { new: true },
  );
  if (!claimed) return WeeklyReport.findById(reportId);

  try {
    const mail = transporter();
    await mail.sendMail({
      from: process.env.REPORT_EMAIL_FROM,
      to: recipients.join(', '),
      subject: `[SEER] ${claimed.week_start} ~ ${claimed.week_end} 주간 리포트`,
      text: `지난주 쇼핑몰 고객 행동을 정리한 SEER 주간 리포트입니다.\n분석 기간: ${claimed.week_start} ~ ${claimed.week_end}`,
      html: `<div style="font-family:Arial,'Apple SD Gothic Neo',sans-serif;color:#172033;line-height:1.7"><h2 style="color:#155eef">SEER 주간 리포트</h2><p>지난주 쇼핑몰 고객 행동을 정리한 리포트입니다.</p><p><strong>분석 기간</strong><br>${claimed.week_start} ~ ${claimed.week_end}</p><p>자세한 내용은 첨부된 PDF에서 확인해주세요.</p></div>`,
      attachments: [{
        filename: `SEER_주간리포트_${claimed.week_start}_${claimed.week_end}.pdf`,
        path: claimed.pdf_path,
        contentType: 'application/pdf',
      }],
    });
    return WeeklyReport.findByIdAndUpdate(reportId, {
      $set: { email_status: 'sent', emailed_at: new Date(), email_error: '' },
      $unset: { email_lease_until: 1, next_email_attempt_at: 1 },
    }, { new: true });
  } catch (err) {
    const attempts = Number(claimed.email_attempts || 1);
    const retryMinutes = [15, 60, 180, 360][Math.min(attempts - 1, 3)];
    await WeeklyReport.findByIdAndUpdate(reportId, {
      $set: {
        email_status: 'failed',
        email_error: String(err.message || err).slice(0, 1000),
        next_email_attempt_at: new Date(Date.now() + retryMinutes * 60_000),
      },
      $unset: { email_lease_until: 1 },
    });
    throw err;
  }
}

async function verifySmtpConnection() {
  const status = smtpConfigurationStatus();
  if (!status.configured) {
    throw new Error(`SMTP 설정이 필요합니다: ${status.missing.join(', ')}`);
  }
  const mail = transporter();
  await mail.verify();
  return { ok: true };
}

async function sendTestEmail({ origin, recipients }) {
  await verifySmtpConnection();
  const to = [...new Set((recipients || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!to.length) throw new Error('테스트 메일을 받을 주소가 없습니다.');
  const sentAt = new Date();
  const info = await transporter().sendMail({
    from: process.env.REPORT_EMAIL_FROM,
    to: to.join(', '),
    subject: '[SEER] 주간 리포트 이메일 연결 테스트',
    text: `SEER 주간 리포트 이메일 연결 테스트가 완료되었습니다.\n쇼핑몰: ${origin}\n발송 시각: ${sentAt.toISOString()}`,
    html: `<div style="font-family:Arial,'Apple SD Gothic Neo',sans-serif;color:#172033;line-height:1.7"><h2 style="color:#155eef">SEER 이메일 연결 테스트</h2><p>주간 리포트 자동 발송을 위한 SMTP 연결이 정상입니다.</p><p><strong>쇼핑몰</strong><br>${String(origin || '').replace(/[<>&"]/g, '')}</p><p style="color:#68748a">${sentAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p></div>`,
  });
  return { ok: true, accepted: info.accepted || [], rejected: info.rejected || [], message_id: info.messageId || '' };
}

module.exports = {
  sendWeeklyReportEmail,
  sendTestEmail,
  verifySmtpConnection,
  smtpConfigured,
  smtpConfigurationStatus,
};
