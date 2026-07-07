/**
 * Event.js — SDK 수집 이벤트 MongoDB 모델
 *
 * 역할: eventProcessor._dispatch()가 만든 공통 필드와
 *      sdk-B/C가 채운 이벤트별 data 페이로드를 MongoDB에 저장한다.
 */

const mongoose = require('mongoose');

// ── 이벤트 스키마 ─────────────────────────────────────────────
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

// 세션 타임라인 복원용 — event_seq 기준으로 사용자 행동 흐름을 조회한다
EventSchema.index({ session_id: 1, event_seq: 1 });

// 운영자 대시보드 집계용 — 이벤트 타입별 최근 구간 조회를 빠르게 한다
EventSchema.index({ event_type: 1, received_at: -1 });

module.exports = mongoose.model('Event', EventSchema);
