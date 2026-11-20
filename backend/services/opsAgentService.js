const { canonicalOrigin } = require('../middleware/siteAccess');
const { planQuestion, daysPeriod } = require('../lib/agentQuestionPlanner');
const { buildAgentTools, resolvePlanPeriod } = require('./opsAgentTools');

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function agentProfile(origin) {
  const tenantId = canonicalOrigin(origin);
  const host = tenantId.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return {
    tenant_id: tenantId,
    name: `${host} 운영 제안 에이전트`,
    description: `${host}의 검증된 집계 데이터만 분석하는 읽기 전용 운영 파트너`,
    capabilities: [
      '기간 성과 비교', '구매 여정 진단', '유입 채널·UTM 캠페인 비교',
      '상품 행동 분석', '고객 유형 분석', '이탈 신호 점검', '이전 제안 지표 비교',
      '이탈 집중 구역 화면 캡처',
    ],
    restrictions: ['다른 쇼핑몰 데이터 접근 불가', '원시 DB 쿼리 불가', '상품·주문·고객 데이터 수정 불가'],
  };
}

function samePeriod(snapshot, plan) {
  return snapshot
    && snapshot.period?.startDate === plan.period.startDate
    && snapshot.period?.endDate === plan.period.endDate;
}

function decideAsOf(snapshot, plan) {
  if (samePeriod(snapshot, plan) && !plan.refresh_snapshot && snapshot.as_of) return snapshot.as_of;
  return new Date().toISOString();
}

function responseSchema() {
  return {
    type: 'OBJECT',
    required: ['summary', 'hypotheses', 'actions', 'kpis', 'caveats'],
    properties: {
      summary: { type: 'STRING' },
      hypotheses: { type: 'ARRAY', items: { type: 'STRING' } },
      actions: { type: 'ARRAY', items: { type: 'STRING' } },
      kpis: { type: 'ARRAY', items: { type: 'STRING' } },
      caveats: { type: 'ARRAY', items: { type: 'STRING' } },
    },
  };
}

const MIN_SAMPLE = 20;

