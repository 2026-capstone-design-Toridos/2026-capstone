/**
 * integration.test.js
 *
 * A + B + C 세 모듈을 함께 초기화한 상태에서
 * 실제 DOM 이벤트 발화 → emit → core → sender 전체 경로를 검증.
 *
 * SDK-A_test.js 와의 차이:
 *   SDK-A_test.js → A 내부 로직 단위 테스트 (sdkA.emit 직접 호출)
 *   integration.test.js → B/C 이벤트 리스너가 DOM 이벤트를 받아
 *                          A core를 통해 올바른 이벤트를 서버로 내보내는지 검증
 */

import { strict as assert } from 'node:assert';
import { spawnSync }        from 'node:child_process';
import { test }             from 'node:test';

const REPO_ROOT = '/Users/parkjoehyun/Desktop/software/4grade/2026-capstone';
const DEBUG_INTEGRATION_TEST = process.env.DEBUG_INTEGRATION_TEST === '1';

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 러너
// ─────────────────────────────────────────────────────────────────────────────

function run(body) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `${prelude()}\n${body}`],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  );
  if (DEBUG_INTEGRATION_TEST && result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (DEBUG_INTEGRATION_TEST && result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error(`No JSON output from scenario. STDOUT:\n${result.stdout}`);
  }
  return JSON.parse(lastLine);
}

// ─────────────────────────────────────────────────────────────────────────────
// 통합 테스트 prelude  (매 테스트마다 새 subprocess에서 실행)
// ─────────────────────────────────────────────────────────────────────────────

