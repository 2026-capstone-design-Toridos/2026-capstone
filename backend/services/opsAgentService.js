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
  if (!response.ok) throw new Error(`Gemini API 오류 (${response.status})`);
  return payload;
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
    hypotheses.push(`'${top?.from || '현재 단계'}' 화면에서 다음 행동이 눈에 띄지 않거나, 결정에 필요한 정보가 늦게 제시되는지 확인할 필요가 있습니다.`);
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
    hypotheses.push('유입 메시지와 실제 랜딩 화면의 연결 정도에 따라 채널별 성과 차이가 발생했을 가능성이 있습니다.');
    actions.push('방문이 가장 많은 광고의 링크를 대표 상품 또는 기획전 화면으로 직접 연결하고, 광고에 쓴 상품명·혜택 문구를 랜딩 화면 첫 제목에도 동일하게 넣으세요.');
    kpis.push('해당 유입의 상품 조회율이 상승하고 주문 수가 줄지 않았는지 7일 단위로 비교');
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
  if (plan.targets.includes('previous_action')) {
    return '이전 운영 제안 당시의 핵심 지표와 현재 스냅샷을 같은 정의로 비교했습니다. 변화는 관측값이며 제안의 인과 효과로 단정하지 않습니다.';
  }
  if (plan.required_tools.includes('get_customer_type_insights')) {
    return '저장된 쇼핑몰 전용 고객 유형 스냅샷에서 유형별 비중과 대표 행동을 확인했습니다.';
  }
  if (plan.required_tools.includes('get_campaign_performance')) {
    return `${campaign ? `'${campaign}'` : 'UTM'} 캠페인의 방문과 주문 연결을 비교해 우선 점검할 대상을 정리했습니다.`;
  }
  if (plan.required_tools.includes('get_product_opportunities')) {
    return `${channel ? `${channel} 유입에서 ` : ''}관심 행동이 많이 관찰된 상품과 다음 구매 단계의 연결을 점검할 필요가 있습니다.`;
  }
  if (plan.required_tools.includes('get_channel_performance')) {
    return `${channel || '유입 채널별'} 방문이 상품 조회·장바구니·주문으로 이어지는 흐름을 비교했습니다.`;
  }
  if (plan.required_tools.includes('get_funnel_overview')) {
    const top = tools.get_funnel_overview?.transitions?.slice().sort((a, b) => b.stopped - a.stopped)[0];
    return top
      ? `가장 먼저 개선할 곳은 '${top.from} → ${top.to}' 구간입니다. ${top.stopped.toLocaleString('ko-KR')}개 세션(${top.stop_rate}%)이 다음 단계로 넘어가지 않았습니다.`
      : '구매 여정의 단계별 도달과 중단 구간을 확인했습니다.';
  }
  return '선택한 기간의 운영 지표를 검증된 집계 기준으로 분석했습니다.';
}

function comparisonAnswer(tools) {
  const overview = tools.get_period_overview || {};
  const sessions = overview.sessions || {};
  const orders = overview.orders || {};
  const risky = overview.risky_sessions || {};
  const direction = (delta) => Number(delta) > 0 ? '증가' : Number(delta) < 0 ? '감소' : '변화 없음';
  return {
    summary: `직전 동일 기간과 비교하면 방문 세션은 ${Math.abs(Number(sessions.delta || 0)).toLocaleString('ko-KR')}건 ${direction(sessions.delta)}했고, 주문 완료는 ${Math.abs(Number(orders.delta || 0)).toLocaleString('ko-KR')}건 ${direction(orders.delta)}했습니다.`,
    observations: [
      { id: 'comparison.sessions', statement: `방문 세션: 직전 ${Number(sessions.previous || 0).toLocaleString('ko-KR')}건 → 현재 ${Number(sessions.current || 0).toLocaleString('ko-KR')}건 (${Number(sessions.delta || 0) >= 0 ? '+' : ''}${Number(sessions.delta || 0).toLocaleString('ko-KR')}건)` },
      { id: 'comparison.orders', statement: `주문 완료: 직전 ${Number(orders.previous || 0).toLocaleString('ko-KR')}건 → 현재 ${Number(orders.current || 0).toLocaleString('ko-KR')}건 (${Number(orders.delta || 0) >= 0 ? '+' : ''}${Number(orders.delta || 0).toLocaleString('ko-KR')}건)` },
      { id: 'comparison.risky', statement: `탐색 중지 신호 세션: 직전 ${Number(risky.previous || 0).toLocaleString('ko-KR')}건 → 현재 ${Number(risky.current || 0).toLocaleString('ko-KR')}건 (${Number(risky.delta || 0) >= 0 ? '+' : ''}${Number(risky.delta || 0).toLocaleString('ko-KR')}건)` },
    ],
  };
}

function verifiedKpis(plan, tools) {
  const rows = [];
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
  const result = await gemini(request);
  try {
    return parseAnswer(firstText(result));
  } catch (firstError) {
    const finishReason = result?.candidates?.[0]?.finishReason || 'UNKNOWN';
    console.warn(`[ops-agent] Gemini JSON 재생성: ${finishReason} / ${firstError.message}`);
    const retry = await gemini({
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
    narrative.actions = [
      "홈 화면 첫 화면과 대표 상품 영역의 배치·버튼 연결을 우선 확인하세요. 캡처가 생성되면 종료 신호가 표시된 위치를 기준으로 수정 대상을 다시 좁힙니다.",
    ];
    narrative.kpis = [];
  }
  const comparison = plan.response_mode === 'period_comparison' ? comparisonAnswer(built.tools) : null;
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
    kpis: comparison ? [] : verifiedKpis(plan, built.tools),
    caveats: [...new Set([
      ...narrative.caveats,
      ...toolNotes.filter((note) => /없|못|초과|녹화가 아닙니다/.test(note)),
    ])].slice(0, 2),
    visuals: (built.tools.get_visual_exit_hotspots?.captures || []).slice(0, 2),
  };
  return {
    answer,
    used_tools: usedTools,
    source,
    period: built.period,
    plan,
    snapshot: {
      id: built.id,
      as_of: built.as_of,
      period: { startDate: plan.period.startDate, endDate: plan.period.endDate },
      metric_digest: built.metric_digest,
    },
  };
}

module.exports = { agentProfile, answerQuestion, periodForDays: daysPeriod, samePeriod, decideAsOf };
