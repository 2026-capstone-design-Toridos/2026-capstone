/**
 * index.js  —  GhostTracker SDK 진입점
 *
 * 사용법 (자사몰 <head>에 한 줄 삽입):
 *   <script type="module" src="https://cdn.example.com/ghost-tracker/index.js"></script>
 *
 * 이 파일은 합치기만 한다. 직접 로직을 추가하지 않는다.
 *
 * ── 모듈 연결 구조 ──────────────────────────────────────────────
 *  sdk-A: initA()      — Core Engine. emit() 준비. window.__GT bridge 설정.
 *  sdk-B: initB(emit)  — B는 handleRawEvent 파라미터 주입 방식
 *  sdk-C: IIFE         — ES 모듈이 아니므로 import 불가.
 *                        window.__GT.subsectionEnter/Exit를 통해 A와 통신.
 *                        (다민: initC(handleRawEvent) 방식으로 리팩터링 예정 시 아래 주석 해제)
 * ────────────────────────────────────────────────────────────────
 */

import { initA, emit } from './sdk-A.js';
import { initB }       from './sdk-B.js';
// import { initC } from './sdk-C.js'; // C 리팩터링 후 연결 — 현재는 IIFE로 자동 실행됨

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

function _init() {
  initA();        // 1. Core Engine 먼저 (session_id, emit, window.__GT 준비)
  initB(emit);    // 2. B: handleRawEvent로 emit 주입
  // initC(emit); // 3. C 리팩터링 후 활성화
}
