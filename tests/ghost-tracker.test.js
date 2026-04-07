import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const REPO_ROOT = '/Users/parkjoehyun/Desktop/software/4grade/2026-capstone';

function runScenario(body) {
  const script = `${createPrelude()}
${body}`;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`scenario failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return JSON.parse(result.stdout.trim());
}

function createPrelude() {
  return String.raw`
const state = {
  now: 0,
  nextTimerId: 1,
  timers: new Map(),
  listeners: new Map(),
  fetchCalls: [],
  beaconCalls: [],
  randomUuidSeq: 1,
  beaconResult: true,
  historyStack: ['/product'],
  historyIndex: 0,
};

class BlobMock {
  constructor(parts, options = {}) {
    this.parts = parts;
    this.type = options.type || '';
  }
}

const storage = new Map();

const localStorageMock = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(String(key), String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

function addListener(type, handler) {
  if (!state.listeners.has(type)) state.listeners.set(type, []);
  state.listeners.get(type).push(handler);
}

function dispatch(type) {
  for (const handler of state.listeners.get(type) || []) {
    handler({ type });
  }
}

const windowMock = {
  location: {
    href: 'https://shop.test/product?utm_source=ad&utm_campaign=summer',
    pathname: '/product',
    search: '?utm_source=ad&utm_campaign=summer',
  },
  innerWidth: 1440,
  scrollY: 0,
  addEventListener: addListener,
  dispatchEvent(event) {
    dispatch(event.type);
    return true;
  },
};

const documentMock = {
  readyState: 'complete',
  referrer: 'https://shop.test/',
  addEventListener: addListener,
  removeEventListener() {},
};

const historyMock = {
  pushState(_state, _title, url) {
    if (typeof url === 'string') {
      const nextPath = url.startsWith('http') ? new URL(url).pathname : url;
      windowMock.location.pathname = nextPath;
      windowMock.location.href = 'https://shop.test' + nextPath;
      windowMock.location.search = new URL(windowMock.location.href).search;
      state.historyStack = state.historyStack.slice(0, state.historyIndex + 1);
      state.historyStack.push(nextPath);
      state.historyIndex = state.historyStack.length - 1;
    }
  },
  replaceState(_state, _title, url) {
    if (typeof url === 'string') {
      const nextPath = url.startsWith('http') ? new URL(url).pathname : url;
      windowMock.location.pathname = nextPath;
      windowMock.location.href = 'https://shop.test' + nextPath;
      windowMock.location.search = new URL(windowMock.location.href).search;
      state.historyStack[state.historyIndex] = nextPath;
    }
  },
  back() {
    if (state.historyIndex > 0) {
      state.historyIndex -= 1;
      const nextPath = state.historyStack[state.historyIndex];
      windowMock.location.pathname = nextPath;
      windowMock.location.href = 'https://shop.test' + nextPath;
      windowMock.location.search = new URL(windowMock.location.href).search;
      dispatch('popstate');
    }
  },
};

Object.defineProperty(globalThis, 'window', { value: windowMock, configurable: true });
Object.defineProperty(globalThis, 'document', { value: documentMock, configurable: true });
Object.defineProperty(globalThis, 'history', { value: historyMock, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true });
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    sendBeacon(url, blob) {
      state.beaconCalls.push({ url, blob });
      return state.beaconResult;
    },
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID() {
      return 'uuid-' + state.randomUuidSeq++;
    },
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'Blob', { value: BlobMock, configurable: true });
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, options) => {
    state.fetchCalls.push({ url, options });
    return { ok: true, status: 200 };
  },
  configurable: true,
});

Date.now = () => state.now;

globalThis.setTimeout = (callback, delay) => {
  const id = state.nextTimerId++;
  state.timers.set(id, { callback, dueAt: state.now + delay });
  return id;
};

globalThis.clearTimeout = (id) => {
  state.timers.delete(id);
};

