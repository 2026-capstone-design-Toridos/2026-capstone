#!/usr/bin/env node
/**
 * issue-key.js — 접근 키를 명령줄에서 발급·조회·폐기한다
 *
 * 서버를 띄우지 않고 DB에 직접 붙어서 처리한다.
 * 관리 화면(/admin-keys.html)을 쓸 수 없는 상황을 위한 도구다.
 *   - 서버에 ADMIN_KEY를 아직 못 넣었을 때
 *   - 배포 전에 키를 미리 만들어두고 싶을 때
 *
 * ADMIN_KEY가 필요 없는 이유:
 *   이 스크립트는 MONGODB_URI를 아는 사람만 실행할 수 있다.
 *   DB 접속 정보를 가진 사람은 어차피 DB를 직접 고칠 수 있으므로,
 *   여기에 별도 인증을 두는 것은 의미가 없다.
 *   (반면 웹 관리 화면은 인터넷에 열려 있어 ADMIN_KEY가 필수다)
 *
 * ── 사용법 ──────────────────────────────────────────────────────
 *   cd backend
 *
 *   발급   node scripts/issue-key.js issue hshh2020.cafe24.com "Digno Lucir"
 *   목록   node scripts/issue-key.js list
 *   폐기   node scripts/issue-key.js revoke <키>
 * ───────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto   = require('crypto');
const mongoose = require('mongoose');
const SiteKey  = require('../models/SiteKey');

// 발급된 키로 접속할 대시보드 주소. 서버가 바뀌면 --base 로 넘기면 된다.
const DEFAULT_BASE = process.env.DASHBOARD_BASE_URL || 'https://capstone-toridos.duckdns.org';

function generateKey() {
  return crypto.randomBytes(18).toString('base64url');
}

/** 입력한 주소를 저장 형태로 정리 (adminKeys.js와 같은 규칙) */
function cleanOrigin(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const url  = new URL(value);
    const host = url.host.replace(/^m\./i, '');   // 모바일 도메인 통합
    return `${url.protocol}//${host}`.toLowerCase().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const fmt = (d) => (d ? new Date(d).toLocaleString('ko-KR') : '—');

async function cmdIssue(rawOrigin, label, base) {
  const origin = cleanOrigin(rawOrigin);
  if (!origin) {
    console.error('쇼핑몰 주소를 올바르게 입력하세요.  예) hshh2020.cafe24.com');
    process.exit(1);
  }

  const existing = await SiteKey.find({ origin, revoked: false }).lean();

  const doc = await SiteKey.create({
    key: generateKey(),
    origin,
    label: String(label || '').trim().slice(0, 80),
    source: 'admin',
  });

  console.log('\n발급 완료\n');
  console.log(`  쇼핑몰   ${doc.origin}`);
  if (doc.label) console.log(`  이름     ${doc.label}`);
  console.log(`  키       ${doc.key}`);
  console.log('\n사장님께 보낼 주소');
  console.log(`  ${base}/operator-dashboard.html?key=${doc.key}\n`);

  if (existing.length) {
    console.log(`  참고: 이 사이트에는 이미 유효한 키가 ${existing.length}개 있습니다.\n`);
  }
}

async function cmdList() {
  const keys = await SiteKey.find({}).sort({ created_at: -1 }).lean();

  if (!keys.length) {
    console.log('\n발급된 키가 없습니다.\n');
    return;
  }

  console.log(`\n총 ${keys.length}개\n`);
  for (const k of keys) {
    const state = k.revoked ? '[폐기]' : '     ';
    console.log(`${state} ${k.origin.replace(/^https?:\/\//, '')}`);
    console.log(`        키          ${k.key}`);
    if (k.label) console.log(`        이름        ${k.label}`);
    console.log(`        발급        ${fmt(k.created_at)}`);
    console.log(`        마지막 사용 ${fmt(k.last_used_at)}`);
    console.log();
  }
}

async function cmdRevoke(key) {
  if (!key) {
    console.error('폐기할 키를 입력하세요.');
    process.exit(1);
  }

  const doc = await SiteKey.findOneAndUpdate(
    { key },
    { $set: { revoked: true, revoked_at: new Date() } },
    { new: true },
  );

  if (!doc) {
    console.error('해당 키를 찾을 수 없습니다.');
    process.exit(1);
  }

  console.log(`\n폐기 완료 — ${doc.origin}\n`);
  console.log('  서버 캐시 때문에 최대 1분간 계속 동작할 수 있습니다.\n');
}

(async () => {
  const [, , cmd, ...rest] = process.argv;

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI가 없습니다. backend/.env를 확인하세요.');
    process.exit(1);
  }

  // --base 옵션으로 대시보드 주소를 바꿀 수 있다
  let base = DEFAULT_BASE;
  const baseIdx = rest.indexOf('--base');
  if (baseIdx !== -1) {
    base = (rest[baseIdx + 1] || '').replace(/\/+$/, '') || DEFAULT_BASE;
    rest.splice(baseIdx, 2);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
  } catch (err) {
    console.error('DB 연결 실패:', err.message);
    process.exit(1);
  }

  try {
    switch (cmd) {
      case 'issue':  await cmdIssue(rest[0], rest[1], base); break;
      case 'list':   await cmdList();                        break;
      case 'revoke': await cmdRevoke(rest[0]);               break;
      default:
        console.log(`
사용법
  node scripts/issue-key.js issue <쇼핑몰주소> [이름]   키 발급
  node scripts/issue-key.js list                        목록
  node scripts/issue-key.js revoke <키>                 폐기

예시
  node scripts/issue-key.js issue hshh2020.cafe24.com "Digno Lucir"
  node scripts/issue-key.js issue shop.com --base https://내서버주소
`);
    }
  } finally {
    await mongoose.disconnect();
  }
})();
