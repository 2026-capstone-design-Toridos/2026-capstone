/**
 * index.js  —  GhostTracker SDK 진입점
 *
 * 사용법 (자사몰 <head>에 한 줄 삽입):
 *   <script type="module" src="https://cdn.example.com/ghost-tracker/index.js"></script>
 *
 * 또는 번들러 환경:
 *   import 'ghost-tracker';
 *
 * 이 파일은 합치기만 한다. 직접 로직을 추가하지 않는다.
 */

import { initA } from './sdk-A.js';
import { initB } from './sdk-B.js';
import { initC } from './sdk-C.js';

// DOM 준비 후 초기화 (defer/async 속성 없이 삽입된 경우 대비)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

function _init() {
  initA(); // Core Engine 먼저 (session_id, emit 준비)
  initB(); // Input layer
  initC(); // Tracking layer
}
