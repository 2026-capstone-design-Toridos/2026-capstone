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

test('동일 기간 비교 질문은 일반 진단이 아니라 기간 비교 모드로 구분한다', () => {
  const plan = planQuestion('지난 동일 기간과 비교해줘', { days: 7, now: NOW });
  assert.equal(plan.response_mode, 'period_comparison');
  assert.ok(plan.required_tools.includes('get_period_overview'));
});

test('화면 캡처 Python은 운영 전용 3.11 설정을 우선한다', () => {
  const old = process.env.AGENT_CAPTURE_PYTHON_BIN;
  process.env.AGENT_CAPTURE_PYTHON_BIN = '/tmp/python3.11';
  assert.equal(capturePython(), '/tmp/python3.11');
  if (old === undefined) delete process.env.AGENT_CAPTURE_PYTHON_BIN;
  else process.env.AGENT_CAPTURE_PYTHON_BIN = old;
});

// ── 에이전트 피드백 반영 (질문 분류·표본 가드·채널 비교) ───────────────
const {
  focusSessions, weakestChannel, channelComparisonAnswer, insufficientAnswer, verifiedKpis, geminiWithRetry, MIN_SAMPLE,
} = require('../services/opsAgentService');

const channelRows = [
  { name: 'Instagram', sessions: 120, product_sessions: 24, cart_sessions: 3, orders: 1, product_reach_rate: 20, cart_rate: 2.5, order_rate: 0.8 },
  { name: 'Naver', sessions: 80, product_sessions: 40, cart_sessions: 6, orders: 2, product_reach_rate: 50, cart_rate: 7.5, order_rate: 2.5 },
  { name: 'Kakao', sessions: 5, product_sessions: 0, cart_sessions: 0, orders: 0, product_reach_rate: 0, cart_rate: 0, order_rate: 0 },
];

test('채널 두 개를 비교하면 기간 비교가 아니라 채널 비교로 분류한다', () => {
  const plan = planQuestion('인스타랑 네이버 비교해줘', { days: 7, now: NOW });
  assert.equal(plan.response_mode, 'channel_comparison');
  assert.deepEqual(plan.filters.channels, ['Instagram', 'Naver']);
  assert.equal(plan.filters.channel, null);
  assert.ok(plan.required_tools.includes('get_channel_performance'));
});

test('"비교"만 있고 시간 표현이 없으면 기간 비교로 보내지 않는다', () => {
  const plan = planQuestion('상품 비교해줘', { days: 7, now: NOW });
  assert.notEqual(plan.response_mode, 'period_comparison');
});

test('지난주 단독 질문은 직전 월~일 주간을 분석 기간으로 잡는다', () => {
  const plan = planQuestion('지난주 매출 어때?', { days: 7, now: NOW });
  assert.equal(plan.period.startDate, '2026-11-09');
  assert.equal(plan.period.endDate, '2026-11-15');
  assert.ok(plan.required_tools.includes('get_period_overview'));
  assert.ok(plan.required_tools.includes('get_funnel_overview'));
});

test('지난주와 비교하는 질문은 기간 비교 모드다', () => {
  const plan = planQuestion('지난주랑 비교해서 주문 줄었어?', { days: 7, now: NOW });
  assert.equal(plan.response_mode, 'period_comparison');
});

test('광고·이유 질문은 채널/캠페인과 이탈/퍼널 도구를 고른다', () => {
  const ad = planQuestion('광고 효과 있어?', { days: 7, now: NOW });
  assert.ok(ad.required_tools.includes('get_channel_performance'));
  assert.ok(ad.required_tools.includes('get_campaign_performance'));
  const why = planQuestion('왜 다들 상품만 보고 나가?', { days: 7, now: NOW });
  assert.ok(why.required_tools.includes('get_exit_signals'));
  assert.ok(why.required_tools.includes('get_funnel_overview'));
});

