import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const REPO_ROOT = '/Users/parkjoehyun/Desktop/software/4grade/2026-capstone/ghost-tracker';

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

const repoUrl = new URL('file:///Users/parkjoehyun/Desktop/software/4grade/2026-capstone/ghost-tracker/');
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
