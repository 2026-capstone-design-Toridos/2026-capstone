/**
 * SiteKey.js — 사이트 접근 키
 *
 * 역할: "이 키를 가진 사람은 이 쇼핑몰 데이터를 볼 수 있다"는 대응 관계를 저장한다.
 *
 * ── 왜 DB로 옮겼나 ──────────────────────────────────────────────
 *  예전에는 SITE_KEYS 환경변수에 "키:주소,키:주소" 형태로 넣었다.
 *  사장님이 한 분 늘 때마다
 *    1. 터미널에서 랜덤 문자열 생성
 *    2. 서버 환경변수 편집
 *    3. 서버 재시작
 *  세 단계를 밟아야 했다. 실수하기 쉽고, 서버 접근 권한이 있는 사람만 가능했다.
 *
 *  이제는 관리 화면에서 발급하면 바로 쓸 수 있다.
 *  환경변수는 ADMIN_KEY 하나만 남는다.
 *
 * ── 키를 평문으로 저장하는 이유 ─────────────────────────────────
 *  보안 정석은 해시 저장이다. 다만 이 DB에는 이미 수집한 행동 데이터가
 *  전부 들어 있어서, 키만 해시해도 실질적인 방어력 차이가 크지 않다.
 *  반면 평문이면 사장님이 키를 잃어버렸을 때 목록에서 다시 알려드릴 수 있다.
 *  대신 폐기(revoke)를 쉽게 만들어 유출 시 즉시 차단할 수 있게 했다.
 * ───────────────────────────────────────────────────────────────
 */

const mongoose = require('mongoose');

const SiteKeySchema = new mongoose.Schema(
  {
    // 발급된 접근 키. 대시보드가 ?key= 또는 X-GT-Key 헤더로 보낸다.
    key: { type: String, required: true, unique: true, index: true },

    // 이 키로 볼 수 있는 쇼핑몰. normalizeOrigin을 거친 값이 들어온다.
    origin: { type: String, required: true, index: true },

    // 운영자가 알아보기 위한 이름 (예: "Digno Lucir", "수연 테스트몰")
    label: { type: String, default: '' },

    // 폐기 여부. 실제로 지우지 않고 표시만 해서 발급 이력을 남긴다.
    revoked:    { type: Boolean, default: false, index: true },
    revoked_at: { type: Date },

    // 마지막으로 이 키가 쓰인 시각 — 안 쓰는 키를 정리할 때 참고한다.
    // 매 요청마다 쓰면 부하가 크므로 일정 간격으로만 갱신한다.
    last_used_at: { type: Date },

    // env(SITE_KEYS)에서 자동 이관된 키인지 구분
    source: { type: String, default: 'admin' },   // admin | env
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
  }
);

// 한 사이트에 여러 키를 발급할 수 있다(사장님용/우리용 분리 등).
// 유효한 키를 빠르게 찾기 위한 인덱스.
SiteKeySchema.index({ origin: 1, revoked: 1 });

module.exports = mongoose.model('SiteKey', SiteKeySchema);
