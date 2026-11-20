'use strict';

// 운영 액션 리포트 (대시보드 > 방문 분석 > 운영 액션 리포트)
//
// 외부 AI 없이 서버 안에서 바로 만드는 리포트다. 실제 고객 행동은 외부로 보내지 않는다.
//
// 예전 문장은 세 가지가 문제였다.
//   1) 일부러 로컬 요약을 쓰는데도 "AI 리포트 서버가 혼잡해 자동 요약" 이라고 적었다.
//   2) session start, exit bounce 같은 내부 이벤트 이름이 영어 그대로 노출됐다.
//   3) 무엇을 해야 하는지가 "점검하세요" 한 줄뿐이었다. (산학 멘토링 지적 사항)
//
// 지금은 리포트를 "근거 → 할 일 → 다음 주 확인 지표" 로 나눠 돌려준다.
// 할 일은 고객 유형별로 미리 정한 규칙에서 고르고, 근거는 실제 집계·행동 흐름에서 채운다.

// 수집 이벤트(소문자)와 의미 토큰 행동(대문자)을 운영자가 읽는 말로 바꾼다.
const ACTION_LABELS = {
  // 의미 토큰 행동
  START_SESSION: '쇼핑몰 방문',
  ENTER_HOME: '홈 화면 진입',
  ENTER_CATEGORY: '카테고리 진입',
  ENTER_PRODUCT: '상품 상세 진입',
  ENTER_CART: '장바구니 진입',
  ENTER_CHECKOUT: '주문서 진입',
  VIEW_PRODUCT: '상품 상세 확인',
  VIEW_SECTION: '상세 영역 확인',
  VIEW_IMAGE: '상품 이미지 확인',
  ZOOM_IMAGE: '상품 이미지 확대',
  WATCH_VIDEO: '상품 영상 시청',
  SCROLL_HOME: '홈 화면 스크롤',
  SCROLL_CATEGORY: '카테고리 목록 스크롤',
  SCROLL_PRODUCT: '상품 상세 스크롤',
  SCROLL_REVIEW: '리뷰 스크롤',
  SCROLL_PAGE: '페이지 스크롤',
  HOVER_ELEMENT: '버튼·메뉴 위에 머무름',
  CLICK_ELEMENT: '버튼·메뉴 클릭',
  RAGE_CLICK: '같은 곳 연속 클릭',
  SEARCH_USE: '상품 검색',
  CHECK_PRICE: '가격 확인',
  CHECK_SIZE: '사이즈 확인',
  CHECK_SHIPPING: '배송 정보 확인',
  VIEW_DETAIL: '상세정보 확인',
  VIEW_REVIEW: '리뷰 확인',
  EXPAND_REVIEW: '리뷰 펼쳐 보기',
  VIEW_QNA: '상품 문의 확인',
  CHANGE_OPTION: '옵션 변경',
  CHANGE_QUANTITY: '수량 변경',
  ADD_CART: '장바구니 담기',
  REMOVE_CART: '장바구니에서 빼기',
  CART_ABANDON: '장바구니 담은 뒤 이탈',
  CLICK_BUY: '구매 버튼 클릭',
  START_INPUT: '입력 시작',
  EDIT_INPUT: '입력 수정',
  ABANDON_INPUT: '입력 중 이탈',
  PRICE_REVIEW_EPISODE: '가격 반복 확인',
  REVIEW_EXPLORATION_EPISODE: '리뷰 반복 탐색',
  SIZE_CHECK_EPISODE: '사이즈 반복 확인',
  SHIPPING_CHECK_EPISODE: '배송 정보 반복 확인',
  DISTRACTED_EPISODE: '탭 이탈·무동작 반복',
  EXIT_SESSION: '탐색 종료',
  EXIT_BOUNCE: '바로 나감',
  INACTIVE: '움직임 없음',
  TAB_OUT: '다른 탭으로 이동',
  TAB_RETURN: '다시 돌아옴',
  // SDK 수집 이벤트
  session_start: '쇼핑몰 방문',
  session_end: '탐색 종료',
  page_view: '페이지 이동',
  enter_home: '홈 화면 진입',
  enter_category: '카테고리 진입',
  enter_product: '상품 상세 진입',
  enter_cart: '장바구니 진입',
  enter_checkout: '주문서 진입',
  product_click: '상품 클릭',
  click: '버튼·메뉴 클릭',
  rage_click: '같은 곳 연속 클릭',
  hover_dwell: '버튼·메뉴 위에 머무름',
  scroll_depth: '스크롤',
  scroll_stop: '스크롤 멈춤',
  section_enter: '상세 영역 확인',
  subsection_enter: '상세 영역 확인',
  search_use: '상품 검색',
  option_select: '옵션 선택',
  option_change: '옵션 변경',
  quantity_change: '수량 변경',
  review_click: '리뷰 확인',
  review_scroll: '리뷰 스크롤',
  review_image_click: '리뷰 사진 확인',
  image_zoom: '상품 이미지 확대',
  add_to_cart: '장바구니 담기',
  add_to_cart_success: '장바구니 담기',
  remove_from_cart: '장바구니에서 빼기',
  add_to_wishlist: '관심상품 담기',
  add_to_wishlist_success: '관심상품 담기',
  cart_abandon_flag: '장바구니 담은 뒤 이탈',
  purchase_click: '구매 버튼 클릭',
  checkout_start: '주문서 작성 시작',
  input_start: '입력 시작',
  input_abandon: '입력 중 이탈',
  order_complete: '주문 완료',
  guest_purchase: '비회원 주문 완료',
  tab_exit: '다른 탭으로 이동',
  tab_return: '다시 돌아옴',
  inactivity: '움직임 없음',
};

