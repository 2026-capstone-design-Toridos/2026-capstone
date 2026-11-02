/**
 * adminKeys.js — 사이트 접근 키 관리 API
 *
 * 역할: 쇼핑몰마다 접근 키를 발급·조회·폐기한다.
 *
 * ── 왜 만들었나 ─────────────────────────────────────────────────
 *  예전에는 사장님이 한 분 늘 때마다
 *    1. 터미널에서 랜덤 문자열 생성
 *    2. 서버 SITE_KEYS 환경변수 편집
 *    3. 서버 재시작
 *  을 해야 했다. 서버 접근 권한이 있는 사람만 가능했고 실수하기 쉬웠다.
 *
 * ── 보호 ────────────────────────────────────────────────────────
 *  모든 엔드포인트가 ADMIN_KEY를 요구한다(requireAdmin).
 *  이 화면이 뚫리면 아무나 아무 사이트의 키를 만들 수 있으므로,
 *  ADMIN_KEY가 설정돼 있지 않으면 기능 자체가 비활성화된다.
 *
 * GET    /api/admin/keys        목록
 * POST   /api/admin/keys        발급   { origin, label? }
 * DELETE /api/admin/keys/:id    폐기
 * POST   /api/admin/keys/:id/restore  폐기 취소
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const SiteKey = require('../models/SiteKey');
const SiteReportSetting = require('../models/SiteReportSetting');
const WeeklyReport = require('../models/WeeklyReport');
const {
  smtpConfigured,
  smtpConfigurationStatus,
  verifySmtpConnection,
  sendTestEmail,
} = require('../services/weeklyReportMailer');
const { normalizeOrigin, invalidateKeyCache } = require('../middleware/siteAccess');

/** 추측하기 어려운 키를 만든다 (24자, URL에 그대로 쓸 수 있는 문자만) */
function generateKey() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * 입력받은 쇼핑몰 주소를 저장 형태로 다듬는다.
 *
 * 사장님 주소를 손으로 입력하다 보면 형태가 제각각이다.
 *   hshh2020.cafe24.com
 *   https://hshh2020.cafe24.com/
 *   https://hshh2020.cafe24.com/product/detail.html
 * 전부 https://hshh2020.cafe24.com 으로 통일해야 수집 데이터와 매칭된다.
 */
function cleanOrigin(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';

  // 프로토콜이 없으면 https를 붙인다 (Cafe24는 전부 https)
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const url = new URL(value);
    // 모바일 도메인은 데스크톱과 같은 사이트로 합친다 (collect.js와 동일 규칙)
    const host = url.host.replace(/^m\./i, '');
    return normalizeOrigin(`${url.protocol}//${host}`);
  } catch {
    return '';
  }
}