function fmt(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function shortDate(value) {
  const [, month, day] = String(value || '').split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : '';
}

function periodLabel(plan) {
  const { startDate, endDate } = plan.period || {};
  return startDate && endDate ? `${shortDate(startDate)}~${shortDate(endDate)}` : '선택한 기간';
}

function previousPeriodLabel(plan) {
  const { startDate, endDate } = plan.period || {};
  if (!startDate || !endDate) return '직전 동일 기간';
  const DAY = 24 * 60 * 60 * 1000;
  const start = new Date(`${startDate}T12:00:00+09:00`);
  const end = new Date(`${endDate}T12:00:00+09:00`);
  const span = Math.round((end - start) / DAY) + 1;
  const iso = (date) => new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `${shortDate(iso(new Date(start.getTime() - span * DAY)))}~${shortDate(iso(new Date(start.getTime() - DAY)))}`;
}

// 이 질문이 실제로 바라보는 세션 수. 채널을 물었으면 그 채널 세션만 센다.
function focusSessions(plan, tools) {
  const channelTool = tools.get_channel_performance;
  const asksChannel = plan.filters.channel || (plan.filters.channels || []).length;
  if (asksChannel && channelTool) {
    return (channelTool.channels || []).reduce((sum, row) => sum + Number(row.sessions || 0), 0);
  }
  const overview = tools.get_period_overview?.sessions?.current;
  if (overview !== undefined) return Number(overview || 0);
  const firstStage = tools.get_funnel_overview?.stages?.[0]?.sessions;
  return firstStage === undefined ? null : Number(firstStage || 0);
}

// 방문은 충분한데 상품 조회로 가장 덜 이어지는 채널. 일반론 대신 이 채널을 짚는다.
function weakestChannel(tools) {
  const rows = (tools.get_channel_performance?.channels || []).filter((row) => Number(row.sessions || 0) >= MIN_SAMPLE);
  return rows.sort((a, b) => a.product_reach_rate - b.product_reach_rate || b.sessions - a.sessions)[0] || null;
}

function insufficientAnswer(plan, sampleSize, observations) {
  const target = plan.filters.channel
    ? `${plan.filters.channel} 유입`
    : (plan.filters.channels || []).length ? `${plan.filters.channels.join('·')} 유입` : '이 기간';
  return {
    summary: sampleSize === 0
      ? `${target} 세션이 아직 없어 분석할 수 없습니다. 수집된 데이터가 생긴 뒤 다시 확인하세요.`
      : `${target} 세션이 ${fmt(sampleSize)}건뿐이라 운영 조치를 제안하기엔 표본이 부족합니다. 최소 ${MIN_SAMPLE}건 이상 모인 뒤 다시 확인하세요.`,
    observations,
    hypotheses: [],
    actions: [],
    kpis: [],
    caveats: ['분석 기간을 늘리거나(예: "최근 30일") 채널 조건을 빼고 다시 질문하면 판단할 수 있는 표본이 생길 수 있습니다.'],
  };
}

function channelComparisonAnswer(plan, tools) {
  const rows = [...(tools.get_channel_performance?.channels || [])].sort((a, b) => b.sessions - a.sessions);
  const enough = rows.filter((row) => Number(row.sessions || 0) >= MIN_SAMPLE);
  const observations = rows.map((row) => ({
    id: `channel_compare.${row.name}`,
    statement: `${row.name}: 방문 ${fmt(row.sessions)}건 · 상품 조회 ${row.product_reach_rate}% · 장바구니 ${row.cart_rate}% · 주문 ${fmt(row.orders)}건(${row.order_rate}%)`,
  }));
  const missing = tools.get_channel_performance?.missing || [];
  let summary;
  if (enough.length >= 2) {
    const best = [...enough].sort((a, b) => b.product_reach_rate - a.product_reach_rate)[0];
    const worst = [...enough].sort((a, b) => a.product_reach_rate - b.product_reach_rate)[0];
    summary = best.name === worst.name
      ? `${enough.map((row) => row.name).join('·')}의 상품 조회율이 ${best.product_reach_rate}%로 같습니다.`
      : `상품 조회로 더 잘 이어지는 채널은 ${best.name}(${best.product_reach_rate}%)이고, ${worst.name}은 ${worst.product_reach_rate}%로 가장 낮습니다. 먼저 손볼 곳은 ${worst.name} 광고가 도착하는 첫 화면입니다.`;
  } else if (enough.length === 1) {
    summary = `비교할 만큼 표본이 있는 채널은 ${enough[0].name}(${fmt(enough[0].sessions)}건)뿐이라 채널 간 우열은 판단하기 어렵습니다.`;
  } else {
    summary = `비교한 채널 모두 세션이 ${MIN_SAMPLE}건 미만이라 우열을 판단하기 어렵습니다.`;
  }
  const worst = enough.length >= 2 ? [...enough].sort((a, b) => a.product_reach_rate - b.product_reach_rate)[0] : null;
  return {
    summary,
    observations,
    kpis: worst ? [`${worst.name} 상품 조회율: 현재 ${worst.product_reach_rate}%에서 상승했는지 7일 후 비교`] : [],
    caveats: missing.length ? [`${missing.join(', ')} 유입은 이 기간 세션이 없어 비교에서 빠졌습니다.`] : [],
    worst,
  };
}

function transitionAction(top) {
  if (!top) return '가장 많이 줄어드는 화면에서 다음 단계 버튼과 필수 정보를 한 화면 안에 배치하세요.';
  const key = `${top.from} ${top.to}`;
  if (/방문|홈/.test(key) && /상품/.test(key)) {
    return '홈 화면 첫 화면 바로 아래에 대표 상품 4~6개와 “상품 보러가기” 버튼을 배치하고, 버튼은 해당 상품 목록으로 바로 연결하세요.';
  }
  if (/상품/.test(top.from) && /장바구니/.test(top.to)) {
    return '상품 상세 화면에서 가격 바로 아래에 배송비·도착 예정일·교환 조건을 노출하고, 모바일 하단에는 “장바구니 담기” 버튼을 고정하세요.';
  }
  if (/장바구니/.test(top.from) && /결제|주문/.test(top.to)) {
    return '장바구니 화면 상단에 최종 결제금액과 배송비를 먼저 보여주고, 목록 아래와 화면 하단에 “주문하기” 버튼을 각각 배치하세요.';
  }
  return `'${top.from}' 화면에서 '${top.to}'로 이동하는 버튼을 주요 콘텐츠 바로 다음에 배치하고, 버튼 문구에 다음 행동을 구체적으로 적으세요.`;
}

async function gemini(body, timeoutMs = 45_000) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 429가 분당 한도인지 일일 한도인지 로그만 봐도 알 수 있게 사유를 남긴다(키는 포함되지 않음).
    const reason = String(payload?.error?.message || '').split('\n')[0].slice(0, 200);
    const error = new Error(`Gemini API 오류 (${response.status})${reason ? `: ${reason}` : ''}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

// 429(요청 한도)·503(일시 과부하)은 잠깐 뒤 다시 하면 되는 경우가 많다.
// 바로 규칙 기반 답변으로 떨어지지 않고 2초 쉬고 1번만 더 시도한다.
async function geminiWithRetry(body, timeoutMs, {
  call = gemini,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  try {
    return await call(body, timeoutMs);
  } catch (error) {
    if (![429, 500, 503].includes(error.status)) throw error;
    console.warn(`[ops-agent] Gemini ${error.status} - 2초 후 재시도`);
    await wait(2000);
    return call(body, timeoutMs);
  }
}

function firstText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
}

function cleanList(value, limit = 5) {
  return (Array.isArray(value) ? value : []).map((item) => String(item).trim().slice(0, 500)).filter(Boolean).slice(0, limit);
}

function safeCausalLanguage(value) {
  return String(value || '')
    .replace(/직접적인?\s*영향을?\s*(?:미치고|미쳤고|미친다|줍니다)/g, '관련 가능성이 있어 함께 점검할 필요가 있습니다')
    .replace(/(?:명확한|확실한)\s*원인(?:입니다|이다)/g, '점검이 필요한 가설입니다')
    .slice(0, 1000);
}

function kstLabel(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function parseAnswer(text) {
  const clean = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean);
  return {
    summary: safeCausalLanguage(value.summary),
    hypotheses: cleanList(value.hypotheses).map(safeCausalLanguage),
    actions: cleanList(value.actions),
    kpis: cleanList(value.kpis),
    caveats: cleanList(value.caveats),
  };
}

function collectedObservations(tools, usedTools) {
  const seen = new Set();
  const rows = [];
  for (const name of usedTools) {
    for (const row of tools[name]?.evidence || []) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push({ id: row.id, statement: String(row.statement || ''), tool: name });
    }
  }
  const priority = (row) => {
    if (/top_|visual_exit/.test(row.id)) return 0;
    if (/channel\.|campaign\.|product\./.test(row.id)) return 1;
    if (/overview\.(orders|sessions)/.test(row.id)) return 2;
    return 3;
  };
  return rows.sort((a, b) => priority(a) - priority(b)).slice(0, 4);
}

function fallbackNarrative(plan, tools) {
  const has = (name) => plan.required_tools.includes(name);
  const explicitlyAsked = (target) => plan.targets.includes(target);
  const hypotheses = [];
  const actions = [];
  const kpis = [];
  if (has('get_funnel_overview')) {
    const transitions = tools.get_funnel_overview?.transitions || [];
    const top = [...transitions].sort((a, b) => b.stopped - a.stopped)[0];
    // '방문'은 화면이 아니라 단계 이름이다. 첫 단계면 실제로 가장 많이 끝난 화면 이름을 쓴다.
    const exitLabel = tools.get_exit_signals?.exit_pages?.[0]?.label;
    const screen = top?.from === '방문' ? (exitLabel || '첫 방문 화면') : (top?.from || '현재 단계');
    hypotheses.push(`'${screen}'에서 상품으로 넘어가는 다음 행동이 눈에 띄지 않거나, 결정에 필요한 정보가 늦게 제시되는지 확인할 필요가 있습니다.`);
    actions.push(transitionAction(top));
    if (top) {
      const currentReach = Math.round((100 - top.stop_rate) * 10) / 10;
      kpis.push(`'${top.from} → ${top.to}' 도달률: 현재 ${currentReach}%에서 상승했는지 7일 후 비교`);
    }
  }
  if (has('get_visual_exit_hotspots')) {
    const first = tools.get_visual_exit_hotspots?.captures?.[0];
    actions.push(`캡처의 '${first?.section || '빨간 표시'}' 영역 바로 위에 다음 행동 버튼을 1개만 배치하고, 버튼 문구를 “자세히 보기” 대신 이동할 목적이 드러나는 말로 바꾸세요.`);
    if (first) kpis.push(`'${first.section}' 구역 종료 신호: 현재 ${first.count}건보다 감소했는지 7일 후 비교`);
  }
  if (has('get_channel_performance') || has('get_campaign_performance')) {
    const weak = weakestChannel(tools);
    if (weak) {
      hypotheses.push(`${weak.name} 유입은 방문 ${fmt(weak.sessions)}건 중 상품 조회가 ${weak.product_reach_rate}%에 그쳐, 광고가 도착하는 첫 화면과 광고 내용이 어긋났을 가능성이 있습니다.`);
      actions.push(`${weak.name} 광고·게시물의 링크가 홈으로 연결돼 있다면 광고에 나온 상품의 상세 화면으로 바꾸고, 광고 문구의 상품명·혜택을 그 화면 첫 제목에 그대로 넣으세요.`);
      kpis.push(`${weak.name} 상품 조회율: 현재 ${weak.product_reach_rate}%에서 상승했는지 7일 후 비교`);
    }
  }
  if (has('get_product_opportunities')) {
    const product = tools.get_product_opportunities?.products?.[0];
    actions.push(`'${product?.name || '관심도가 가장 높은 상품'}' 상세 화면에서 가격 아래에 배송·교환·후기 요약을 붙이고, 옵션 선택 다음에 장바구니 버튼이 바로 보이도록 순서를 바꾸세요.`);
    kpis.push('수정 상품의 상세 조회 대비 장바구니 담기율이 7일 전보다 상승했는지 확인');
  }
  if (has('get_customer_type_insights')) {
    actions.push('비중이 큰 고객 유형의 대표 행동과 신뢰도를 함께 보고 유형별 안내 우선순위를 정하세요.');
    kpis.push('고객 유형별 장바구니·주문 행동률');
  }
  if (explicitlyAsked('previous_action') && tools.get_previous_action_outcomes?.previous_snapshot_id) {
    hypotheses.push('이전 제안 이후의 지표 변화는 관찰되지만 해당 제안의 인과 효과로 단정할 수 없습니다.');
    kpis.push('이전 스냅샷 대비 핵심 지표 변화');
  }
  return {
    summary: '가장 큰 이탈 구간 한 곳을 먼저 수정하고, 다음 7일의 도달률 변화로 효과를 판단하세요.',
    hypotheses: hypotheses.slice(0, 4),
    actions: actions.slice(0, 4),
    kpis: [...new Set(kpis)].slice(0, 5),
    caveats: ['관측된 행동과 종료 화면만으로 고객 의도나 이탈 원인을 단정할 수 없습니다.'],
  };
}

function previousAssistantAnswer(history) {
  return [...history].reverse().find((message) => message?.role === 'assistant' && message?.content)?.content || null;
}

function executionPlanNarrative(previous, fallback) {
  const sourceActions = cleanList(previous?.actions, 3);
  const actions = (sourceActions.length ? sourceActions : fallback.actions).slice(0, 3).map((action, index) => {
    const timing = index === 0 ? '월요일' : index === 1 ? '화~수요일' : '목~금요일';
    return `${index + 1}순위 · ${timing}: ${String(action).replace(/^\d+순위\s*[·:-]?\s*/, '')}`;
  });
  return {
    summary: '이번 주에는 영향이 큰 수정부터 적용하고, 주 후반에 같은 지표로 결과를 확인하세요.',
    hypotheses: [],
    actions,
    kpis: cleanList(previous?.kpis, 3).length ? cleanList(previous.kpis, 3) : fallback.kpis,
    caveats: [],
  };
}

function serverSummary(plan, tools) {
  const channel = plan.filters.channel;
  const campaign = plan.filters.campaign;
  if (plan.required_tools.includes('get_visual_exit_hotspots')) {
    const first = tools.get_visual_exit_hotspots?.captures?.[0];
    return first
      ? `먼저 고칠 곳은 캡처에 표시된 '${first.section}' 구역입니다. 이 위치에 종료 신호 ${first.count.toLocaleString('ko-KR')}건(${first.share_pct}%)이 모였습니다.`
      : '이탈 집중 구역을 화면으로 확인하려 했지만 이번 기간에는 표시할 캡처를 생성하지 못했습니다.';
  }
  if (plan.targets.includes('sales') && !plan.filters.channel) {
    const overview = tools.get_period_overview || {};
    const sessions = Number(overview.sessions?.current || 0);
    const orders = overview.orders || {};
    const delta = Number(orders.delta || 0);
    const trend = delta > 0 ? `직전 같은 기간보다 ${fmt(delta)}건 늘었습니다` : delta < 0 ? `직전 같은 기간보다 ${fmt(-delta)}건 줄었습니다` : '직전 같은 기간과 같습니다';
    return `${periodLabel(plan)} 기간 주문 완료는 ${fmt(orders.current)}건으로 방문 ${fmt(sessions)}건 대비 ${overview.order_rate ?? 0}%이며, ${trend}.`;
  }
  if (plan.targets.includes('previous_action')) {
    return '이전 운영 제안 당시의 핵심 지표와 현재 스냅샷을 같은 정의로 비교했습니다. 변화는 관측값이며 제안의 인과 효과로 단정하지 않습니다.';
  }
  if (plan.required_tools.includes('get_customer_type_insights')) {
    return '저장된 쇼핑몰 전용 고객 유형 스냅샷에서 유형별 비중과 대표 행동을 확인했습니다.';
  }
  if (plan.required_tools.includes('get_campaign_performance') && (campaign || !plan.targets.includes('channel'))) {
    return `${campaign ? `'${campaign}'` : 'UTM'} 캠페인의 방문과 주문 연결을 비교해 우선 점검할 대상을 정리했습니다.`;
  }
  if (plan.required_tools.includes('get_product_opportunities')) {
    return `${channel ? `${channel} 유입에서 ` : ''}관심 행동이 많이 관찰된 상품과 다음 구매 단계의 연결을 점검할 필요가 있습니다.`;
  }
  if (plan.required_tools.includes('get_channel_performance')) {
    const rows = tools.get_channel_performance?.channels || [];
    const row = channel ? rows[0] : null;
    if (row) {
      return `${row.name} 유입은 방문 ${fmt(row.sessions)}건 중 상품 조회 ${row.product_reach_rate}%, 장바구니 ${row.cart_rate}%, 주문 ${fmt(row.orders)}건입니다.`;
    }
    const weak = weakestChannel(tools);
    if (weak) {
      return `방문 대비 상품 조회로 가장 덜 이어지는 채널은 ${weak.name}(방문 ${fmt(weak.sessions)}건, 상품 조회 ${weak.product_reach_rate}%)입니다.`;
    }
    return '유입 채널별 방문이 상품 조회·장바구니·주문으로 이어지는 흐름을 비교했습니다.';
  }
  if (plan.required_tools.includes('get_funnel_overview')) {
    const top = tools.get_funnel_overview?.transitions?.slice().sort((a, b) => b.stopped - a.stopped)[0];
    return top
      ? `가장 먼저 개선할 곳은 '${top.from} → ${top.to}' 구간입니다. ${top.stopped.toLocaleString('ko-KR')}개 세션(${top.stop_rate}%)이 다음 단계로 넘어가지 않았습니다.`
      : '구매 여정의 단계별 도달과 중단 구간을 확인했습니다.';
  }
  return '선택한 기간의 운영 지표를 검증된 집계 기준으로 분석했습니다.';
}

function comparisonAnswer(tools, plan = null) {
  const overview = tools.get_period_overview || {};
  const sessions = overview.sessions || {};
  const orders = overview.orders || {};
  const risky = overview.risky_sessions || {};
  const direction = (delta) => Number(delta) > 0 ? '증가' : Number(delta) < 0 ? '감소' : '변화 없음';
  return {
    summary: `${plan ? `${periodLabel(plan)} 기간을 직전 ${previousPeriodLabel(plan)} 기간과 비교하면` : '직전 동일 기간과 비교하면'} 방문 세션은 ${Math.abs(Number(sessions.delta || 0)).toLocaleString('ko-KR')}건 ${direction(sessions.delta)}했고, 주문 완료는 ${Math.abs(Number(orders.delta || 0)).toLocaleString('ko-KR')}건 ${direction(orders.delta)}했습니다.`,
    observations: [
      { id: 'comparison.sessions', statement: `방문 세션: 직전 ${Number(sessions.previous || 0).toLocaleString('ko-KR')}건 → 현재 ${Number(sessions.current || 0).toLocaleString('ko-KR')}건 (${Number(sessions.delta || 0) >= 0 ? '+' : ''}${Number(sessions.delta || 0).toLocaleString('ko-KR')}건)` },
      { id: 'comparison.orders', statement: `주문 완료: 직전 ${Number(orders.previous || 0).toLocaleString('ko-KR')}건 → 현재 ${Number(orders.current || 0).toLocaleString('ko-KR')}건 (${Number(orders.delta || 0) >= 0 ? '+' : ''}${Number(orders.delta || 0).toLocaleString('ko-KR')}건)` },
      { id: 'comparison.risky', statement: `탐색 중지 신호 세션: 직전 ${Number(risky.previous || 0).toLocaleString('ko-KR')}건 → 현재 ${Number(risky.current || 0).toLocaleString('ko-KR')}건 (${Number(risky.delta || 0) >= 0 ? '+' : ''}${Number(risky.delta || 0).toLocaleString('ko-KR')}건)` },
    ],
  };
}

// 캡처 없이 화면 질문에 답할 때는 그 화면의 종료 세션 수를 확인 지표로 둔다.
function exitKpis(tools) {
  const top = tools.get_exit_signals?.exit_pages?.[0];
  return top ? [`'${top.label}' 화면에서 끝난 세션: 현재 ${fmt(top.sessions)}건(${top.share}%)에서 줄었는지 7일 후 비교`] : [];
}

function verifiedKpis(plan, tools) {
  const rows = [];
  // 채널을 물었으면 사이트 전체 지표가 아니라 그 채널 지표부터 확인 항목으로 둔다.
  if (plan.filters.channel) {
    const row = tools.get_channel_performance?.channels?.[0];
    if (row) {
      rows.push(`${row.name} 상품 조회율: 현재 ${row.product_reach_rate}%에서 상승했는지 7일 후 비교`);
      rows.push(`${row.name} 장바구니 도달률: 현재 ${row.cart_rate}%에서 상승했는지 7일 후 비교`);
      return rows;
    }
  }
  // "광고 효과 있어?"처럼 채널 전체를 물으면 사이트 퍼널보다 가장 약한 채널 지표를 먼저 둔다.
  if (plan.targets.includes('channel')) {
    const weak = weakestChannel(tools);
    if (weak) rows.push(`${weak.name} 상품 조회율: 현재 ${weak.product_reach_rate}%에서 상승했는지 7일 후 비교`);
  }
  const top = tools.get_funnel_overview?.transitions?.slice().sort((a, b) => b.stopped - a.stopped)[0];
  if (top) {
    const reach = Math.round((100 - Number(top.stop_rate || 0)) * 10) / 10;
    rows.push(`${top.from} → ${top.to} 도달률: 현재 ${reach}%에서 상승했는지 7일 후 비교`);
    rows.push(`${top.from} → ${top.to} 중단율: 현재 ${top.stop_rate}%에서 감소했는지 7일 후 비교`);
  }
  const visual = tools.get_visual_exit_hotspots?.captures?.[0];
  if (visual) rows.push(`${visual.section} 구역 종료 신호: 현재 ${visual.count}건보다 감소했는지 7일 후 비교`);
  const channel = tools.get_channel_performance?.channels?.[0];
  if (!top && channel) rows.push(`${channel.name} 상품 조회율: 현재 ${channel.product_reach_rate}%에서 상승했는지 7일 후 비교`);
  return [...new Set(rows)].slice(0, 3);
}

async function generateNarrative({ profile, question, plan, tools, usedTools, history }) {
  const safeHistory = history.slice(-4).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify({
      summary: message.content?.summary,
      actions: message.content?.actions,
      hypotheses: message.content?.hypotheses,
    }) }],
  }));
  const toolPayload = Object.fromEntries(usedTools.map((name) => [name, tools[name]]));
  const system = [
    `너는 ${profile.name}다. 담당 tenant_id는 ${profile.tenant_id}다.`,
    '일반 챗봇이 아니라 쇼핑몰 운영 제안 전용 에이전트다.',
    '서버가 질문을 구조화하고 필수 도구를 결정했으므로 제공된 도구 결과만 해석한다.',
    '관측 수치와 근거 문장은 서버가 별도로 표시한다. 응답에는 evidence나 observations를 작성하지 말고 숫자 근거를 새로 쓰지 마라.',
    'summary는 질문에 대한 직접 답변 한두 문장으로 쓰고, “분석했습니다” 같은 서론은 쓰지 마라.',
    'hypotheses는 최대 2개만 쓰며 반드시 가능성·확인 방법을 포함하고 인과관계로 단정하지 마라.',
    'actions는 1~3개만 작성한다. 각 문장은 수정 위치, 바꿀 요소, 바꾸는 방법을 모두 포함해야 한다.',
    '“강화하세요”, “개선하세요”, “검토하세요”, “점검하세요”만으로 끝나는 모호한 조치는 금지한다.',
    'kpis에 임의의 목표 숫자를 만들지 마라. 서버 도구에 있는 현재값만 인용하고 7일 후 상승·감소·유지 여부처럼 판정 방향만 써라.',
    'caveats는 의사결정에 실제 영향을 주는 제한만 최대 1개 작성한다.',
    '상품·주문·고객·DB를 변경한다고 말하지 마라.',
    '채널·상품·화면을 언급할 때는 도구 결과에 있는 이름을 그대로 쓰고, 어느 채널에도 해당될 수 있는 일반론(“광고 링크를 대표 상품으로 연결” 등)만 쓰지 마라.',
    plan.filters.channel ? `이번 질문은 ${plan.filters.channel} 유입에 대한 질문이다. 사이트 전체 수치가 아니라 ${plan.filters.channel} 수치를 기준으로 판단하라.` : '',
    plan.response_mode === 'execution_plan'
      ? '이번 요청은 실행 순서 정리다. 최초 진단을 반복하지 말고 이전 답변의 조치를 1~3순위와 요일별 실행 순서로 재구성하라. hypotheses는 빈 배열로 반환하라.'
      : '',
    plan.response_mode === 'visual_diagnosis'
      ? '이번 요청은 화면 캡처 확인이다. 캡처가 있으면 표시 위치를 기준으로 수정안을 쓰고, 없으면 진단 전체를 반복하지 말고 캡처 불가 사실과 대신 확인할 정확한 화면 구역만 짧게 써라.'
      : '',
    '한국어로 간결하게 작성하라.',
  ].join(' ');
  const payload = { question, structured_request: plan, server_selected_tools: toolPayload };
  const request = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [...safeHistory, { role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 3200,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
    },
  };
  const result = await geminiWithRetry(request);
  try {
    return parseAnswer(firstText(result));
  } catch (firstError) {
    const finishReason = result?.candidates?.[0]?.finishReason || 'UNKNOWN';
    console.warn(`[ops-agent] Gemini JSON 재생성: ${finishReason} / ${firstError.message}`);
    const retry = await geminiWithRetry({
      ...request,
      systemInstruction: { parts: [{ text: `${system} 반드시 완결된 JSON 객체 하나만 반환하고 모든 문자열과 배열을 닫아라.` }] },
      generationConfig: { ...request.generationConfig, temperature: 0, maxOutputTokens: 4096 },
    });
    return parseAnswer(firstText(retry));
  }
}

async function answerQuestion({ origin, question, days = 7, history = [], snapshot = null }) {
  const profile = agentProfile(origin);
  const previousPlan = [...history].reverse().find((message) => message?.query_plan)?.query_plan || null;
  let plan = planQuestion(question, { days, previousPlan });
  plan = await resolvePlanPeriod(origin, plan);
  const asOf = decideAsOf(snapshot, plan);
  const built = await buildAgentTools({ origin, plan, asOf, history });
  const usedTools = plan.required_tools.filter((name) => built.tools[name]);
  const observations = collectedObservations(built.tools, usedTools);
  const toolNotes = usedTools.map((name) => built.tools[name]?.note).filter(Boolean);
  const sampleSize = focusSessions(plan, built.tools);
  const baseResult = {
    used_tools: usedTools,
    period: built.period,
    plan,
    snapshot: {
      id: built.id,
      as_of: built.as_of,
      period: { startDate: plan.period.startDate, endDate: plan.period.endDate },
      metric_digest: built.metric_digest,
    },
  };

  // 표본이 너무 적으면 Gemini를 부르지 않고 "판단 불가"를 그대로 말한다.
  // (예전엔 0건이어도 그럴듯한 조치를 지어냈다.)
  // 숫자만 나란히 보여주는 비교 모드와 이전 답변을 재정리하는 실행 계획은 제외한다.
  const guardedMode = !['execution_plan', 'channel_comparison', 'period_comparison'].includes(plan.response_mode);
  if (guardedMode && sampleSize !== null && sampleSize < MIN_SAMPLE) {
    return {
      ...baseResult,
      source: 'sample_guard',
      answer: { response_mode: plan.response_mode, ...insufficientAnswer(plan, sampleSize, observations), visuals: [] },
    };
  }

  // 채널 비교는 서버가 숫자로 직접 답한다. Gemini는 가장 약한 채널에 대한 조치만 보탠다.
  if (plan.response_mode === 'channel_comparison') {
    const compared = channelComparisonAnswer(plan, built.tools);
    let actions = [];
    let source = 'server';
    if (compared.worst) {
      actions = [`${compared.worst.name} 광고·게시물의 링크가 홈으로 연결돼 있다면 광고에 나온 상품의 상세 화면으로 바꾸고, 광고 문구의 상품명·혜택을 그 화면 첫 제목에 그대로 넣으세요.`];
      try {
        const narrative = await generateNarrative({ profile, question, plan, tools: built.tools, usedTools, history });
        if (narrative.actions.length) {
          actions = narrative.actions.slice(0, 2);
          source = 'gemini';
        }
      } catch (error) {
        console.warn('[ops-agent] Gemini 분석 대체:', error.message);
        source = 'rules_fallback';
      }
    }
    return {
      ...baseResult,
      source,
      answer: {
        response_mode: plan.response_mode,
        summary: compared.summary,
        observations: compared.observations,
        hypotheses: [],
        actions,
        kpis: compared.kpis,
        caveats: compared.caveats,
        visuals: [],
      },
    };
  }

  let narrative;
  let source = 'gemini';
  try {
    narrative = await generateNarrative({ profile, question, plan, tools: built.tools, usedTools, history });
  } catch (error) {
    console.warn('[ops-agent] Gemini 분석 대체:', error.message);
    narrative = fallbackNarrative(plan, built.tools);
    source = 'rules_fallback';
  }
  const priorAnswer = previousAssistantAnswer(history);
  if (plan.response_mode === 'execution_plan') {
    narrative = executionPlanNarrative(priorAnswer, narrative);
  }
  if (plan.response_mode === 'visual_diagnosis' && !built.tools.get_visual_exit_hotspots?.captures?.length) {
    narrative.hypotheses = [];
    // 캡처가 없을 때 무조건 "홈 화면"이라고 하지 않고, 실제로 가장 많이 나간 화면을 짚는다.
    const topExit = built.tools.get_exit_signals?.exit_pages?.[0];
    narrative.actions = topExit
      ? [`캡처는 만들지 못했지만, 탐색이 가장 많이 끝난 화면은 '${topExit.label}'(${fmt(topExit.sessions)}건, ${topExit.share}%)입니다. 이 화면에서 다음 단계 버튼과 핵심 정보가 첫 화면 안에 보이는지 먼저 확인하세요.`]
      : ['이번 기간에는 캡처도, 이탈이 몰린 화면 집계도 없어 수정할 위치를 특정할 수 없습니다. 기간을 늘려 다시 질문해 주세요.'];
    narrative.kpis = [];
  }
  const comparison = plan.response_mode === 'period_comparison' ? comparisonAnswer(built.tools, plan) : null;
  const visualWithoutCapture = plan.response_mode === 'visual_diagnosis' && !built.tools.get_visual_exit_hotspots?.captures?.length;
  const answer = {
    // 요약과 모든 수치 근거는 서버가 작성한다. Gemini는 가설·조치 문장만 담당한다.
    response_mode: plan.response_mode,
    summary: comparison?.summary || (plan.response_mode === 'execution_plan' ? narrative.summary : serverSummary(plan, built.tools)),
    observations: plan.response_mode === 'execution_plan'
      ? []
      : plan.response_mode === 'visual_diagnosis'
        ? observations.filter((row) => /visual_exit|exit\.top_page|funnel\.top_stop/.test(row.id)).slice(0, 2)
        : comparison?.observations || observations,
    hypotheses: comparison ? [] : narrative.hypotheses,
    actions: comparison ? [] : narrative.actions,
    // 목표 수치는 Agent가 추정하지 않는다. 서버가 실제 현재값과 판정 방향만 만든다.
    kpis: comparison ? [] : visualWithoutCapture ? exitKpis(built.tools) : verifiedKpis(plan, built.tools),
    caveats: [...new Set([
      ...(plan.targets.includes('sales') ? ['매출 금액이 아니라 주문 완료 건수 기준입니다.'] : []),
      ...narrative.caveats,
      ...toolNotes.filter((note) => /없|못|초과|녹화가 아닙니다/.test(note)),
    ])].slice(0, 2),
    visuals: (built.tools.get_visual_exit_hotspots?.captures || []).slice(0, 2),
  };
  return { ...baseResult, answer, source };
}

module.exports = {
  agentProfile, answerQuestion, periodForDays: daysPeriod, samePeriod, decideAsOf,
  focusSessions, weakestChannel, channelComparisonAnswer, insufficientAnswer, verifiedKpis, geminiWithRetry, MIN_SAMPLE,
};