// 운영자에게 의미 없는 신호. 흐름·대표 행동 목록에서 뺀다.
const QUIET_ACTIONS = new Set([
  'HOVER_ELEMENT', 'hover_dwell', 'scroll_stop', 'TAB_RETURN', 'tab_return', 'page_view',
]);

// 방문 시작·종료 같은 수명주기 신호. 흐름에는 보여 주지만
// "대표 행동"과 "의미 있는 행동" 개수에서는 뺀다 (ml/model_contract.py 와 같은 기준).
const LIFECYCLE_ACTIONS = new Set([
  'START_SESSION', 'EXIT_SESSION', 'EXIT_BOUNCE', 'INACTIVE', 'TAB_OUT', 'TAB_RETURN', 'DISTRACTED_EPISODE',
  'session_start', 'session_end', 'inactivity', 'tab_exit', 'tab_return',
]);

function actionText(action) {
  return ACTION_LABELS[action] || ACTION_LABELS[String(action || '').toLowerCase()] || '';
}

// 같은 행동이 연달아 나오면 한 번만 쓰고, 이름을 모르는 행동은 뺀다.
function readableFlow(actions, limit = 6) {
  const out = [];
  for (const action of actions) {
    if (QUIET_ACTIONS.has(action)) continue;
    const label = actionText(action);
    if (!label || out[out.length - 1] === label) continue;
    out.push(label);
  }
  if (out.length <= limit) return out;
  return [...out.slice(0, limit - 2), '…', out[out.length - 1]];
}

