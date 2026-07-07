/**
 * test-sdk.js — 로컬 개발용 SDK 진입점
 *
 * 역할: Vite 개발 서버에서 A/B/C 모듈을 직접 연결하고,
 *      emit 로그를 콘솔에 보여줘 수집 이벤트를 빠르게 확인한다.
 */

import './sdk-A.js';
import './sdk-B.js';
import './sdk-C.js';
import { initA, emit } from './sdk-A.js';
import { initB } from './sdk-B.js';
import { initC } from './sdk-C.js';

(function () {
  // DOM 준비 후 SDK를 시작한다 — index.js와 달리 debugEmit으로 이벤트를 콘솔에 남긴다
  function start() {
    initA();

    const originalEmit = emit;
    function debugEmit(type, data) {
      console.log("🔥 [GhostTracker]", type, data);
      originalEmit(type, data);
    }

    initB(debugEmit);
    initC(debugEmit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