function advance(ms) {
  state.now += ms;
  let fired;
  do {
    fired = [...state.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= state.now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0]);
    for (const [id, timer] of fired) {
      state.timers.delete(id);
      timer.callback();
    }
  } while (fired.length > 0);
}

function takeFetchEvents() {
  return state.fetchCalls.map(({ url, options }) => ({
    url,
    options,
    payload: options && options.body ? JSON.parse(options.body) : null,
  }));
}

function takeBeaconPayloads() {
  return state.beaconCalls.map(({ url, blob }) => ({
    url,
    payload: blob.parts[0],
  }));
}

const repoUrl = new URL('file:///Users/parkjoehyun/Desktop/software/4grade/2026-capstone/');
const sessionManagerModule = await import(new URL('./core/sessionManager.js', repoUrl));
const timeTrackerModule = await import(new URL('./core/timeTracker.js', repoUrl));
const eventProcessorModule = await import(new URL('./core/eventProcessor.js', repoUrl));
const senderModule = await import(new URL('./core/sender.js', repoUrl));
const sdkAModule = await import(new URL('./sdk-A.js', repoUrl));

globalThis.__ghostTrackerTest = {
  state,
  advance,
  takeFetchEvents,
  takeBeaconPayloads,
  sessionManager: sessionManagerModule,
  timeTracker: timeTrackerModule,
  eventProcessor: eventProcessorModule,
  sender: senderModule,
  sdkA: sdkAModule,
};
`;
}

test('session manager reuses session within TTL', () => {
  const result = runScenario(`
const { sessionManager } = globalThis.__ghostTrackerTest;
const first = sessionManager.initSession();
state.now += 29 * 60 * 1000;
const second = sessionManager.initSession();
console.log(JSON.stringify({
  firstSessionId: first.session_id,
  secondSessionId: second.session_id,
  isNewSession: second.is_new_session,
  sessionCount: second.session_count,
}));
`);

  assert.equal(result.firstSessionId, result.secondSessionId);
  assert.equal(result.isNewSession, false);
  assert.equal(result.sessionCount, 1);
});

test('session ttl should follow last activity, not only load time', () => {
  const result = runScenario(`
const { sessionManager, eventProcessor } = globalThis.__ghostTrackerTest;
const first = sessionManager.initSession();
eventProcessor.emit('click', { target: 'buy', x: 100, y: 200 });
state.now += 25 * 60 * 1000;
eventProcessor.emit('click', { target: 'buy', x: 102, y: 202 });
state.now += 6 * 60 * 1000;
const second = sessionManager.initSession();
console.log(JSON.stringify({
  firstSessionId: first.session_id,
  secondSessionId: second.session_id,
  storedTs: localStorage.getItem('gt_sid_ts'),
}));
`);

  assert.equal(result.firstSessionId, result.secondSessionId);
});

test('first click emits time_to_first_click only once', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

state.now += 1200;
sdkA.emit('click', { target: 'buy', x: 100, y: 200 });
state.now += 200;
sdkA.emit('click', { target: 'buy', x: 101, y: 198 });
sender.flush(false);

const payloads = takeFetchEvents().map(entry => entry.payload.events);
console.log(JSON.stringify({ payloads }));
`);

  const events = result.payloads.flat();
  assert.equal(events.filter((event) => event.event_type === 'click').length, 2);
  assert.equal(events.filter((event) => event.event_type === 'time_to_first_click').length, 1);
  const click = events.find((event) => event.event_type === 'click');
  const ttfc = events.find((event) => event.event_type === 'time_to_first_click');
  assert.equal(ttfc.data.derived_from_seq, click.seq);
});

