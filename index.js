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
 *  sdk-C: initC(emit)  — C는 ES 모듈. handleRawEvent 파라미터 주입 방식.
 *                        subsection enter/exit → window.__GT 브릿지 통해 A와 통신.
 * ────────────────────────────────────────────────────────────────
 */

import { initA, emit } from './sdk-A.js';
import { initB }       from './sdk-B.js';
import { initC }       from './sdk-C.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

function _init() {
  initA();        // 1. Core Engine 먼저 (session_id, emit, window.__GT 준비)
  initB(emit);    // 2. B: handleRawEvent로 emit 주입
  initC(emit);    // 3. C: handleRawEvent로 emit 주입
}