// 고객 유형 이름 → 운영 액션 규칙
//
// 이름에 들어 있는 핵심어로 고른다. 분류 서버의 유형 이름(cluster_server.FORCED_CLUSTER_LABELS)이
// 조금 바뀌어도 맞도록 한 단어씩 본다. 위에서부터 먼저 맞는 규칙을 쓴다.
const PLAYBOOKS = [
  {
    key: 'completed',
    match: (name) => name.includes('주문을 완료'),
    diagnosis: '구매까지 끝까지 간 흐름입니다. 이 흐름이 다른 고객에게도 재현되게 만드는 것이 목표입니다.',
    actions: [
      { title: '구매 완료 동선을 기준선으로 삼기', how: '이 고객이 지나간 상품 → 장바구니 → 주문서 순서를 다른 상품 상세에도 같은 위치·문구로 맞춥니다.', metric: '장바구니 → 주문 완료 진행률' },
      { title: '주문서 입력 줄이기', how: '필수가 아닌 입력 칸은 접어 두고, 배송비·결제 혜택을 결제 버튼 바로 위에 다시 보여줍니다.', metric: '주문서 진입 후 이탈 비율' },
    ],
  },
  {
    key: 'insufficient',
    match: (name) => name.includes('정보 부족') || name.includes('데이터 부족') || name.includes('짧은 방문') || name.includes('판정 보류'),
    diagnosis: '방문은 있었지만 유형을 판단할 만큼 행동이 남지 않았습니다. 첫 화면에서 다음 행동으로 넘어가지 못했거나, 행동이 수집되지 않은 경우입니다.',
    actions: [
      { title: '첫 화면에 다음 행동 하나를 분명히', how: '홈·카테고리 첫 화면 상단에 대표 상품 3개와 "지금 많이 보는 상품" 버튼을 둡니다. 배너가 여러 개면 하나로 줄입니다.', metric: '바로 나감 비율' },
      { title: '수집 누락부터 확인', how: '상품 클릭·장바구니 담기를 직접 해 보고 대시보드 "방금 들어온 고객 행동"에 기록되는지 확인합니다. 안 보이면 SDK 설치 위치를 점검합니다.', metric: '행동 정보 부족형 비율' },
    ],
  },
  {
    key: 'review',
    match: (name) => name.includes('리뷰'),
    diagnosis: '구매 결정 전에 리뷰를 오래, 여러 번 확인합니다. 리뷰에서 확신을 얻지 못하면 그대로 나갑니다.',
    actions: [
      { title: '대표 리뷰를 상품 정보 바로 아래로', how: '사진 리뷰 2~3개와 "사이즈·착용감" 요약을 가격 아래에 고정해, 리뷰 탭까지 내려가지 않아도 보이게 합니다.', metric: '리뷰 확인 후 장바구니 담기 비율' },
      { title: '리뷰에 자주 나오는 불안 요소에 답하기', how: '"사이즈가 작다", "배송이 늦다" 같은 반복 내용을 상세 설명 FAQ로 먼저 답합니다.', metric: '리뷰 반복 탐색 세션 수' },
    ],
  },
  {
    key: 'price',
    match: (name) => name.includes('가격'),
    diagnosis: '상품 상세에서 가격을 여러 번 확인하고 비교합니다. 가격 대비 이유를 찾지 못하면 다른 상품이나 다른 쇼핑몰로 갑니다.',
    actions: [
      { title: '가격 옆에 "왜 이 가격인지" 한 줄', how: '할인 전 가격·적립금·무료배송 기준을 가격 바로 옆에 함께 보여줍니다. 쿠폰이 있으면 적용가를 먼저 씁니다.', metric: '가격 확인 후 장바구니 담기 비율' },
      { title: '비교 부담 줄이기', how: '같은 카테고리의 비슷한 가격대 상품 2개를 상세 하단 "함께 비교" 영역에 묶어 보여줍니다.', metric: '가격 반복 확인 세션 수' },
    ],
  },
  {
    key: 'interaction',
    match: (name) => name.includes('구매 시도') || name.includes('상호작용') || name.includes('결제'),
    diagnosis: '옵션·장바구니·구매 버튼까지 눌러 볼 만큼 의도가 강합니다. 마지막 단계에서 멈추는 이유를 없애면 바로 매출로 이어지는 유형입니다.',
    actions: [
      { title: '장바구니 → 주문서 단계 막힘 제거', how: '장바구니에서 배송비·도착 예정일을 미리 보여주고, "바로 구매" 버튼을 장바구니 상단에도 둡니다.', metric: '장바구니 → 주문서 진입 비율' },
      { title: '담아 두고 나간 고객 다시 부르기', how: '장바구니에 담고 나간 회원에게 24시간 안에 한정 쿠폰 알림(카카오 알림톡·문자)을 보냅니다.', metric: '장바구니 담은 뒤 이탈 세션 수' },
    ],
  },
  {
    key: 'browse',
    match: (name) => name.includes('탐색') || name.includes('카테고리') || name.includes('훑어') || name.includes('비교'),
    diagnosis: '카테고리와 상품을 오가며 넓게 둘러보지만, 마음에 드는 상품을 찾기 전에 지칩니다.',
    actions: [
      { title: '카테고리 상단에 필터·정렬 노출', how: '가격대·사이즈·인기순 필터를 목록 맨 위에 펼쳐 두고, 기본 정렬을 판매량순으로 바꿉니다.', metric: '카테고리 진입 후 상품 상세 진입 비율' },
      { title: '본 상품 다시 찾기 쉽게', how: '"최근 본 상품" 바를 화면 하단에 고정해 여러 상품을 오가는 수고를 줄입니다.', metric: '상품 상세를 3개 이상 본 세션의 장바구니 비율' },
    ],
  },
];

const DEFAULT_PLAYBOOK = {
  key: 'default',
  diagnosis: '행동 패턴을 바탕으로 묶인 고객 유형입니다.',
  actions: [
    { title: '대표 행동이 일어난 화면 점검', how: '아래 대표 행동이 가장 많이 일어난 화면에서 다음 행동 버튼이 한눈에 보이는지 확인합니다.', metric: '해당 화면의 다음 단계 진행률' },
  ],
};

function playbookFor(typeName) {
  const name = String(typeName || '');
  return PLAYBOOKS.find((p) => p.match(name)) || DEFAULT_PLAYBOOK;
}

const PAGE_LABELS = {
  HOME: '홈', CATEGORY: '카테고리', PRODUCT: '상품 상세', CART: '장바구니',
  CHECKOUT: '주문서', SEARCH: '검색', REVIEW: '리뷰', UNKNOWN: '',
};

