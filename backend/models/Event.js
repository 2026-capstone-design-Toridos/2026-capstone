const mongoose = require('mongoose');

/**
 * SDK가 보내는 이벤트 스키마
 * _dispatch()가 만드는 공통 필드 + data 서브도큐먼트
 */
const EventSchema = new mongoose.Schema(
  {
    // ── 공통 필드 (sdk-A _dispatch 자동 부여) ─────────────────
    session_id:      { type: String, required: true, index: true },
    event_type:      { type: String, required: true, index: true },
    event_token:     { type: Number },
    event_seq:       { type: Number },
    inter_event_gap: { type: Number },
    timestamp:       { type: Number, index: true },  // epoch ms

    // ── 페이지 컨텍스트 ────────────────────────────────────────
    page_url:    { type: String },
    pathname:    { type: String },
    referrer:    { type: String },
    device_type: { type: String },  // desktop | mobile | tablet

    // ── UTM ───────────────────────────────────────────────────
    utm_source:   { type: String },
    utm_medium:   { type: String },
    utm_campaign: { type: String },

    // ── 이벤트별 페이로드 (sdk-B/C가 채우는 필드) ─────────────
    data: { type: mongoose.Schema.Types.Mixed },

    // ── 수신 메타 ─────────────────────────────────────────────
    received_at: { type: Date, default: Date.now, index: true },
    origin:      { type: String },  // 요청 출처 도메인
  },
  {
    versionKey: false,
  }
);

// 복합 인덱스: 세션별 이벤트 순서 조회
EventSchema.index({ session_id: 1, event_seq: 1 });
// 시간 범위 조회
EventSchema.index({ event_type: 1, received_at: -1 });

module.exports = mongoose.model('Event', EventSchema);
