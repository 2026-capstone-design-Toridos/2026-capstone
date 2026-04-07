/**
 * sdk-C.js  —  C 담당 (다민)
 *
 * 역할: 스크롤/섹션/이커머스 Raw 이벤트 수집 → emit()으로 전달
 *
 * 이 파일만 수정할 것. core/ 파일은 건드리지 않는다.
 *
 * emit() 사용법:
 *   emit('section_enter', { section_id: 'review' })
 *   emit('add_to_cart', { product_id: 'SKU-001' })
 *   emit('scroll_milestone', { milestone: 50, scrollY: 800 })
 *
 * cart_abandon_flag 자동 처리:
 *   add_to_cart → remove_from_cart or purchase_click 없이 session_end 시
 *   eventProcessor가 자동으로 cart_abandon 파생 이벤트 생성함
 *   → 별도 처리 불필요
 */

import { emit } from './sdk-A.js';

export function initC() {
  // TODO (다민): 이 함수 안에 이벤트 리스너 등록
}