function topPages(pageDist = {}, limit = 2) {
  const entries = Object.entries(pageDist).filter(([, v]) => Number(v) > 0);
  const total = entries.reduce((sum, [, v]) => sum + Number(v), 0) || 1;
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([page, v]) => ({ label: PAGE_LABELS[page] ?? page, share: Math.round((Number(v) / total) * 100) }))
    .filter((p) => p.label)
    .slice(0, limit);
}

function topActionLabels(profile = {}, limit = 3) {
  const out = [];
  for (const item of profile.top_actions || []) {
    if (QUIET_ACTIONS.has(item.action) || LIFECYCLE_ACTIONS.has(item.action)) continue;
    const label = actionText(item.action);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= limit) break;
  }
  return out;
}

const NO_STATS_NOTICE = '이 쇼핑몰의 고객 유형 집계가 아직 없어 유형 통계는 빼고 보여드립니다. (대시보드에서 "최신 데이터로 다시 분류" 후 표시)';

function toText(report) {
  const lines = [report.headline, '', `진단 · ${report.diagnosis}`];
  if (report.evidence.length) {
    lines.push('', '근거');
    for (const e of report.evidence) lines.push(`· ${e}`);
  }
  lines.push('', '이번 주 할 일');
  report.actions.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.title}`, `   ${a.how}`, `   확인 지표: ${a.metric}`);
  });
  if (report.note) lines.push('', report.note);
  return lines.join('\n');
}

// 유형 리포트: 이 유형 전체를 어떻게 다룰지
function buildClusterActionReport({ clusterId, typeName, profile = {}, totalSessions = 0, statsAvailable = true }) {
  const name = typeName || `고객 유형 ${clusterId}`;
  const playbook = playbookFor(name);
  const evidence = [];
  const count = Number(profile.count) || 0;
  if (count) {
    const share = totalSessions ? ` (전체 방문의 ${Math.round((count / totalSessions) * 100)}%)` : '';
    evidence.push(`이 유형으로 분류된 방문 ${count.toLocaleString('ko-KR')}건${share}`);
  }
  const actions = topActionLabels(profile);
  if (actions.length) evidence.push(`대표 행동: ${actions.join(', ')}`);
  const pages = topPages(profile.page_dist);
  if (pages.length) evidence.push(`주로 머문 화면: ${pages.map((p) => `${p.label} ${p.share}%`).join(', ')}`);
  if (!statsAvailable) evidence.push(NO_STATS_NOTICE);

  const report = {
    kind: 'cluster',
    headline: `${name} — 운영 액션`,
    diagnosis: playbook.diagnosis,
    evidence,
    actions: playbook.actions,
    playbook: playbook.key,
    note: '할 일은 이 유형의 행동 규칙에서 고른 제안입니다. 적용한 뒤 다음 주 같은 화면에서 확인 지표를 비교하세요.',
  };
  return { ...report, text: toText(report) };
}

// 고객 리포트: 선택한 방문 한 건을 어떻게 볼지
function buildSessionActionReport({ persona, events = [], profile = {}, completed = false, statsAvailable = true }) {
  const name = completed ? '주문을 완료한 고객' : (persona || '고객');
  const playbook = playbookFor(name);
  const types = events.map((e) => e.event_type || e.action).filter(Boolean);
  const flow = readableFlow(types);
  const evidence = [];
  if (flow.length) evidence.push(`이번 방문 흐름: ${flow.join(' → ')}`);
  const meaningful = types.filter((t) => actionText(t) && !QUIET_ACTIONS.has(t) && !LIFECYCLE_ACTIONS.has(t)).length;
  evidence.push(`기록된 행동 ${types.length}개 중 의미 있는 행동 ${meaningful}개`);
  const endings = new Set(['…', '탐색 종료', '바로 나감', '움직임 없음', '다른 탭으로 이동']);
  const last = flow.filter((x) => !endings.has(x)).slice(-1)[0];
  if (last && !completed) evidence.push(`마지막으로 한 행동: ${last}`);
  const typical = topActionLabels(profile);
  if (typical.length) evidence.push(`같은 유형 고객의 대표 행동: ${typical.join(', ')}`);
  if (!statsAvailable) evidence.push(NO_STATS_NOTICE);

  const report = {
    kind: 'session',
    headline: `${persona || name} — 이 방문에서 볼 점`,
    diagnosis: playbook.diagnosis,
    evidence,
    actions: playbook.actions.slice(0, 2),
    playbook: playbook.key,
    note: '고객 한 명의 방문만 보고 화면을 바꾸지 마세요. 같은 유형 리포트의 방문 수와 함께 판단하세요.',
  };
  return { ...report, text: toText(report) };
}

module.exports = {
  ACTION_LABELS,
  actionText,
  readableFlow,
  playbookFor,
  buildClusterActionReport,
  buildSessionActionReport,
};
