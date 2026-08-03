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
    //
    // event_id: SDK가 이벤트마다 발급하는 UUID. 재전송 중복 판정 키.
    //
    // (session_id, event_seq) 조합을 키로 쓸 수 없는 이유:
    //   Cafe24 같은 다중 페이지 쇼핑몰은 페이지 이동마다 전체 새로고침이 일어나
    //   SDK가 재초기화된다. 세션은 TTL 안에서 유지되지만 event_seq는 페이지마다
    //   1부터 다시 시작하므로, 같은 세션 안에서 (session_id, event_seq)가 중복된다.
    //   그 조합에 unique를 걸면 2번째 페이지 이후의 이벤트가 전부 거부된다.
    //
    // sparse: 예전 SDK가 보낸 event_id 없는 기존 문서들과 공존하기 위함.
    //         (null이 여러 개여도 인덱스 생성이 실패하지 않는다)
    event_id:        { type: String, unique: true, sparse: true },

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
