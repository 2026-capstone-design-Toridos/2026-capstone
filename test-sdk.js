import './sdk-A.js';
import './sdk-B.js';
import './sdk-C.js';
import { initA, emit } from './sdk-A.js';
import { initB } from './sdk-B.js';
import { initC } from './sdk-C.js';

(function () {
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