function prelude() {
  return String.raw`
// ── 타이머 / 시각 ──────────────────────────────────────────────
const state = {
  now: 0,
  nextTimerId: 1,
  timers: new Map(),
  listeners: new Map(),
  fetchCalls: [],
  beaconCalls: [],
  randomUuidSeq: 1,
  beaconResult: true,
};

Date.now = () => state.now;

globalThis.setTimeout = (cb, delay) => {
  const id = state.nextTimerId++;
  state.timers.set(id, { cb, dueAt: state.now + delay });
  return id;
};
globalThis.clearTimeout = (id) => state.timers.delete(id);

function advance(ms) {
  state.now += ms;
  let fired;
  do {
    fired = [...state.timers.entries()]
      .filter(([, t]) => t.dueAt <= state.now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0]);
    for (const [id, t] of fired) { state.timers.delete(id); t.cb(); }
  } while (fired.length > 0);
}

// ── RAF (비동기로 동작하도록 큐 방식 사용) ──────────────────────
const _rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { _rafQueue.push(cb); return _rafQueue.length; };
function flushRAF() {
  const cbs = [..._rafQueue]; _rafQueue.length = 0;
  for (const cb of cbs) cb();
}

// ── DOM Element 모크 ────────────────────────────────────────────
class Element {
  constructor(tagName, props = {}) {
    this.tagName = (tagName || 'div').toUpperCase();
    this.id       = props.id        || '';
    this.className = props.className || '';
    this.dataset  = props.dataset   || {};
    this.value    = props.value  !== undefined ? String(props.value) : '';
    this.name     = props.name   || '';
    this.type     = props.type   || '';
    this.innerText = props.innerText || '';
    this.src      = props.src    || '';
    this.duration = props.duration || 0;
    this.currentTime = props.currentTime || 0;
  }
  closest(selector) {
    for (const s of selector.split(',').map(x => x.trim())) {
      if (this._match(s)) return this;
    }
    return null;
  }
  matches(selector) {
    return selector.split(',').some(s => this._match(s.trim()));
  }
  _match(sel) {
    const tag = this.tagName.toLowerCase();
    if (sel === tag) return true;
    if (sel === '[data-ghost-role]' && this.dataset.ghostRole) return true;
    if (sel === "[role='button']" && this.dataset.role === 'button') return true;
    const ghostRole = sel.match(/^\[data-ghost-role="([^"]+)"\]$/);
    if (ghostRole) return this.dataset.ghostRole === ghostRole[1];
    if (sel === 'input[type="search"]')    return tag === 'input' && this.type === 'search';
    if (sel === 'input[role="searchbox"]') return tag === 'input' && this.dataset.role === 'searchbox';
    if (sel === '[role="searchbox"]')      return this.dataset.role === 'searchbox';
    if (sel === '[data-ghost-role="search-input"]') return this.dataset.ghostRole === 'search-input';
    return false;
  }
}
class HTMLInputElement    extends Element { constructor(p={}) { super('input',    { type: 'text', ...p }); } }
class HTMLTextAreaElement extends Element { constructor(p={}) { super('textarea', p); } }
class HTMLSelectElement   extends Element { constructor(p={}) { super('select',   p); } }
class HTMLVideoElement    extends Element { constructor(p={}) { super('video',    p); } }

globalThis.Element            = Element;
globalThis.HTMLInputElement   = HTMLInputElement;
globalThis.HTMLTextAreaElement= HTMLTextAreaElement;
globalThis.HTMLSelectElement  = HTMLSelectElement;
globalThis.HTMLVideoElement   = HTMLVideoElement;

// ── IntersectionObserver 모크 ────────────────────────────────────
const _ioInstances = [];
class IntersectionObserver {
  constructor(cb, opts) {
    this._cb = cb; this._opts = opts; this._observed = [];
    _ioInstances.push(this);
  }
  observe(el) { this._observed.push(el); }
  unobserve(el) { this._observed = this._observed.filter(e => e !== el); }
  // 테스트에서 직접 intersection 상태를 주입
  trigger(el, isIntersecting, ratio = 0.5) {
    this._cb([{ target: el, isIntersecting, intersectionRatio: isIntersecting ? ratio : 0 }]);
  }
}
globalThis.IntersectionObserver = IntersectionObserver;

// ── 이벤트 시스템 ────────────────────────────────────────────────
function addListener(type, handler) {
  if (!state.listeners.has(type)) state.listeners.set(type, []);
  state.listeners.get(type).push(handler);
}
function fireEvent(type, data = {}) {
  const ev = { type, ...data };
  for (const h of (state.listeners.get(type) || [])) h(ev);
}

// ── DOM 테스트용 섹션/서브섹션 요소 (initC 전에 준비) ──────────
const _testSection    = new Element('div', { dataset: { section: 'hero' } });
const _testSubsection = new Element('div', { dataset: { subsection: 'price-box' } });
const _domSections    = [_testSection];
const _domSubsections = [_testSubsection];

// ── 나머지 브라우저 API 모크 ─────────────────────────────────────
const storage = new Map();
const localStorageMock = {
  getItem(k)     { return storage.has(k) ? storage.get(k) : null; },
  setItem(k, v)  { storage.set(String(k), String(v)); },
  removeItem(k)  { storage.delete(k); },
  clear()        { storage.clear(); },
};

const windowMock = {
  location: {
    href: 'https://shop.test/product?utm_source=ad&utm_campaign=summer',
    pathname: '/product',
    search: '?utm_source=ad&utm_campaign=summer',
  },
  innerWidth: 1440, innerHeight: 500, scrollY: 0,
  __GT: {},
  addEventListener: addListener,
  dispatchEvent(ev) { fireEvent(ev.type, ev); return true; },
};

const documentMock = {
  readyState: 'complete',
  referrer:   'https://shop.test/',
  hidden:     false,
  body:       { scrollHeight: 2000 },   // docHeight = 2000 - 500 = 1500
  addEventListener:    addListener,
  removeEventListener() {},
  dispatchEvent(ev) { fireEvent(ev.type, ev); return true; },
  querySelectorAll(sel) {
    if (sel === '[data-section]')    return _domSections;
    if (sel === '[data-subsection]') return _domSubsections;
    return { forEach() {} };
  },
};

const historyMock = {
  pushState(_s, _t, url) {
    if (typeof url === 'string') {
      const p = url.startsWith('http') ? new URL(url).pathname : url;
      windowMock.location.pathname = p;
      windowMock.location.href = 'https://shop.test' + p;
    }
  },
  replaceState(_s, _t, url) {
    if (typeof url === 'string') {
      const p = url.startsWith('http') ? new URL(url).pathname : url;
      windowMock.location.pathname = p;
      windowMock.location.href = 'https://shop.test' + p;
    }
  },
};

Object.defineProperty(globalThis, 'window',      { value: windowMock,      configurable: true });
Object.defineProperty(globalThis, 'document',    { value: documentMock,    configurable: true });
Object.defineProperty(globalThis, 'history',     { value: historyMock,     configurable: true });
Object.defineProperty(globalThis, 'localStorage',{ value: localStorageMock,configurable: true });
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    sendBeacon(url, blob) { state.beaconCalls.push({ url, blob }); return state.beaconResult; },
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'crypto', {
  value: { randomUUID() { return 'uuid-' + state.randomUuidSeq++; } },
  configurable: true,
});
Object.defineProperty(globalThis, 'Blob', {
  value: class { constructor(p, o={}) { this.parts=p; this.type=o.type||''; } },
  configurable: true,
});
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, opts) => { state.fetchCalls.push({ url, opts }); return { ok: true }; },
  configurable: true,
});

// ── SDK 모듈 import & 초기화 ─────────────────────────────────────
const base = new URL('file:///Users/parkjoehyun/Desktop/software/4grade/2026-capstone/');
const sdkA   = await import(new URL('./sdk-A.js',     base));
const sdkB   = await import(new URL('./sdk-B.js',     base));
const sdkC   = await import(new URL('./sdk-C.js',     base));
const sender = await import(new URL('./core/sender.js', base));

sdkA.initA();               // 1. Core Engine
sdkB.initB(sdkA.emit);      // 2. B: DOM 이벤트 리스너 등록
sdkC.initC(sdkA.emit);      // 3. C: 스크롤/섹션/이커머스 리스너 등록

// 초기화 이벤트 제거 (session_start 등)
sender.flush(false);
state.fetchCalls.length = 0;

// ── 헬퍼 ─────────────────────────────────────────────────────────
function getEvents() {
  sender.flush(false);
  const evts = state.fetchCalls.flatMap(c => JSON.parse(c.opts.body).events);
  state.fetchCalls.length = 0;
  return evts;
}

function scroll(y) {
  windowMock.scrollY = y;
  fireEvent('scroll');
  flushRAF();
}

globalThis.__it = {
  state, advance, fireEvent, flushRAF, getEvents, scroll,
  sender, sdkA, sdkB, sdkC,
  windowMock, documentMock,
  _ioInstances, _testSection, _testSubsection,
  Element, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement,
};
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── sdk-B 통합 테스트
// ─────────────────────────────────────────────────────────────────────────────

test('[B] click event reaches core with session_id, event_seq, event_token', () => {
  const result = run(`
const it = globalThis.__it;

const btn = new Element('button', { id: 'buy-btn' });
fireEvent('click', { target: btn, clientX: 120, clientY: 240 });
const events = getEvents();
const click = events.find(e => e.event_type === 'click');
console.log(JSON.stringify({
  hasClick:     !!click,
  x:            click?.data?.click_position?.x,
  y:            click?.data?.click_position?.y,
  hasSessionId: !!click?.session_id,
  eventSeq:     click?.event_seq,
  eventToken:   click?.event_token,
  clickTarget:  click?.data?.click_target,
}));
`);

  assert.ok(result.hasClick,              'click 이벤트 emit됨');
  assert.equal(result.x, 120,             'clientX 전달됨');
  assert.equal(result.y, 240,             'clientY 전달됨');
  assert.ok(result.hasSessionId,          'session_id 자동 부여됨');
  assert.ok(result.eventSeq > 0,          'event_seq 자동 부여됨');
  assert.equal(result.eventToken, 10,     'click 토큰 = 10');
  assert.ok(result.clickTarget,           'click_target 포함됨');
});


test('[B] tab_exit and tab_return carry duration', () => {
  const result = run(`
const it = globalThis.__it;

documentMock.hidden = true;
fireEvent('visibilitychange');
advance(4_000);
documentMock.hidden = false;
fireEvent('visibilitychange');
const events = getEvents();
const tabExit   = events.find(e => e.event_type === 'tab_exit');
const tabReturn = events.find(e => e.event_type === 'tab_return');
console.log(JSON.stringify({
  tabExitCount:    tabExit?.data?.tab_exit_count,
  tabReturnMs:     tabReturn?.data?.tab_exit_duration_ms,
  exitToken:       tabExit?.event_token,
  returnToken:     tabReturn?.event_token,
}));
`);

  assert.equal(result.tabExitCount,  1,  'tab_exit_count = 1');
  assert.equal(result.tabReturnMs,   4000,'tab_exit_duration_ms = 4000');
  assert.equal(result.exitToken,     30, 'tab_exit 토큰 = 30');
  assert.equal(result.returnToken,   31, 'tab_return 토큰 = 31');
});

test('[B] input_change carries form meta and length', () => {
  const result = run(`
const it = globalThis.__it;

const input = new HTMLInputElement({ name: 'email', type: 'email', value: 'hello@' });
fireEvent('input', { target: input });
const events = getEvents();
const ev = events.find(e => e.event_type === 'input_change');
console.log(JSON.stringify({
  hasEvent:    !!ev,
  inputType:   ev?.data?.input_type,
  inputName:   ev?.data?.input_name,
  inputLength: ev?.data?.input_length,
  token:       ev?.event_token,
}));
`);

  assert.ok(result.hasEvent,               'input_change 이벤트 emit됨');
  assert.equal(result.inputType,   'email', 'input_type 전달됨');
  assert.equal(result.inputName,   'email', 'input_name 전달됨');
  assert.equal(result.inputLength, 6,       'input_length = 6');
  assert.equal(result.token,       40,      'input_change 토큰 = 40');
});

test('[B] blur on empty input emits both field_blur and input_abandon', () => {
  const result = run(`
const it = globalThis.__it;

const input = new HTMLInputElement({ name: 'coupon', type: 'text', value: '' });
fireEvent('blur', { target: input });
const events = getEvents();
console.log(JSON.stringify({
  hasFieldBlur:    events.some(e => e.event_type === 'field_blur'),
  hasInputAbandon: events.some(e => e.event_type === 'input_abandon'),
  blurToken:       events.find(e => e.event_type === 'field_blur')?.event_token,
  abandonToken:    events.find(e => e.event_type === 'input_abandon')?.event_token,
}));
`);

  assert.ok(result.hasFieldBlur,          'field_blur emit됨');
  assert.ok(result.hasInputAbandon,       'input_abandon emit됨 (value 비어 있음)');
  assert.equal(result.blurToken,   42,    'field_blur 토큰 = 42');
  assert.equal(result.abandonToken, 43,   'input_abandon 토큰 = 43');
});

test('[B] hover_dwell fires after 300ms, not before', () => {
  const result = run(`
const it = globalThis.__it;

const card = new Element('div', { id: 'product-card', dataset: { ghostRole: 'product-card' } });

// 짧은 hover (200ms) → emit 안 됨
fireEvent('mouseover', { target: card });
advance(200);
fireEvent('mouseout', { target: card });
const shortEvents = getEvents();

// 긴 hover (500ms) → emit됨
fireEvent('mouseover', { target: card });
advance(500);
fireEvent('mouseout', { target: card });
const longEvents = getEvents();

console.log(JSON.stringify({
  shortDwellCount: shortEvents.filter(e => e.event_type === 'hover_dwell').length,
  longDwellCount:  longEvents.filter(e => e.event_type === 'hover_dwell').length,
  dwellMs:         longEvents.find(e => e.event_type === 'hover_dwell')?.data?.hover_dwell_time_ms,
  token:           longEvents.find(e => e.event_type === 'hover_dwell')?.event_token,
}));
`);

  assert.equal(result.shortDwellCount, 0,   '200ms hover → emit 안 됨');
  assert.equal(result.longDwellCount,  1,   '500ms hover → emit됨');
  assert.ok(result.dwellMs >= 300,          'dwell_time_ms ≥ 300');
  assert.equal(result.token, 21,            'hover_dwell 토큰 = 21');
});

test('[B] search_use fires after 300ms debounce on input[type=search]', () => {
  const result = run(`
const it = globalThis.__it;

const search = new HTMLInputElement({ type: 'search', value: 'sneakers' });

// 300ms 전에 flush → emit 없음
fireEvent('input', { target: search });
advance(100);
const beforeEvents = getEvents();

// 300ms 경과 → debounce 발화
advance(200);
const afterEvents = getEvents();

console.log(JSON.stringify({
  beforeCount: beforeEvents.filter(e => e.event_type === 'search_use').length,
  afterCount:  afterEvents.filter(e => e.event_type === 'search_use').length,
  searchLen:   afterEvents.find(e => e.event_type === 'search_use')?.data?.search_length,
  token:       afterEvents.find(e => e.event_type === 'search_use')?.event_token,
}));
`);

  assert.equal(result.beforeCount, 0,      '300ms 전 → emit 없음');
  assert.equal(result.afterCount,  1,      '300ms 후 → search_use emit됨');
  assert.equal(result.searchLen,   8,      'search_length = 8 ("sneakers")');
  assert.equal(result.token,       45,     'search_use 토큰 = 45');
});

// ─────────────────────────────────────────────────────────────────────────────
// ── sdk-C 통합 테스트
// ─────────────────────────────────────────────────────────────────────────────

test('[C] scroll_depth and scroll_stop emit correctly', () => {
  const result = run(`
const it = globalThis.__it;

scroll(0);           // 첫 번째 스크롤 (isFirstScroll 소비, 이벤트 없음)
scroll(150);         // 10% → scroll_depth emit
advance(400);        // scroll_stop 타이머 발화 (300ms)
const events = getEvents();
const depth = events.find(e => e.event_type === 'scroll_depth');
const stop  = events.find(e => e.event_type === 'scroll_stop');
console.log(JSON.stringify({
  depthPct:   depth?.data?.depth_pct,
  depthToken: depth?.event_token,
  hasStop:    !!stop,
  stopToken:  stop?.event_token,
  stopPos:    stop?.data?.position,
}));
`);

  assert.equal(result.depthPct,   10,     'scroll_depth = 10%');
  assert.equal(result.depthToken, 60,     'scroll_depth 토큰 = 60');
  assert.ok(result.hasStop,               'scroll_stop emit됨');
  assert.equal(result.stopToken,  62,     'scroll_stop 토큰 = 62');
  assert.equal(result.stopPos,    150,    'scroll_stop position = 150');
});

test('[C] scroll_milestone fires at 25% and 50%', () => {
  const result = run(`
const it = globalThis.__it;

scroll(0);    // 첫 스크롤 소비
scroll(375);  // 375/1500 = 25%
scroll(750);  // 750/1500 = 50%
const events = getEvents();
const milestones = events.filter(e => e.event_type === 'scroll_milestone')
                         .map(e => e.data.milestone);
console.log(JSON.stringify({ milestones, token: events.find(e => e.event_type === 'scroll_milestone')?.event_token }));
`);

  assert.ok(result.milestones.includes(25), 'milestone 25 emit됨');
  assert.ok(result.milestones.includes(50), 'milestone 50 emit됨');
  assert.equal(result.token, 61,            'scroll_milestone 토큰 = 61');
});

test('[C] scroll_direction_change fires when direction reverses', () => {
  const result = run(`
const it = globalThis.__it;

scroll(0);    // 첫 스크롤 소비
scroll(300);  // down
scroll(100);  // up → direction_change (down → up)
const events = getEvents();
const change = events.find(e => e.event_type === 'scroll_direction_change');
console.log(JSON.stringify({
  hasChange: !!change,
  from:      change?.data?.from,
  to:        change?.data?.to,
  token:     change?.event_token,
}));
`);

  assert.ok(result.hasChange,           'scroll_direction_change emit됨');
  assert.equal(result.from, 'down',     'from = down');
  assert.equal(result.to,   'up',       'to = up');
  assert.equal(result.token, 63,        'scroll_direction_change 토큰 = 63');
});

test('[C] section_enter and section_exit via IntersectionObserver', () => {
  const result = run(`
const it = globalThis.__it;

// 섹션 IntersectionObserver 찾기 (data-section 요소를 observe한 것)
const sectionIO = _ioInstances.find(io => io._observed.some(el => el.dataset?.section));

// 진입 (ratio 0.5 > threshold 0.3)
sectionIO.trigger(_testSection, true, 0.5);
// 이탈
sectionIO.trigger(_testSection, false, 0);

const events = getEvents();
const enter = events.find(e => e.event_type === 'section_enter');
const exit  = events.find(e => e.event_type === 'section_exit');
console.log(JSON.stringify({
  enterSection: enter?.data?.section,
  exitSection:  exit?.data?.section,
  enterToken:   enter?.event_token,
  exitToken:    exit?.event_token,
}));
`);

  assert.equal(result.enterSection, 'hero', 'section_enter section = hero');
  assert.equal(result.exitSection,  'hero', 'section_exit section = hero');
  assert.equal(result.enterToken,   70,     'section_enter 토큰 = 70');
  assert.equal(result.exitToken,    71,     'section_exit 토큰 = 71');
});

test('[C] section_revisit fires on second entry', () => {
  const result = run(`
const it = globalThis.__it;
const io = _ioInstances.find(io => io._observed.some(el => el.dataset?.section));

io.trigger(_testSection, true, 0.5);   // 첫 진입
io.trigger(_testSection, false, 0);    // 이탈
io.trigger(_testSection, true, 0.5);   // 재진입
const events = getEvents();
console.log(JSON.stringify({
  revisitCount: events.filter(e => e.event_type === 'section_revisit').length,
  count:        events.find(e => e.event_type === 'section_revisit')?.data?.count,
  token:        events.find(e => e.event_type === 'section_revisit')?.event_token,
}));
`);

  assert.equal(result.revisitCount, 1,    'section_revisit 1회 emit됨');
  assert.equal(result.count,        2,    'count = 2 (두 번째 방문)');
  assert.equal(result.token,        72,   'section_revisit 토큰 = 72');
});

test('[C] product_click via data-ghost-role click', () => {
  const result = run(`
const it = globalThis.__it;

const card = new Element('div', {
  dataset: { ghostRole: 'product-card', productId: 'SKU-001', productName: '운동화' },
});
fireEvent('click', { target: card, clientX: 50, clientY: 50 });
const events = getEvents();
const ev = events.find(e => e.event_type === 'product_click');
console.log(JSON.stringify({
  hasEvent:    !!ev,
  productId:   ev?.data?.product_id,
  token:       ev?.event_token,
}));
`);

  assert.ok(result.hasEvent,              'product_click emit됨');
  assert.equal(result.productId, 'SKU-001','product_id 전달됨');
  assert.equal(result.token, 80,          'product_click 토큰 = 80');
});

test('[C] add_to_cart click → A tracks cart → cart_abandon_flag on session_end', () => {
  const result = run(`
const it = globalThis.__it;

const addBtn = new Element('button', {
  dataset: { ghostRole: 'add-to-cart', productId: 'SKU-001' },
});
fireEvent('click', { target: addBtn, clientX: 0, clientY: 0 });
getEvents(); // flush

// 비콘 실패 시 fetch fallback 확인
state.beaconResult = false;
windowMock.dispatchEvent({ type: 'beforeunload' });

const fetchCalls = state.fetchCalls.map(c => JSON.parse(c.opts.body));
const events = fetchCalls.flatMap(b => b.events);
const abandon = events.find(e => e.event_type === 'cart_abandon_flag');
console.log(JSON.stringify({
  hasAbandon:     !!abandon,
  cartItemCount:  abandon?.data?.cart_item_count,
  abandonToken:   abandon?.event_token,
}));
`);

  assert.ok(result.hasAbandon,              'cart_abandon_flag emit됨');
  assert.equal(result.cartItemCount, 1,     'cart_item_count = 1');
  assert.equal(result.abandonToken,  85,    'cart_abandon_flag 토큰 = 85');
});

test('[C] option_select change event carries option data', () => {
  const result = run(`
const it = globalThis.__it;

const select = new HTMLSelectElement({
  name: 'size',
  value: 'L',
  dataset: { ghostRole: 'option-select', productId: 'SKU-001' },
});
fireEvent('change', { target: select });
const events = getEvents();
const ev = events.find(e => e.event_type === 'option_select');
console.log(JSON.stringify({
  hasEvent:   !!ev,
  optionName: ev?.data?.option_name,
  optionVal:  ev?.data?.option_value,
  token:      ev?.event_token,
}));
`);

  assert.ok(result.hasEvent,              'option_select emit됨');
  assert.equal(result.optionName, 'size', 'option_name 전달됨');
  assert.equal(result.optionVal,  'L',    'option_value 전달됨');
  assert.equal(result.token, 81,          'option_select 토큰 = 81');
});

// ─────────────────────────────────────────────────────────────────────────────
// ── 전체 스택 통합 테스트 (A + B + C 연동)
// ─────────────────────────────────────────────────────────────────────────────

test('[FULL] B click → rage_click derived by A', () => {
  const result = run(`
const it = globalThis.__it;

const btn = new Element('button', { id: 'buy' });
// ±20px 범위 3회 클릭, 500ms 이내
advance(100); fireEvent('click', { target: btn, clientX: 200, clientY: 300 });
advance(100); fireEvent('click', { target: btn, clientX: 204, clientY: 297 });
advance(100); fireEvent('click', { target: btn, clientX: 197, clientY: 303 });
const events = getEvents();
console.log(JSON.stringify({
  clickCount:    events.filter(e => e.event_type === 'click').length,
  rageCount:     events.filter(e => e.event_type === 'rage_click').length,
  rageClickData: events.find(e => e.event_type === 'rage_click')?.data,
}));
`);

  assert.equal(result.clickCount, 3,        '3개 click 이벤트');
  assert.equal(result.rageCount,  1,        '1개 rage_click 이벤트');
  assert.equal(result.rageClickData.click_count, 3, 'rage click_count = 3');
});

test('[FULL] first B click triggers time_to_first_click derived event', () => {
  const result = run(`
const it = globalThis.__it;

advance(1_500);  // 페이지 진입 후 1.5초 경과
const btn = new Element('button', { id: 'cta' });
fireEvent('click', { target: btn, clientX: 10, clientY: 10 });
const events = getEvents();
const ttfc  = events.find(e => e.event_type === 'time_to_first_click');
const click = events.find(e => e.event_type === 'click');
console.log(JSON.stringify({
  ttfcMs:   ttfc?.data?.duration_ms,
  fromSeq:  ttfc?.data?.derived_from_seq,
  clickSeq: click?.event_seq,
  token:    ttfc?.event_token,
}));
`);

  assert.equal(result.ttfcMs,  1500,           'duration_ms = 1500');
  assert.equal(result.fromSeq, result.clickSeq,'derived_from_seq = click seq');
  assert.equal(result.token,   91,             'time_to_first_click 토큰 = 91');
});

test('[FULL] all B and C events carry session_id, event_seq, page_url', () => {
  const result = run(`
const it = globalThis.__it;

// B 이벤트들
const btn   = new Element('button', { id: 'x' });
const input = new HTMLInputElement({ name: 'q', type: 'text', value: 'abc' });
fireEvent('click',  { target: btn,   clientX: 0, clientY: 0 });
fireEvent('input',  { target: input });
fireEvent('blur',   { target: input });
documentMock.hidden = true; fireEvent('visibilitychange');
documentMock.hidden = false; fireEvent('visibilitychange');

// C 이벤트들
scroll(0); scroll(150); // scroll_depth

const io = _ioInstances.find(io => io._observed.some(el => el.dataset?.section));
io.trigger(_testSection, true, 0.5); // section_enter

const events = getEvents();
const bad = events.filter(e => !e.session_id || !e.event_seq || !e.page_url);
console.log(JSON.stringify({
  total:    events.length,
  badCount: bad.length,
  badTypes: bad.map(e => e.event_type),
}));
`);

  assert.equal(result.badCount, 0,
    `session_id/event_seq/page_url 없는 이벤트: ${JSON.stringify(result.badTypes)}`);
  assert.ok(result.total > 0, '이벤트가 최소 1개 이상 있어야 함');
});