test('채널 질문의 표본 수는 사이트 전체가 아니라 그 채널 세션이다', () => {
  const plan = planQuestion('카카오 유입 분석', { days: 7, now: NOW });
  const tools = {
    get_period_overview: { sessions: { current: 900 } },
    get_channel_performance: { channels: [channelRows[2]] },
  };
  assert.equal(focusSessions(plan, tools), 5);
  assert.ok(focusSessions(plan, tools) < MIN_SAMPLE);
  const answer = insufficientAnswer(plan, 5, []);
  assert.deepEqual(answer.actions, []);
  assert.deepEqual(answer.kpis, []);
  assert.match(answer.summary, /Kakao 유입 세션이 5건/);
});

test('채널 조언은 표본이 충분한 채널 중 상품 조회율이 가장 낮은 곳을 짚는다', () => {
  const weak = weakestChannel({ get_channel_performance: { channels: channelRows } });
  assert.equal(weak.name, 'Instagram');
});

test('채널 비교 답변은 채널별 수치와 가장 약한 채널 KPI를 만든다', () => {
  const plan = planQuestion('인스타랑 네이버 비교해줘', { days: 7, now: NOW });
  const result = channelComparisonAnswer(plan, { get_channel_performance: { channels: channelRows.slice(0, 2), missing: [] } });
  assert.match(result.summary, /Naver\(50%\)/);
  assert.match(result.summary, /Instagram은 20%/);
  assert.equal(result.observations.length, 2);
  assert.match(result.kpis[0], /^Instagram 상품 조회율: 현재 20%/);
});

test('단일 채널 질문의 KPI는 사이트 전체 퍼널이 아니라 채널 지표다', () => {
  const plan = planQuestion('인스타그램 유입 분석', { days: 7, now: NOW });
  const kpis = verifiedKpis(plan, {
    get_channel_performance: { channels: [channelRows[0]] },
    get_funnel_overview: { transitions: [{ from: '방문', to: '상품 조회', stopped: 500, stop_rate: 70 }] },
  });
  assert.ok(kpis.every((row) => row.startsWith('Instagram')));
});

test('Gemini 429는 한 번 재시도하고, 400은 재시도하지 않는다', async () => {
  const fail = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  let calls = 0;
  const ok = await geminiWithRetry({}, 1000, {
    call: async () => { calls += 1; if (calls === 1) throw fail(429); return { ok: true }; },
    wait: async () => {},
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(geminiWithRetry({}, 1000, {
    call: async () => { calls += 1; throw fail(400); },
    wait: async () => {},
  }));
  assert.equal(calls, 1);
});

test('채널 저장값 별칭(fb·ig)도 같은 채널로 본다', () => {
  const { channelRawPattern } = require('../services/opsAgentTools');
  const { sessionHelpers } = require('../routes/logs');
  assert.equal(sessionHelpers.deriveSourceName({ channel: 'fb' }), 'Facebook');
  assert.ok(channelRawPattern('Facebook').test('fb'));
  assert.ok(channelRawPattern('Instagram').test('ig'));
  assert.ok(!channelRawPattern('Instagram').test('fb'));
  assert.ok(planQuestion('페이스북 유입 분석', { days: 7, now: NOW }).filters.channel === 'Facebook');
});

test('"광고 효과"는 이전 제안 비교가 아니라 채널 질문이고, "제안 효과"만 이전 제안 비교다', () => {
  const ad = planQuestion('광고 효과 있어?', { days: 7, now: NOW });
  assert.ok(!ad.targets.includes('previous_action'));
  assert.ok(ad.targets.includes('channel'));
  const prev = planQuestion('지난번 제안 효과 있었어?', { days: 7, now: NOW });
  assert.ok(prev.targets.includes('previous_action'));
});

test('채널 전체 질문의 KPI 첫 줄은 가장 약한 채널 지표다', () => {
  const plan = planQuestion('광고 효과 있어?', { days: 7, now: NOW });
  const kpis = verifiedKpis(plan, {
    get_channel_performance: { channels: channelRows },
    get_funnel_overview: { transitions: [{ from: '방문', to: '상품 조회', stopped: 318, stop_rate: 71.6 }] },
  });
  assert.match(kpis[0], /^Instagram 상품 조회율/);
});