test('rage click fires once for three close clicks in 500ms', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

state.now += 100;
sdkA.emit('click', { target: 'buy', x: 200, y: 300 });
state.now += 120;
sdkA.emit('click', { target: 'buy', x: 205, y: 296 });
state.now += 120;
sdkA.emit('click', { target: 'buy', x: 198, y: 304 });
state.now += 120;
sdkA.emit('click', { target: 'buy', x: 201, y: 301 });

sender.flush(false);
console.log(JSON.stringify({ payloads: takeFetchEvents().map(entry => entry.payload.events) }));
`);

  const events = result.payloads.flat();
  assert.equal(events.filter((event) => event.event_type === 'rage_click').length, 1);
  const rage = events.find((event) => event.event_type === 'rage_click');
  assert.equal(rage.data.click_count, 3);
});

test('inactivity should not recursively reclassify itself as activity', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

advance(10_000);
sender.flush(false);
const firstBatch = takeFetchEvents().map(entry => entry.payload.events).flat();

state.fetchCalls.length = 0;
advance(10_000);
sender.flush(false);
const secondBatch = takeFetchEvents().map(entry => entry.payload.events).flat();

console.log(JSON.stringify({ firstBatch, secondBatch }));
`);

  assert.equal(result.firstBatch.filter((event) => event.event_type === 'inactivity').length, 1);
  assert.equal(result.secondBatch.filter((event) => event.event_type === 'inactivity').length, 0);
});

test('session_end should keep the last real user event time', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

state.now += 500;
sdkA.emit('add_to_cart', { product_id: 'SKU-001' });
state.now += 4500;
state.beaconResult = false;
window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const add = events.find((event) => event.event_type === 'add_to_cart');
const end = events.find((event) => event.event_type === 'session_end');
console.log(JSON.stringify({ addTimestamp: add.timestamp, sessionEndLastEventTime: end.data.last_event_time, events }));
`);

  assert.equal(result.sessionEndLastEventTime, result.addTimestamp);
});

test('iPad should be classified as tablet, not mobile', () => {
  const result = runScenario(`
navigator.userAgent = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const sessionStart = events.find((event) => event.event_type === 'session_start');
console.log(JSON.stringify({ deviceType: sessionStart.data.device_type }));
`);

  assert.equal(result.deviceType, 'tablet');
});

test('sender uses fetch for normal flush and sendBeacon for unload flush', () => {
  const result = runScenario(`
const { sender } = globalThis.__ghostTrackerTest;
sender.send({ event_type: 'one' });
sender.flush(false);
const normal = takeFetchEvents();

state.fetchCalls.length = 0;
sender.send({ event_type: 'two' });
state.beaconResult = true;
sender.flush(true);

const unloadBeacon = takeBeaconPayloads();
const unloadFetch = takeFetchEvents();
console.log(JSON.stringify({ normal, unloadBeacon, unloadFetch }));
`);

  assert.equal(result.normal.length, 1);
  assert.equal(result.normal[0].options.headers['Content-Type'], 'application/json');
  assert.equal(result.normal[0].payload.events[0].event_type, 'one');
  assert.equal(result.unloadBeacon.length, 1);
  assert.equal(result.unloadFetch.length, 0);
});

test('sender falls back to keepalive fetch when sendBeacon returns false', () => {
  const result = runScenario(`
const { sender } = globalThis.__ghostTrackerTest;
sender.send({ event_type: 'unload' });
state.beaconResult = false;
sender.flush(true);
console.log(JSON.stringify({ fetchCalls: takeFetchEvents(), beaconCalls: takeBeaconPayloads() }));
`);

  assert.equal(result.beaconCalls.length, 1);
  assert.equal(result.fetchCalls.length, 1);
  assert.equal(result.fetchCalls[0].options.keepalive, true);
});

test('buffer max size triggers immediate flush', () => {
  const result = runScenario(`
const { sender } = globalThis.__ghostTrackerTest;
for (let index = 0; index < 30; index += 1) {
  sender.send({ event_type: 'buffered', index });
}
console.log(JSON.stringify({ fetchCalls: takeFetchEvents() }));
`);

  assert.equal(result.fetchCalls.length, 1);
  assert.equal(result.fetchCalls[0].payload.events.length, 30);
});

test('navigation updates on pushState, replaceState, and popstate', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

history.pushState({}, '', '/checkout');
history.replaceState({}, '', '/checkout?step=2');
history.back();
sender.flush(false);

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const navigationEvents = events.filter((event) => event.event_type === 'navigation');
console.log(JSON.stringify({ navigationEvents }));
`);

  assert.equal(result.navigationEvents.length, 3);
  assert.deepEqual(result.navigationEvents.map((event) => event.data.nav_trigger), ['push', 'replace', 'pop']);
  assert.equal(result.navigationEvents.at(-1).data.current_pathname, '/product');
});

