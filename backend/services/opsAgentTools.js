const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Event = require('../models/Event');
const { originCondition, canonicalOrigin } = require('../middleware/siteAccess');
const { buildReportMetrics, kstDateString } = require('../lib/reportMetrics');
const { buildCommerceSummary } = require('../lib/commerceSummary');
const { sessionHelpers } = require('../routes/logs');
const { captureVisualHotspots } = require('./visualHotspotService');

const { buildSessionPipeline, deriveSourceName } = sessionHelpers;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50_000;

function percent(value, total) {
  return total ? Math.round((Number(value || 0) / Number(total)) * 1000) / 10 : 0;
}

function change(current, previous) {
  const a = Number(current || 0);
  const b = Number(previous || 0);
  return { current: a, previous: b, delta: a - b };
}

function evidence(id, statement, metric = {}) {
  return { id, statement, metric };
}

function range(plan, asOf) {
  const from = new Date(`${plan.period.startDate}T00:00:00+09:00`);
  const requestedTo = new Date(new Date(`${plan.period.endDate}T00:00:00+09:00`).getTime() + DAY_MS);
  const cutoff = new Date(asOf);
  const to = cutoff < requestedTo ? cutoff : requestedTo;
  return { from, to };
}

async function resolvePlanPeriod(origin, plan) {
  if (plan.period.startDate) return plan;
  if (!String(plan.period.mode || '').startsWith('collection_start_')) {
    throw new Error('분석 시작일을 확정하지 못했습니다.');
  }
  const requestedTo = new Date(new Date(`${plan.period.endDate}T00:00:00+09:00`).getTime() + DAY_MS);
  const first = await Event.findOne(
    { ...originCondition(origin), received_at: { $lt: requestedTo } },
    { received_at: 1 },
  ).sort({ received_at: 1 }).lean();
  if (!first?.received_at) {
    const error = new Error('해당 쇼핑몰에서 분석할 수집 데이터를 찾지 못했습니다.');
    error.name = 'AgentValidationError';
    throw error;
  }
  const startDate = kstDateString(new Date(first.received_at));
  const days = Math.round((new Date(`${plan.period.endDate}T00:00:00+09:00`) - new Date(`${startDate}T00:00:00+09:00`)) / DAY_MS) + 1;
  if (days < 1) {
    const error = new Error('수집 시작일이 요청한 종료일보다 늦어 분석할 데이터가 없습니다.');
    error.name = 'AgentValidationError';
    throw error;
  }
  return {
    ...plan,
    period: { ...plan.period, startDate, days, resolved_from_collection: true },
  };
}

function digest(metrics) {
  return {
    sessions: metrics.overview.sessions,
    product_sessions: metrics.overview.product_sessions,
    cart_sessions: metrics.overview.cart_sessions,
    checkout_sessions: metrics.overview.checkout_sessions,
    orders: metrics.overview.orders,
    risky_sessions: metrics.overview.risky_sessions,
    product_reach_rate: percent(metrics.overview.product_sessions, metrics.overview.sessions),
    cart_rate: percent(metrics.overview.cart_sessions, metrics.overview.sessions),
    order_rate: percent(metrics.overview.orders, metrics.overview.sessions),
  };
}

