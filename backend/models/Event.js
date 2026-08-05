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

    // ── Layer 0: 플랫폼 확정값 ─────────────────────────────────
    //
    // 쇼핑몰 솔루션이 표준 meta로 노출하는 값을 SDK가 그대로 실어 보낸다.
    // URL 정규식 추론과 달리 스킨이 바뀌어도 깨지지 않는다.
    //
    // 예: Cafe24 상품 상세
    //   <meta name="path_role" content="PRODUCT_DETAIL">
    //   <meta property="product:productId" content="45">
    //
    // 이 필드가 있으면 페이지 타입 추론(ml/semantic_event_mapper.py)이
    // URL을 볼 필요가 없다. 없으면(비-Cafe24) 기존 URL 추론으로 떨어진다.
    platform:      { type: String },  // cafe24 | ...
    page_type:     { type: String },  // HOME | PRODUCT | CART | CHECKOUT | ORDER_SUCCESS | ...
    platform_role: { type: String },  // 플랫폼 원본 값 (매핑 누락 추적용)

    // ── 유입 경로 (세션 최초 진입 시점 값으로 고정) ───────────
    //
    // SDK가 세션 시작 시 한 번 계산해 localStorage에 저장하고, 그 뒤 모든
    // 이벤트에 같은 값을 붙인다. 페이지를 넘어가도, PG 결제창에 다녀와도
    // 바뀌지 않는다.
    //
    // 예전에는 서버가 $first(received_at 순)로 추정했는데 배치 전송이라
    // 도착 순서가 뒤집히면 틀렸고, utm_medium은 스키마에만 있고 SDK가
    // 채우지 않아 항상 빈 값이었다.
    utm_source:   { type: String },
    utm_medium:   { type: String },
    utm_campaign: { type: String },
    utm_term:     { type: String },
    utm_content:  { type: String },

    referrer_host:  { type: String },  // referrer의 도메인 (자사·PG는 걸러진 뒤)
    channel:        { type: String },  // 최종 채널명 — 운영자 화면이 그대로 쓴다
    in_app_browser: { type: String },  // Instagram / KakaoTalk / Naver ...
    landing_page:   { type: String },  // 세션의 첫 진입 경로

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
