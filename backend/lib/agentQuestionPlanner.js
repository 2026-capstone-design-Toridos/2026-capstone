const { kstDateString } = require('./reportMetrics');

const DAY_MS = 24 * 60 * 60 * 1000;
const CHANNEL_PATTERNS = [
  ['Instagram', /인스타그램|인스타|instagram|\big\b/i],
  ['Facebook', /페이스북|facebook|\bfb\b/i],
  ['Naver', /네이버|naver/i],
  ['Google', /구글|google/i],
  ['Kakao', /카카오|kakao/i],
  ['TikTok', /틱톡|tiktok/i],
  ['YouTube', /유튜브|youtube/i],
  ['직접 방문', /직접\s*방문|direct/i],
];

function validationError(message) {
  const error = new Error(message);
  error.name = 'AgentValidationError';
  return error;
}

function shiftDate(dateString, days) {
  const value = new Date(`${dateString}T00:00:00+09:00`);
  return kstDateString(new Date(value.getTime() + days * DAY_MS));
}

function daysPeriod(days = 7, now = new Date()) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 31);
  const endDate = kstDateString(now);
  return { startDate: shiftDate(endDate, -(safeDays - 1)), endDate, days: safeDays, explicit: false };
}

function validDate(year, month, day) {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${text}T00:00:00+09:00`);
  return !Number.isNaN(parsed.getTime()) && kstDateString(parsed) === text ? text : null;
}

function explicitPeriod(question, now = new Date()) {
  const tokens = [...String(question).matchAll(/(?:(20\d{2})[./-])?(\d{1,2})[./-](\d{1,2})/g)];
  if (tokens.length < 2) return null;
  const currentYear = Number(kstDateString(now).slice(0, 4));
  const first = validDate(Number(tokens[0][1] || currentYear), Number(tokens[0][2]), Number(tokens[0][3]));
  const secondYear = Number(tokens[1][1] || tokens[0][1] || currentYear);
  const second = validDate(secondYear, Number(tokens[1][2]), Number(tokens[1][3]));
  if (!first || !second) throw validationError('질문에 입력한 날짜가 올바르지 않습니다. YYYY-MM-DD 형식으로 확인해주세요.');
  if (first > second) throw validationError('분석 시작일은 종료일보다 늦을 수 없습니다.');
  const span = Math.round((new Date(`${second}T00:00:00+09:00`) - new Date(`${first}T00:00:00+09:00`)) / DAY_MS) + 1;
  if (span > 93) throw validationError('운영 제안 Agent는 한 번에 최대 93일까지 분석할 수 있습니다.');
  return { startDate: first, endDate: second, days: span, explicit: true };
}

function collectionPeriod(question, now = new Date()) {
  const text = String(question || '');
  const fromStart = /수집\s*(?:시작|처음)|처음\s*수집|데이터\s*(?:수집\s*)?시작/.test(text);
  if (!fromStart) return null;
  const today = kstDateString(now);
  const throughYesterday = /어제\s*까지/.test(text);
  return {
    startDate: null,
    endDate: throughYesterday ? shiftDate(today, -1) : today,
    days: null,
    explicit: true,
    mode: throughYesterday ? 'collection_start_to_yesterday' : 'collection_start_to_today',
  };
}

function detectedChannel(question) {
  return CHANNEL_PATTERNS.find(([, pattern]) => pattern.test(question))?.[0] || null;
}

function detectedCampaign(question) {
  const match = String(question).match(/(?:utm[_\s-]*campaign|캠페인(?:명)?)\s*(?:은|는|:|=)?\s*["']?([A-Za-z0-9._-]{2,80})["']?/i);
  const value = match?.[1] || '';
  return /^(유입|분석|성과|고객)$/i.test(value) ? null : value || null;
}

function responseMode(question) {
  const text = String(question || '');
  if (/캡처|스크린샷|화면\s*(?:위치|구역|영역).*보여|이탈.*화면.*보여/.test(text)) return 'visual_diagnosis';
  if (/실행\s*(?:순서|계획)|이번\s*주.*(?:순서|계획)|우선순위.*정리|순서로\s*정리/.test(text)) return 'execution_plan';
  if (/지난\s*(?:동일\s*)?기간|이전\s*기간|전주|비교/.test(text)) return 'period_comparison';
  return 'diagnosis';
}

function planQuestion(question, { days = 7, now = new Date(), previousPlan = null } = {}) {
  const text = String(question || '').trim();
  if (!text) throw validationError('질문이 비어 있습니다.');
  const period = collectionPeriod(text, now) || explicitPeriod(text, now) || daysPeriod(days, now);
  const channel = detectedChannel(text);
  const campaign = detectedCampaign(text);
  const targets = new Set();
  const requiredTools = new Set();

  const add = (target, ...tools) => {
    targets.add(target);
    tools.forEach((tool) => requiredTools.add(tool));
  };
  if (/구매\s*여정|퍼널|단계|장바구니|결제|전환/.test(text)) add('funnel', 'get_funnel_overview');
  if (/유입|채널|경로|인스타|instagram|네이버|naver|구글|google|카카오|facebook|페이스북/.test(text)) add('channel', 'get_channel_performance');
  if (/캠페인|utm/i.test(text)) add('campaign', 'get_campaign_performance');
  if (/상품|제품|카테고리|찜|리뷰/.test(text)) add('product', 'get_product_opportunities');
  if (/고객\s*유형|클러스터|페르소나|유형별/.test(text)) add('customer_type', 'get_customer_type_insights');
  if (/이전\s*(?:제안|조치)|지난\s*(?:제안|조치)|효과|개선됐|성과\s*검증/.test(text)) add('previous_action', 'get_previous_action_outcomes');
  if (/이탈|멈추|중지|떠나|종료\s*화면|막히/.test(text)) add('exit', 'get_exit_signals');
  if (/캡처|스크린샷|화면\s*(?:위치|구역|영역)|어디서\s*(?:이탈|멈추)|이탈\s*(?:위치|구역|영역)/.test(text)) {
    add('visual_exit', 'get_visual_exit_hotspots', 'get_exit_signals');
  }
  if (/요일|시간대|몇\s*시|방문\s*시간/.test(text)) add('time', 'get_visit_time_patterns');
  if (/고객(?:들)?의?\s*행동.*분석|행동을?\s*분석/.test(text)) {
    add('behavior_overview', 'get_period_overview', 'get_funnel_overview', 'get_channel_performance', 'get_exit_signals', 'get_visit_time_patterns');
  }
  if (/먼저|우선|요약|전체|운영\s*조치|추천|이번\s*주/.test(text) || requiredTools.size === 0) {
    add('overview', 'get_period_overview');
  }
  // 종합 제안은 한 지표만 보고 만들지 않는다.
  if (/먼저|우선|운영\s*조치|추천/.test(text)) {
    requiredTools.add('get_funnel_overview');
    requiredTools.add('get_exit_signals');
    requiredTools.add('get_previous_action_outcomes');
  }
  if (channel && !requiredTools.has('get_channel_performance')) requiredTools.add('get_channel_performance');
  if (campaign) requiredTools.add('get_campaign_performance');

  // “이 화면”, “이 구간”, “그 제안”처럼 직전 답변을 가리키는 후속 질문은
  // 새 질문만 보고 일반 개요 Tool로 떨어뜨리지 않고 직전 분석 대상을 이어받는다.
  const contextualFollowUp = /(?:^|\s)(?:이|그|해당|방금|앞서|위의?)\s*(?:화면|구간|단계|제안|내용|결과|부분)|이어서|바로\s*바꿀/.test(text);
  if (contextualFollowUp && previousPlan) {
    const inheritedTools = Array.isArray(previousPlan.required_tools) ? previousPlan.required_tools : [];
    const inheritedTargets = Array.isArray(previousPlan.targets) ? previousPlan.targets : [];
    inheritedTools.forEach((tool) => requiredTools.add(tool));
    inheritedTargets.forEach((target) => targets.add(target));
  }

  return {
    response_mode: responseMode(text),
    period,
    filters: {
      channel: channel || (contextualFollowUp ? previousPlan?.filters?.channel || null : null),
      campaign: campaign || (contextualFollowUp ? previousPlan?.filters?.campaign || null : null),
    },
    targets: [...targets],
    required_tools: [...requiredTools],
    refresh_snapshot: /최신\s*데이터|새로\s*분석|다시\s*분석|효과/.test(text),
    context_inherited: Boolean(contextualFollowUp && previousPlan),
  };
}

module.exports = { planQuestion, daysPeriod, explicitPeriod, collectionPeriod, detectedChannel, responseMode, shiftDate };