async function baseTools(origin, plan, asOf) {
  const metrics = await buildReportMetrics(origin, {
    startDate: plan.period.startDate,
    endDate: plan.period.endDate,
    asOf,
  });
  const sessions = metrics.overview.sessions || 0;
  const previous = metrics.prev_overview || {};
  const weekdayNames = ['월', '화', '수', '목', '금', '토', '일'];
  const weekday = metrics.weekday.map((count, index) => ({ day: weekdayNames[index], sessions: count }));
  const hourly = metrics.hourly.map((count, hour) => ({ hour, sessions: count }));
  const stages = metrics.funnel.map((row) => ({ ...row, reach_rate: percent(row.sessions, sessions) }));
  const transitions = stages.slice(0, -1).map((row, index) => {
    const next = stages[index + 1];
    const stopped = Math.max(row.sessions - next.sessions, 0);
    return { from: row.stage, to: next.stage, stopped, stop_rate: percent(stopped, row.sessions) };
  });
  const channels = metrics.channels.map((row) => ({
    ...row,
    product_reach_rate: percent(row.product_sessions, row.sessions),
    cart_rate: percent(row.cart_sessions, row.sessions),
    order_rate: percent(row.orders, row.sessions),
  }));
  const selectedChannels = plan.filters.channel
    ? channels.filter((row) => row.name.toLowerCase() === plan.filters.channel.toLowerCase())
    : channels;
  const topTransition = [...transitions].sort((a, b) => b.stopped - a.stopped)[0];
  const topExit = metrics.exit_pages[0];
  const topCause = metrics.exit_causes[0];
  const tools = {
    get_period_overview: {
      period: metrics.period,
      sessions: change(metrics.overview.sessions, previous.sessions),
      orders: change(metrics.overview.orders, previous.orders),
      risky_sessions: change(metrics.overview.risky_sessions, previous.risky_sessions),
      order_rate: percent(metrics.overview.orders, sessions),
      product_reach_rate: percent(metrics.overview.product_sessions, sessions),
      evidence: [
        evidence('overview.sessions', `분석 기간의 방문 세션은 ${sessions.toLocaleString('ko-KR')}건입니다.`, { value: sessions, unit: '세션' }),
        evidence('overview.orders', `주문 완료는 ${metrics.overview.orders.toLocaleString('ko-KR')}건, 방문 대비 주문 완료율은 ${percent(metrics.overview.orders, sessions)}%입니다.`, { value: metrics.overview.orders, rate: percent(metrics.overview.orders, sessions) }),
        evidence('overview.risky', `탐색 중지 신호 세션은 ${metrics.overview.risky_sessions.toLocaleString('ko-KR')}건이며 직전 동일 기간보다 ${change(metrics.overview.risky_sessions, previous.risky_sessions).delta.toLocaleString('ko-KR')}건 변했습니다.`, { value: metrics.overview.risky_sessions, delta: change(metrics.overview.risky_sessions, previous.risky_sessions).delta }),
      ],
      note: '방문 세션 기준이며 고유 고객 수가 아닙니다.',
    },
    get_funnel_overview: {
      period: metrics.period,
      stages,
      transitions,
      evidence: [
        ...stages.map((row) => evidence(`funnel.${row.stage}`, `${row.stage} 도달은 ${row.sessions.toLocaleString('ko-KR')}개 세션(${row.reach_rate}%)입니다.`, { stage: row.stage, value: row.sessions, rate: row.reach_rate })),
        ...(topTransition ? [evidence('funnel.top_stop', `가장 많은 세션이 멈춘 전환은 '${topTransition.from} → ${topTransition.to}'로 ${topTransition.stopped.toLocaleString('ko-KR')}건(${topTransition.stop_rate}%)입니다.`, topTransition)] : []),
      ],
      note: '단계별 수치는 누적 도달 세션입니다. 주문 완료 세션은 앞 단계에도 포함됩니다.',
    },
    get_channel_performance: {
      period: metrics.period,
      filter: plan.filters.channel,
      channels: selectedChannels,
      evidence: selectedChannels.slice(0, 7).map((row) => evidence(
        `channel.${row.name}`,
        `${row.name} 유입은 ${row.sessions.toLocaleString('ko-KR')}개 세션이며 상품 조회 ${row.product_sessions.toLocaleString('ko-KR')}건(${row.product_reach_rate}%), 장바구니 ${row.cart_sessions.toLocaleString('ko-KR')}건(${row.cart_rate}%), 주문 ${row.orders.toLocaleString('ko-KR')}건(${row.order_rate}%)입니다.`,
        row,
      )),
      note: selectedChannels.length ? '수집된 첫 유입 정보 기준입니다.' : '요청한 유입 채널에 해당하는 세션이 없습니다.',
    },
    get_exit_signals: {
      period: metrics.period,
      risky_sessions: metrics.overview.risky_sessions,
      exit_pages: metrics.exit_pages,
      exit_causes: metrics.exit_causes,
      evidence: [
        ...(topExit ? [evidence('exit.top_page', `탐색 중지 세션이 가장 많이 끝난 화면은 '${topExit.label}'로 ${topExit.sessions.toLocaleString('ko-KR')}건(${topExit.share}%)입니다.`, topExit)] : []),
        ...(topCause ? [evidence('exit.top_signal', `가장 많이 관찰된 종료 신호는 '${topCause.label}'로 ${topCause.sessions.toLocaleString('ko-KR')}건(${topCause.share}%)입니다.`, topCause)] : []),
      ],
      note: '종료 화면과 행동 신호는 원인의 증거가 아니라 점검 후보입니다.',
    },
    get_visit_time_patterns: {
      period: metrics.period,
      weekday,
      hourly,
      busiest_weekday: [...weekday].sort((a, b) => b.sessions - a.sessions)[0] || null,
      busiest_hour: [...hourly].sort((a, b) => b.sessions - a.sessions)[0] || null,
      evidence: [],
      note: 'Asia/Seoul 기준 세션 시작 시각입니다.',
    },
  };
  if (tools.get_visit_time_patterns.busiest_weekday) {
    const day = tools.get_visit_time_patterns.busiest_weekday;
    tools.get_visit_time_patterns.evidence.push(evidence('time.weekday', `방문이 가장 많은 요일은 ${day.day}요일로 ${day.sessions.toLocaleString('ko-KR')}개 세션입니다.`, day));
  }
  if (tools.get_visit_time_patterns.busiest_hour) {
    const hour = tools.get_visit_time_patterns.busiest_hour;
    tools.get_visit_time_patterns.evidence.push(evidence('time.hour', `방문이 가장 많은 시간대는 ${hour.hour}시대로 ${hour.sessions.toLocaleString('ko-KR')}개 세션입니다.`, hour));
  }
  return { metrics, tools, metric_digest: digest(metrics) };
}