test('session_start is emitted only once on init', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({
  sessionStartCount: events.filter((event) => event.event_type === 'session_start').length,
  eventTypes: events.map((event) => event.event_type),
}));
`);

  assert.equal(result.sessionStartCount, 1);
});

test('beforeunload and pagehide only emit session_end once', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;
state.beaconCalls.length = 0;

window.dispatchEvent({ type: 'beforeunload' });
window.dispatchEvent({ type: 'pagehide' });

const fetchEvents = takeFetchEvents().map(entry => entry.payload.events).flat();
const beaconEvents = takeBeaconPayloads().map(entry => JSON.parse(entry.payload).events).flat();
const events = fetchEvents.concat(beaconEvents);
console.log(JSON.stringify({
  sessionEndCount: events.filter((event) => event.event_type === 'session_end').length,
  eventTypes: events.map((event) => event.event_type),
}));
`);

  assert.equal(result.sessionEndCount, 1);
});

// ═══════════════════════════════════════════════════════════════
// B 통합 테스트
// ═══════════════════════════════════════════════════════════════

test('rage_click detects correctly with B-format click_position', () => {
  // B는 { click_position: {x, y}, click_target } 구조로 emit
  // data.x / data.y 직접 접근하면 rage_click이 항상 0,0으로 감지 실패하는 버그 수정 검증
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

state.now += 100;
sdkA.emit('click', { click_position: { x: 200, y: 300 }, click_target: 'button#buy' });
state.now += 100;
sdkA.emit('click', { click_position: { x: 205, y: 298 }, click_target: 'button#buy' });
state.now += 100;
sdkA.emit('click', { click_position: { x: 198, y: 302 }, click_target: 'button#buy' });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({
  rageCount: events.filter(e => e.event_type === 'rage_click').length,
  rageData: events.find(e => e.event_type === 'rage_click')?.data,
}));
`);

  assert.equal(result.rageCount, 1);
  assert.equal(result.rageData.click_count, 3);
  assert.equal(result.rageData.click_target, 'button#buy');
});

test('rage_click does not fire when clicks are far apart (>20px)', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

state.now += 100;
sdkA.emit('click', { click_position: { x: 100, y: 100 }, click_target: 'a' });
state.now += 100;
sdkA.emit('click', { click_position: { x: 200, y: 200 }, click_target: 'b' }); // 100px 이상 떨어짐
state.now += 100;
sdkA.emit('click', { click_position: { x: 300, y: 300 }, click_target: 'c' });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({
  rageCount: events.filter(e => e.event_type === 'rage_click').length,
}));
`);

  assert.equal(result.rageCount, 0);
});

