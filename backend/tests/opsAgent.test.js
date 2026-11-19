const test = require('node:test');
const assert = require('node:assert/strict');

const { planQuestion } = require('../lib/agentQuestionPlanner');
const { agentProfile, decideAsOf } = require('../services/opsAgentService');
const { capturePython } = require('../services/visualHotspotService');

const NOW = new Date('2026-11-18T03:00:00Z');

test('질문의 날짜와 Instagram 채널을 서버 계획으로 구조화한다', () => {
  const plan = planQuestion('11/01~11/16까지 인스타그램 유입 고객들 분석해봐', { days: 7, now: NOW });
  assert.deepEqual(plan.period, {
    startDate: '2026-11-01', endDate: '2026-11-16', days: 16, explicit: true,
  });
  assert.equal(plan.filters.channel, 'Instagram');
  assert.deepEqual(plan.required_tools, ['get_channel_performance']);
});

test('구매 여정 질문은 퍼널 도구를 반드시 포함한다', () => {
  const plan = planQuestion('구매 여정에서 가장 많이 멈추는 단계는?', { days: 7, now: NOW });
  assert.ok(plan.required_tools.includes('get_funnel_overview'));
});

test('상품과 고객 유형 질문은 두 전용 도구를 함께 선택한다', () => {
  const plan = planQuestion('고객 유형별로 많이 본 상품을 분석해줘', { days: 7, now: NOW });
  assert.ok(plan.required_tools.includes('get_product_opportunities'));
  assert.ok(plan.required_tools.includes('get_customer_type_insights'));
});

test('잘못된 기간은 DB 조회 전에 거부한다', () => {
  assert.throws(
    () => planQuestion('2026-11-20~2026-11-01 분석', { days: 7, now: NOW }),
    (error) => error.name === 'AgentValidationError',
  );
});

test('같은 대화와 기간에서는 기존 기준시각을 재사용한다', () => {
  const plan = planQuestion('구매 여정 분석', { days: 7, now: NOW });
  const snapshot = {
    as_of: '2026-11-18T03:00:00.000Z',
    period: { startDate: plan.period.startDate, endDate: plan.period.endDate },
  };
  assert.equal(decideAsOf(snapshot, plan), snapshot.as_of);
});

test('쇼핑몰 대표 origin이 독립 Agent ID가 된다', () => {
  assert.equal(agentProfile('https://www.dignolucir.co.kr/').tenant_id, 'https://dignolucir.co.kr');
});

test('수집 시작부터 어제까지를 기본 7일이 아닌 수집 전체 기간 모드로 해석한다', () => {
  const plan = planQuestion('수집 시작부터 어제까지 고객들의 행동을 분석해봐', { days: 7, now: NOW });
  assert.equal(plan.period.mode, 'collection_start_to_yesterday');
  assert.equal(plan.period.startDate, null);
  assert.equal(plan.period.endDate, '2026-11-17');
  assert.ok(plan.required_tools.includes('get_period_overview'));
  assert.ok(plan.required_tools.includes('get_funnel_overview'));
  assert.ok(plan.required_tools.includes('get_channel_performance'));
  assert.ok(plan.required_tools.includes('get_exit_signals'));
  assert.ok(plan.required_tools.includes('get_visit_time_patterns'));
});

test('화면 캡처 질문은 시각 이탈 도구와 이탈 집계를 함께 선택한다', () => {
  const plan = planQuestion('이탈이 집중된 화면을 캡처해서 보여줘', { days: 7, now: NOW });
  assert.ok(plan.required_tools.includes('get_visual_exit_hotspots'));
  assert.ok(plan.required_tools.includes('get_exit_signals'));
});

test('후속 질문의 이 화면 표현은 직전 분석 대상과 Tool을 상속한다', () => {
  const previousPlan = planQuestion('구매 여정에서 가장 많이 멈추는 단계는?', { days: 7, now: NOW });
  const plan = planQuestion('이 화면에서 바로 바꿀 요소 3개를 알려줘', {
    days: 7,
    now: NOW,
    previousPlan,
  });
  assert.equal(plan.context_inherited, true);
  assert.ok(plan.targets.includes('funnel'));
  assert.ok(plan.required_tools.includes('get_funnel_overview'));
});

test('실행 순서 후속 질문은 이전 분석을 상속하되 실행 계획 모드로 구분한다', () => {
  const previousPlan = planQuestion('지금 가장 먼저 개선할 부분은?', { days: 7, now: NOW });
  const plan = planQuestion('이 제안을 이번 주 실행 순서로 정리해줘', { days: 7, now: NOW, previousPlan });
  assert.equal(plan.response_mode, 'execution_plan');
  assert.equal(plan.context_inherited, true);
  assert.ok(plan.required_tools.includes('get_funnel_overview'));
});

test('캡처 후속 질문은 시각 진단 모드로 구분한다', () => {
  const previousPlan = planQuestion('구매 여정에서 가장 많이 멈추는 단계는?', { days: 7, now: NOW });
  const plan = planQuestion('이 구간의 이탈 화면을 캡처해서 보여줘', { days: 7, now: NOW, previousPlan });
  assert.equal(plan.response_mode, 'visual_diagnosis');
  assert.ok(plan.required_tools.includes('get_visual_exit_hotspots'));
});

test('화면 캡처 Python은 운영 전용 3.11 설정을 우선한다', () => {
  const old = process.env.AGENT_CAPTURE_PYTHON_BIN;
  process.env.AGENT_CAPTURE_PYTHON_BIN = '/tmp/python3.11';
  assert.equal(capturePython(), '/tmp/python3.11');
  if (old === undefined) delete process.env.AGENT_CAPTURE_PYTHON_BIN;
  else process.env.AGENT_CAPTURE_PYTHON_BIN = old;
});