async function sessionRows(origin, plan, asOf) {
  const { from, to } = range(plan, asOf);
  const filter = { ...originCondition(origin), received_at: { $gte: from, $lt: to } };
  return Event.aggregate(buildSessionPipeline(filter)).option({ maxTimeMS: 30_000, allowDiskUse: true });
}

async function campaignTool(origin, plan, asOf) {
  const sessions = await sessionRows(origin, plan, asOf);
  const map = new Map();
  for (const session of sessions) {
    const name = String(session.utm_campaign || '').trim() || '캠페인 미지정';
    if (plan.filters.campaign && name.toLowerCase() !== plan.filters.campaign.toLowerCase()) continue;
    if (plan.filters.channel && deriveSourceName(session).toLowerCase() !== plan.filters.channel.toLowerCase()) continue;
    const row = map.get(name) || { name, sessions: 0, orders: 0, risky_sessions: 0, channels: new Map() };
    row.sessions += 1;
    if (session.completed) row.orders += 1;
    if (session.risky && !session.completed) row.risky_sessions += 1;
    const channel = deriveSourceName(session);
    row.channels.set(channel, (row.channels.get(channel) || 0) + 1);
    map.set(name, row);
  }
  const campaigns = [...map.values()].map((row) => ({
    name: row.name,
    sessions: row.sessions,
    orders: row.orders,
    risky_sessions: row.risky_sessions,
    order_rate: percent(row.orders, row.sessions),
    top_channel: [...row.channels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '확인 불가',
  })).sort((a, b) => b.sessions - a.sessions).slice(0, 12);
  return {
    period: plan.period,
    filters: plan.filters,
    campaigns,
    evidence: campaigns.map((row) => evidence(`campaign.${row.name}`, `'${row.name}' 캠페인은 ${row.sessions.toLocaleString('ko-KR')}개 세션, 주문 ${row.orders.toLocaleString('ko-KR')}건(${row.order_rate}%)입니다.`, row)),
    note: 'utm_campaign이 수집되지 않은 세션은 캠페인 미지정으로 표시합니다.',
  };
}

async function productTool(origin, plan, asOf) {
  const { from, to } = range(plan, asOf);
  const filter = { ...originCondition(origin), received_at: { $gte: from, $lt: to } };
  if (plan.filters.channel) {
    // SDK가 첫 유입 채널을 세션의 모든 이벤트에 고정해서 붙이므로 세션 ID를
    // 먼저 전부 읽지 않고 인덱스 범위 안에서 채널을 바로 제한할 수 있다.
    filter.channel = plan.filters.channel;
  }
  const projection = {
    session_id: 1, event_type: 1, received_at: 1, timestamp: 1, pathname: 1, page_url: 1,
    page_type: 1, product_id: 1, product_price: 1, product_currency: 1, data: 1,
  };
  const events = await Event.find(filter, projection).sort({ received_at: 1 }).limit(MAX_EVENTS + 1).lean();
  const truncated = events.length > MAX_EVENTS;
  const summary = buildCommerceSummary(events.slice(0, MAX_EVENTS));
  const products = summary.products.slice(0, 8);
  return {
    period: plan.period,
    filter: plan.filters.channel,
    counts: summary.counts,
    products,
    truncated,
    evidence: [
      evidence('product.actions', `상품 클릭 ${summary.counts.product_clicks.toLocaleString('ko-KR')}회, 장바구니 담기 ${summary.counts.add_to_cart.toLocaleString('ko-KR')}회, 주문 완료 ${summary.counts.order_completions.toLocaleString('ko-KR')}회가 관찰됐습니다.`, summary.counts),
      ...products.slice(0, 3).map((row) => evidence(`product.${row.product_id || row.name}`, `'${row.name}'은 상품 상세 확인 ${row.detail_views.toLocaleString('ko-KR')}회, 상품 클릭 ${row.clicks.toLocaleString('ko-KR')}회입니다.`, row)),
    ],
    note: truncated ? `이벤트가 ${MAX_EVENTS.toLocaleString('ko-KR')}건을 넘어 상위 범위만 분석했습니다.` : '수집된 상품 식별값과 행동 이벤트 기준입니다.',
  };
}

async function customerTypeTool(origin, plan, asOf) {
  // 고객 유형 전체 재분류는 수십 초 이상 걸릴 수 있으므로 대화 요청 안에서
  // Python 분류기를 다시 실행하지 않는다. 대시보드가 마지막으로 저장한
  // 쇼핑몰 전용 스냅샷만 읽어 API 타임아웃과 다른 사이트 혼입을 함께 막는다.
  const key = canonicalOrigin(origin).replace(/^https?:\/\//, '').replace(/[^a-z0-9._-]+/g, '_');
  const target = path.join(__dirname, '../../ml/output/unsupervised_semantic/site_snapshots', `${key}.json`);
  if (!fs.existsSync(target)) {
    return {
      period: plan.period,
      total_sessions: 0,
      clusters: [],
      evidence: [],
      note: '이 쇼핑몰의 저장된 고객 유형 스냅샷이 아직 없습니다. 대시보드에서 최신 데이터로 다시 분류를 먼저 실행해주세요.',
    };
  }
  const result = JSON.parse(fs.readFileSync(target, 'utf8'));
  const clusters = (result.clusters || []).map((row) => ({
    id: row.cluster,
    name: row.label,
    summary: row.summary,
    count: row.count,
    share: percent(row.count, result.total_sessions),
    reliability: row.reliability,
    behavior_rates: row.behavior_rates,
    top_actions: (row.top_actions || []).slice(0, 5),
  }));
  return {
    period: plan.period,
    snapshot_saved_at: result.snapshot_saved_at || null,
    snapshot_date_range: result.date_range || null,
    total_sessions: result.total_sessions,
    reliability: result.reliability,
    clusters,
    evidence: clusters.map((row) => evidence(`customer_type.${row.id}`, `'${row.name}' 유형은 ${row.count.toLocaleString('ko-KR')}개 세션(${row.share}%)입니다.`, { id: row.id, count: row.count, share: row.share })),
    note: '고객 유형은 마지막 저장 스냅샷 기준이며 행동 세션의 유사성 분류입니다. 회원 개인의 고정 속성이 아닙니다.',
  };
}

async function visualHotspotTool(origin, plan) {
  try {
    const result = await captureVisualHotspots(origin, plan);
    return {
      period: plan.period,
      run_id: result.run_id,
      captures: result.captures,
      cached: result.cached,
      evidence: result.captures.map((row, index) => evidence(
        `visual_exit.${index + 1}`,
        `'${row.section}' 구역에서 ${row.count.toLocaleString('ko-KR')}개 세션의 종료 신호가 모였으며 전체 종료 신호의 ${row.share_pct}%입니다.`,
        { section: row.section, count: row.count, share_pct: row.share_pct, url: row.url },
      )),
      note: result.captures.length
        ? '캡처는 분석 시점의 공개 페이지를 다시 열어 표시한 화면이며 실제 고객 화면 녹화가 아닙니다.'
        : '이 기간에는 캡처할 수 있는 이탈 집중 구역을 찾지 못했습니다.',
    };
  } catch (error) {
    console.warn('[ops-agent/visual-capture]', error.message);
    return {
      period: plan.period,
      run_id: null,
      captures: [],
      evidence: [],
      note: `이탈 위치 집계는 완료했지만 화면 캡처를 생성하지 못했습니다: ${error.message}`,
    };
  }
}

function previousActionTool(history, currentDigest) {
  if (!currentDigest) {
    return { previous_snapshot_id: null, comparisons: [], previous_actions: [], evidence: [], note: '현재 기간의 비교 지표를 계산하지 못했습니다.' };
  }
  const previous = [...history].reverse().find((message) => message.role === 'assistant' && message.metric_digest && message.snapshot_id);
  if (!previous) {
    return {
      previous_snapshot_id: null,
      comparisons: [],
      previous_actions: [],
      evidence: [],
      note: '비교할 이전 운영 제안 스냅샷이 아직 없습니다.',
    };
  }
  const old = previous.metric_digest;
  const fields = [
    ['product_reach_rate', '상품 조회 도달률', '%', '%p'],
    ['cart_rate', '장바구니 도달률', '%', '%p'],
    ['order_rate', '주문 완료율', '%', '%p'],
    ['risky_sessions', '탐색 중지 신호 세션', '건', '건'],
  ];
  const comparisons = fields.map(([key, label, valueUnit, deltaUnit]) => ({
    key, label, previous: Number(old[key] || 0), current: Number(currentDigest[key] || 0),
    delta: Math.round((Number(currentDigest[key] || 0) - Number(old[key] || 0)) * 10) / 10,
    value_unit: valueUnit, delta_unit: deltaUnit,
  }));
  return {
    previous_snapshot_id: previous.snapshot_id,
    comparisons,
    previous_actions: previous.content?.actions || [],
    evidence: comparisons.map((row) => evidence(
      `previous.${row.key}`,
      `${row.label}은 이전 스냅샷 ${row.previous}${row.value_unit}에서 현재 ${row.current}${row.value_unit}${row.value_unit === '건' ? '으로' : '로'} ${row.delta >= 0 ? '+' : ''}${row.delta}${row.delta_unit} 변했습니다.`,
      row,
    )),
    note: '지표 변화는 이전 제안의 인과 효과를 증명하지 않습니다. 같은 기간 정의와 외부 변화를 함께 확인해야 합니다.',
  };
}

function snapshotId(origin, plan, asOf) {
  return crypto.createHash('sha256').update(JSON.stringify({ origin, period: plan.period, asOf })).digest('hex').slice(0, 16);
}

async function buildAgentTools({ origin, plan, asOf, cachedTools = {}, history = [] }) {
  const baseNames = new Set([
    'get_period_overview', 'get_funnel_overview', 'get_channel_performance',
    'get_exit_signals', 'get_visit_time_patterns', 'get_previous_action_outcomes',
  ]);
  const needsBase = plan.required_tools.some((name) => baseNames.has(name));
  const tasks = [];
  if (needsBase) tasks.push(baseTools(origin, plan, asOf).then((value) => ['base', value]));
  if (plan.required_tools.includes('get_campaign_performance')) tasks.push(campaignTool(origin, plan, asOf).then((value) => ['get_campaign_performance', value]));
  if (plan.required_tools.includes('get_product_opportunities')) tasks.push(productTool(origin, plan, asOf).then((value) => ['get_product_opportunities', value]));
  if (plan.required_tools.includes('get_customer_type_insights')) tasks.push(customerTypeTool(origin, plan, asOf).then((value) => ['get_customer_type_insights', value]));
  if (plan.required_tools.includes('get_visual_exit_hotspots')) tasks.push(visualHotspotTool(origin, plan).then((value) => ['get_visual_exit_hotspots', value]));
  const results = await Promise.all(tasks);
  const tools = { ...cachedTools };
  let base = null;
  for (const [name, value] of results) {
    if (name === 'base') {
      base = value;
      Object.assign(tools, value.tools);
    } else {
      tools[name] = value;
    }
  }
  // 이 도구는 현재 집계와 직전 저장 답변을 함께 사용하므로 매 질문마다 다시 만든다.
  if (plan.required_tools.includes('get_previous_action_outcomes')) {
    tools.get_previous_action_outcomes = previousActionTool(history, base?.metric_digest || null);
  }
  return {
    id: snapshotId(origin, plan, asOf),
    as_of: asOf,
    period: base?.metrics?.period || {
      start: plan.period.startDate,
      end: plan.period.endDate,
      timezone: 'Asia/Seoul',
      as_of: range(plan, asOf).to.toISOString(),
    },
    tools,
    metric_digest: base?.metric_digest || null,
  };
}

module.exports = { buildAgentTools, resolvePlanPeriod, percent, digest };