test('B event types all have non-zero event_token', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

sdkA.emit('hover_dwell',   { hover_target: 'price', hover_dwell_time_ms: 500, ghost_role: 'price' });
sdkA.emit('tab_exit',      { tab_exit_count: 1 });
sdkA.emit('tab_return',    { tab_exit_duration_ms: 3000 });
sdkA.emit('input_change',  { input_target: 'input#name', input_length: 5 });
sdkA.emit('field_focus',   { input_target: 'input#name', field_refocus_count: 0 });
sdkA.emit('field_blur',    { input_target: 'input#name', input_length: 5 });
sdkA.emit('input_abandon', { input_target: 'input#name' });
sdkA.emit('paste_event',   { input_target: 'input#coupon' });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const tokenMap = Object.fromEntries(events.map(e => [e.event_type, e.event_token]));
console.log(JSON.stringify({ tokenMap }));
`);

  assert.equal(result.tokenMap.hover_dwell,   20);
  assert.equal(result.tokenMap.tab_exit,       30);
  assert.equal(result.tokenMap.tab_return,     31);
  assert.equal(result.tokenMap.input_change,   40);
  assert.equal(result.tokenMap.field_focus,    41);
  assert.equal(result.tokenMap.field_blur,     42);
  assert.equal(result.tokenMap.input_abandon,  43);
  assert.equal(result.tokenMap.paste_event,    44);
});

test('tab_exit and tab_return carry correct data through core', () => {
  // B가 emit하는 tab_exit/return 데이터가 그대로 data 필드에 들어가는지 확인
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

sdkA.emit('tab_exit',   { tab_exit_count: 2 });
state.now += 5000;
sdkA.emit('tab_return', { tab_exit_duration_ms: 5000 });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const tabExit   = events.find(e => e.event_type === 'tab_exit');
const tabReturn = events.find(e => e.event_type === 'tab_return');
console.log(JSON.stringify({ tabExit, tabReturn }));
`);

  assert.equal(result.tabExit.data.tab_exit_count,        2);
  assert.equal(result.tabReturn.data.tab_exit_duration_ms, 5000);
});

// ═══════════════════════════════════════════════════════════════
// C 통합 테스트
// ═══════════════════════════════════════════════════════════════

test('C event types all have non-zero event_token', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

sdkA.emit('scroll_depth',            { depth_pct: 30 });
sdkA.emit('scroll_milestone',        { milestone: 50 });
sdkA.emit('scroll_stop',             { position: 800 });
sdkA.emit('scroll_direction_change', { from: 'down', to: 'up' });
sdkA.emit('scroll_speed',            { speed: 0.5 });
sdkA.emit('section_enter',           { section: 'review' });
sdkA.emit('section_exit',            { section: 'review' });
sdkA.emit('section_revisit',         { section: 'review', count: 2 });
sdkA.emit('section_transition',      { from: 'top', to: 'review' });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const tokenMap = Object.fromEntries(events.map(e => [e.event_type, e.event_token]));
console.log(JSON.stringify({ tokenMap }));
`);

  assert.equal(result.tokenMap.scroll_depth,            60);
  assert.equal(result.tokenMap.scroll_milestone,        61);
  assert.equal(result.tokenMap.scroll_stop,             62);
  assert.equal(result.tokenMap.scroll_direction_change, 63);
  assert.equal(result.tokenMap.scroll_speed,            64);
  assert.equal(result.tokenMap.section_enter,           70);
  assert.equal(result.tokenMap.section_exit,            71);
  assert.equal(result.tokenMap.section_revisit,         72);
  assert.equal(result.tokenMap.section_transition,      73);
});

test('window.__GT.emit routes C-style events through core', () => {
  // C(IIFE)의 로컬 send()를 window.__GT.emit으로 교체했을 때 정상 동작 검증
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

window.__GT.emit('section_enter',    { section: 'review' });
window.__GT.emit('scroll_milestone', { milestone: 50 });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({
  eventTypes:  events.map(e => e.event_type),
  tokenMap:    Object.fromEntries(events.map(e => [e.event_type, e.event_token])),
  hasSessionId: events.every(e => !!e.session_id),
}));
`);

  assert.ok(result.eventTypes.includes('section_enter'));
  assert.ok(result.eventTypes.includes('scroll_milestone'));
  assert.equal(result.tokenMap.section_enter,    70);
  assert.equal(result.tokenMap.scroll_milestone, 61);
  // C가 emit한 이벤트에도 session_id가 자동 부여되어야 함
  assert.equal(result.hasSessionId, true);
});