// ── GET /api/admin/keys — 목록 ────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const includeRevoked = String(req.query.include_revoked || '') === '1';
    const filter = includeRevoked ? {} : { revoked: false };

    const keys = await SiteKey.find(filter).sort({ created_at: -1 }).lean();
    const origins = [...new Set(keys.map((key) => key.origin))];
    const [settings, latestReports] = await Promise.all([
      SiteReportSetting.find({ origin: { $in: origins } }).lean(),
      WeeklyReport.aggregate([
        { $match: { origin: { $in: origins } } },
        { $sort: { week_start: -1 } },
        { $group: { _id: '$origin', report: { $first: '$$ROOT' } } },
      ]),
    ]);
    const settingByOrigin = new Map(settings.map((setting) => [setting.origin, setting]));
    const reportByOrigin = new Map(latestReports.map((row) => [row._id, row.report]));

    res.json({
      total: keys.length,
      keys: keys.map((k) => ({
        id:           k._id,
        key:          k.key,
        origin:       k.origin,
        label:        k.label,
        revoked:      k.revoked,
        source:       k.source,
        created_at:   k.created_at,
        last_used_at: k.last_used_at || null,
        report_settings: {
          enabled: Boolean(settingByOrigin.get(k.origin)?.weekly_email_enabled),
          recipients: settingByOrigin.get(k.origin)?.weekly_email_recipients || [],
        },
        latest_report: reportByOrigin.get(k.origin) ? {
          week_start: reportByOrigin.get(k.origin).week_start,
          week_end: reportByOrigin.get(k.origin).week_end,
          status: reportByOrigin.get(k.origin).status,
          generated_at: reportByOrigin.get(k.origin).generated_at || null,
          email_status: reportByOrigin.get(k.origin).email_status,
          emailed_at: reportByOrigin.get(k.origin).emailed_at || null,
          error: reportByOrigin.get(k.origin).generation_error || reportByOrigin.get(k.origin).email_error || '',
        } : null,
      })),
      smtp_configured: smtpConfigured(),
      smtp_missing: smtpConfigurationStatus().missing,
    });
  } catch (err) {
    console.error('[admin/keys] 목록 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/smtp/status', async (req, res) => {
  const configuration = smtpConfigurationStatus();
  if (!configuration.configured) {
    return res.json({ ...configuration, connected: false });
  }
  try {
    await verifySmtpConnection();
    return res.json({ ...configuration, connected: true });
  } catch (err) {
    return res.status(502).json({ ...configuration, connected: false, error: err.message });
  }
});

function normalizeRecipients(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const unique = [...new Set(items.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  if (unique.length > 5) throw new Error('수신 이메일은 최대 5개까지 입력할 수 있습니다.');
  const invalid = unique.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalid) throw new Error(`이메일 형식이 올바르지 않습니다: ${invalid}`);
  return unique;
}

// 같은 쇼핑몰에 키가 여러 개여도 리포트 설정은 origin 하나에만 저장한다.
router.patch('/:id/report-settings', async (req, res) => {
  try {
    const key = await SiteKey.findById(req.params.id).lean();
    if (!key) return res.status(404).json({ error: '키를 찾을 수 없습니다.' });
    const recipients = normalizeRecipients(req.body?.recipients);
    const enabled = req.body?.enabled === true;
    if (enabled && !recipients.length) {
      return res.status(400).json({ error: '자동 발송을 사용하려면 수신 이메일을 입력하세요.' });
    }
    const setting = await SiteReportSetting.findOneAndUpdate(
      { origin: key.origin },
      {
        $set: {
          weekly_email_enabled: enabled,
          weekly_email_recipients: recipients,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await WeeklyReport.updateMany(
      { origin: key.origin, email_status: { $ne: 'sent' } },
      {
        $set: {
          email_status: enabled ? 'pending' : 'disabled',
          email_recipients: recipients,
        },
        $unset: { email_error: 1, next_email_attempt_at: 1, email_lease_until: 1 },
      },
    );
    return res.json({
      ok: true,
      origin: key.origin,
      report_settings: { enabled: setting.weekly_email_enabled, recipients: setting.weekly_email_recipients },
      smtp_configured: smtpConfigured(),
    });
  } catch (err) {
    const status = /이메일|최대/.test(err.message) ? 400 : 500;
    return res.status(status).json({ error: err.message || '서버 오류' });
  }
});

router.post('/:id/report-settings/test', async (req, res) => {
  try {
    const key = await SiteKey.findById(req.params.id).lean();
    if (!key) return res.status(404).json({ error: '키를 찾을 수 없습니다.' });
    const setting = await SiteReportSetting.findOne({ origin: key.origin }).lean();
    const recipients = setting?.weekly_email_recipients || [];
    if (!recipients.length) {
      return res.status(400).json({ error: '먼저 수신 이메일을 저장하세요.' });
    }
    const result = await sendTestEmail({ origin: key.origin, recipients });
    return res.json({ ...result, recipients });
  } catch (err) {
    const status = /SMTP 설정|받을 주소|수신 이메일/.test(err.message) ? 400 : 502;
    return res.status(status).json({ error: err.message });
  }
});

// ── POST /api/admin/keys — 발급 ───────────────────────────────
router.post('/', async (req, res) => {
  try {
    const origin = cleanOrigin(req.body?.origin);
    const label  = String(req.body?.label || '').trim().slice(0, 80);

    if (!origin) {
      return res.status(400).json({ error: '쇼핑몰 주소를 올바르게 입력하세요.' });
    }

    // 같은 사이트에 유효한 키가 이미 있으면 알려준다.
    // 막지는 않는다 — 사장님용과 우리 확인용을 따로 두고 싶을 수 있다.
    const existing = await SiteKey.find({ origin, revoked: false }).lean();

    const doc = await SiteKey.create({
      key: generateKey(),
      origin,
      label,
      source: 'admin',
    });

    invalidateKeyCache();

    res.status(201).json({
      id:     doc._id,
      key:    doc.key,
      origin: doc.origin,
      label:  doc.label,
      created_at: doc.created_at,
      // 사장님께 바로 전달할 수 있는 완성된 주소
      dashboard_url: `/operator-dashboard.html?key=${encodeURIComponent(doc.key)}`,
      warning: existing.length
        ? `이 사이트에는 이미 유효한 키가 ${existing.length}개 있습니다.`
        : undefined,
    });
  } catch (err) {
    console.error('[admin/keys] 발급 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── DELETE /api/admin/keys/:id — 폐기 ─────────────────────────
// 실제로 지우지 않고 revoked 표시만 한다. 발급 이력을 남기기 위함이다.
router.delete('/:id', async (req, res) => {
  try {
    const doc = await SiteKey.findByIdAndUpdate(
      req.params.id,
      { $set: { revoked: true, revoked_at: new Date() } },
      { new: true },
    );

    if (!doc) return res.status(404).json({ error: '키를 찾을 수 없습니다.' });

    invalidateKeyCache(doc.key);
    res.json({ ok: true, id: doc._id, origin: doc.origin });
  } catch (err) {
    console.error('[admin/keys] 폐기 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ── POST /api/admin/keys/:id/restore — 폐기 취소 ──────────────
router.post('/:id/restore', async (req, res) => {
  try {
    const doc = await SiteKey.findByIdAndUpdate(
      req.params.id,
      { $set: { revoked: false }, $unset: { revoked_at: 1 } },
      { new: true },
    );

    if (!doc) return res.status(404).json({ error: '키를 찾을 수 없습니다.' });

    invalidateKeyCache(doc.key);
    res.json({ ok: true, id: doc._id, key: doc.key, origin: doc.origin });
  } catch (err) {
    console.error('[admin/keys] 복구 오류:', err.message);
    res.status(500).json({ error: '서버 오류' });
  }
});

module.exports = router;
