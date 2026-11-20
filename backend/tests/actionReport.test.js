// 운영 액션 리포트 (대시보드 > 방문 분석) 규칙 확인
// 실행: node --test backend/tests/actionReport.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClusterActionReport,
  buildSessionActionReport,
  playbookFor,
  readableFlow,
} = require('../lib/actionReport');

const CURRENT_TYPES = {
  '리뷰 관련 신호 중심 고객': 'review',
  '상품·가격 확인 중심 고객': 'price',
  '다양한 상호작용·구매 시도 고객': 'interaction',
  '상품·카테고리 반복 탐색 고객': 'browse',
  '짧은 방문·행동 정보 부족형': 'insufficient',
};

test('분류 서버의 다섯 유형마다 전용 할 일이 있다', () => {
  for (const [name, key] of Object.entries(CURRENT_TYPES)) {
    assert.equal(playbookFor(name).key, key, name);
  }
});

test('내부 이벤트 이름이 영어로 새지 않는다', () => {
  const flow = readableFlow(['session_start', 'enter_category', 'hover_dwell', 'session_end']);
  assert.deepEqual(flow, ['쇼핑몰 방문', '카테고리 진입', '탐색 종료']);
  const report = buildSessionActionReport({
    persona: '짧은 방문·행동 정보 부족형',
    events: [{ event_type: 'session_start' }, { event_type: 'enter_category' }, { event_type: 'session_end' }],
    profile: { top_actions: [{ action: 'START_SESSION' }, { action: 'EXIT_BOUNCE' }, { action: 'VIEW_PRODUCT' }] },
  });
  assert.doesNotMatch(report.text, /session start|exit bounce|view product|enter category/i);
  assert.match(report.text, /바로 나감/);
});

test('일부러 서버 안에서 만든 리포트에 "서버 혼잡" 문구를 붙이지 않는다', () => {
  const report = buildClusterActionReport({ clusterId: '4', typeName: '짧은 방문·행동 정보 부족형', profile: { count: 10 } });
  assert.doesNotMatch(report.text, /혼잡/);
});

test('유형 리포트는 근거·할 일·확인 지표를 함께 준다', () => {
  const report = buildClusterActionReport({
    clusterId: '0',
    typeName: '리뷰 관련 신호 중심 고객',
    profile: { count: 97, top_actions: [{ action: 'VIEW_REVIEW' }, { action: 'REVIEW_EXPLORATION_EPISODE' }], page_dist: { PRODUCT: 80, HOME: 20 } },
    totalSessions: 400,
  });
  assert.ok(report.evidence.some((e) => e.includes('97건') && e.includes('24%')));
  assert.ok(report.evidence.some((e) => e.includes('리뷰 확인')));
  assert.ok(report.actions.length >= 2);
  for (const action of report.actions) {
    assert.ok(action.title && action.how && action.metric);
  }
});

test('구매 완료 고객은 완료 흐름 기준 할 일을 받는다', () => {
  const report = buildSessionActionReport({ persona: '상품·가격 확인 중심 고객', completed: true, events: [] });
  assert.equal(report.playbook, 'completed');
});

test('이 쇼핑몰의 분류 통계가 없으면 다른 모델의 통계를 근거로 쓰지 않는다', () => {
  const report = buildClusterActionReport({
    clusterId: '4',
    typeName: '짧은 방문·행동 정보 부족형',
    profile: {},
    statsAvailable: false,
  });
  assert.doesNotMatch(report.text, /리뷰 확인/);
  assert.ok(report.evidence.some((e) => e.includes('집계가 아직 없어')));
});