test('subsection_dwell is calculated via window.__GT bridge', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

state.now += 1000;
window.__GT.subsectionEnter('size-guide');
state.now += 3500;
window.__GT.subsectionExit('size-guide');

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const enterEvent = events.find(e => e.event_type === 'subsection_enter');
const dwellEvent = events.find(e => e.event_type === 'subsection_dwell');
console.log(JSON.stringify({ enterEvent, dwellEvent }));
`);

  assert.ok(result.enterEvent,                              'subsection_enter 이벤트가 있어야 함');
  assert.ok(result.dwellEvent,                              'subsection_dwell 이벤트가 있어야 함');
  assert.equal(result.dwellEvent.data.subsection_id,        'size-guide');
  assert.equal(result.dwellEvent.data.dwell_ms,             3500);
  assert.equal(result.dwellEvent.event_token,               92);
});

test('subsection_exit without prior enter does not emit subsection_dwell', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

// enter 없이 exit만 호출 — dwell 이벤트가 나가면 안 됨
window.__GT.subsectionExit('orphan-section');

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({
  hasDwell: events.some(e => e.event_type === 'subsection_dwell'),
}));
`);

  assert.equal(result.hasDwell, false);
});

// ═══════════════════════════════════════════════════════════════
// 공통 스키마 / 컨텍스트 테스트
// ═══════════════════════════════════════════════════════════════

test('all events from B and C carry page context automatically', () => {
  // B/C는 emit(eventType, data)만 호출 — session_id, page_url 등은 A가 자동 부여
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

sdkA.emit('click',         { click_position: { x: 100, y: 200 } });
sdkA.emit('section_enter', { section: 'review' });
sdkA.emit('scroll_depth',  { depth_pct: 50 });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({ events }));
`);

  for (const event of result.events) {
    assert.ok(event.session_id,  `${event.event_type}: session_id 없음`);
    assert.ok(event.page_url,    `${event.event_type}: page_url 없음`);
    assert.ok(event.pathname,    `${event.event_type}: pathname 없음`);
    assert.ok(event.device_type, `${event.event_type}: device_type 없음`);
    assert.ok(event.seq > 0,     `${event.event_type}: seq가 0 이하`);
  }
});

test('unknown event_type gets event_token 0', () => {
  // vocab에 없는 이벤트가 들어와도 에러 없이 처리되어야 함
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

sdkA.emit('unknown_future_event', { some: 'data' });

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const unknown = events.find(e => e.event_type === 'unknown_future_event');
console.log(JSON.stringify({ token: unknown?.event_token }));
`);

  assert.equal(result.token, 0);
});

// ═══════════════════════════════════════════════════════════════
// bounce_flag / has_interacted 테스트
// ═══════════════════════════════════════════════════════════════

test('bounce_flag is true when no interaction and single page', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;
state.beaconResult = false;

// 클릭도, 내비게이션도 없이 이탈
window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const sessionEnd = events.find(e => e.event_type === 'session_end');
console.log(JSON.stringify({ bounceFlag: sessionEnd?.data?.bounce_flag }));
`);

  assert.equal(result.bounceFlag, true);
});

test('bounce_flag is false when user has clicked (has_interacted)', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
// document click 이벤트 발화 → _setupInteractionTracking의 markInteracted 호출
const clickHandlers = state.listeners.get('click') || [];
for (const fn of clickHandlers) fn({ type: 'click' });

sender.flush(false);
state.fetchCalls.length = 0;
state.beaconResult = false;

window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const sessionEnd = events.find(e => e.event_type === 'session_end');
console.log(JSON.stringify({ bounceFlag: sessionEnd?.data?.bounce_flag }));
`);

  assert.equal(result.bounceFlag, false);
});

