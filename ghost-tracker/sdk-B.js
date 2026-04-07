/**
 * sdk-B.js  —  B 담당 (수연)
 *
 * 역할: 클릭/마우스/탭/폼/미디어 Raw 이벤트 수집 → emit()으로 전달
 *
 * 이 파일만 수정할 것. core/ 파일은 건드리지 않는다.
 *
 * emit() 사용법:
 *   emit('click', { target: 'button_buy', x: 120, y: 300 })
 *   emit('tab_exit', { section_id: 'review' })
 */

import { emit } from './sdk-A.js';

export function initB() {
  // TODO (수연): 이 함수 안에 이벤트 리스너 등록
  // 예시:
  // document.addEventListener('click', (e) => {
  //   emit('click', {
  //     target: e.target.id || e.target.dataset.trackId || e.target.tagName,
  //     x: e.clientX,
  //     y: e.clientY,
  //   });
  // });
}