test('bounce_flag is false when user navigated to another page', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
history.pushState({}, '', '/checkout');  // 페이지 이동 → _navigationPath.length = 2
sender.flush(false);
state.fetchCalls.length = 0;
state.beaconResult = false;

window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const sessionEnd = events.find(e => e.event_type === 'session_end');
console.log(JSON.stringify({ bounceFlag: sessionEnd?.data?.bounce_flag }));
`);

  assert.equal(result.bounceFlag, false);
});

// ═══════════════════════════════════════════════════════════════
// 이커머스 흐름 테스트
// ═══════════════════════════════════════════════════════════════

test('cart_abandon_flag fires with correct item_count when items remain', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sdkA.emit('add_to_cart',    { product_id: 'SKU-001' });
sdkA.emit('add_to_cart',    { product_id: 'SKU-002' });
sdkA.emit('remove_from_cart', { product_id: 'SKU-001' }); // 1개 남음

sender.flush(false);
state.fetchCalls.length = 0;
state.beaconResult = false;
window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const abandon = events.find(e => e.event_type === 'cart_abandon_flag');
console.log(JSON.stringify({ abandon }));
`);

  assert.ok(result.abandon);
  assert.equal(result.abandon.data.cart_abandon_flag, true);
  assert.equal(result.abandon.data.cart_item_count,   1);
});

test('cart_abandon_flag does not fire after purchase_click', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sdkA.emit('add_to_cart',   { product_id: 'SKU-001' });
sdkA.emit('purchase_click', {});  // 결제 → cart 0으로 리셋

sender.flush(false);
state.fetchCalls.length = 0;
state.beaconResult = false;
window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({ hasAbandon: events.some(e => e.event_type === 'cart_abandon_flag') }));
`);

  assert.equal(result.hasAbandon, false);
});

test('cart_abandon_flag does not fire when cart is empty at session end', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sdkA.emit('add_to_cart',     { product_id: 'SKU-001' });
sdkA.emit('remove_from_cart', { product_id: 'SKU-001' }); // 다시 제거 → 0

sender.flush(false);
state.fetchCalls.length = 0;
state.beaconResult = false;
window.dispatchEvent({ type: 'beforeunload' });

const events = takeFetchEvents().map(entry => entry.payload.events).flat();
console.log(JSON.stringify({ hasAbandon: events.some(e => e.event_type === 'cart_abandon_flag') }));
`);

  assert.equal(result.hasAbandon, false);
});

test('ecommerce event types have correct tokens', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

sdkA.emit('product_click',   { product_id: 'SKU-001' });
sdkA.emit('option_select',   { option: 'size', value: 'M' });
sdkA.emit('add_to_cart',     { product_id: 'SKU-001' });
sdkA.emit('remove_from_cart',{ product_id: 'SKU-001' });
sdkA.emit('purchase_click',  {});

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const tokenMap = Object.fromEntries(events.map(e => [e.event_type, e.event_token]));
console.log(JSON.stringify({ tokenMap }));
`);

  assert.equal(result.tokenMap.product_click,    80);
  assert.equal(result.tokenMap.option_select,    81);
  assert.equal(result.tokenMap.add_to_cart,      82);
  assert.equal(result.tokenMap.remove_from_cart, 83);
  assert.equal(result.tokenMap.purchase_click,   84);
});

// ═══════════════════════════════════════════════════════════════
// screen_resize 테스트
// ═══════════════════════════════════════════════════════════════

test('screen_resize emits after 500ms debounce', () => {
  const result = runScenario(`
const { sdkA, sender } = globalThis.__ghostTrackerTest;
sdkA.initA();
sender.flush(false);
state.fetchCalls.length = 0;

// 여러 번 resize 이벤트 발생 → 마지막 것만 emit되어야 함
window.dispatchEvent({ type: 'resize' });
advance(200);
window.dispatchEvent({ type: 'resize' });
advance(200);
window.dispatchEvent({ type: 'resize' });
advance(500); // 마지막 resize 후 500ms 경과 → emit

sender.flush(false);
const events = takeFetchEvents().map(entry => entry.payload.events).flat();
const resizeEvents = events.filter(e => e.event_type === 'screen_resize');
console.log(JSON.stringify({ resizeCount: resizeEvents.length, token: resizeEvents[0]?.event_token }));
`);

  assert.equal(result.resizeCount, 1);  // debounce로 1회만
  assert.equal(result.token, 93);
});
