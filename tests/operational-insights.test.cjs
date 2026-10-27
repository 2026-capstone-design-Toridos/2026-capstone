const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOperationalInsights } = require('../backend/lib/operationalInsights');

const now = new Date('2026-10-26T15:00:00+09:00').valueOf();
const at = (minutesAgo) => new Date(now - minutesAgo * 60000);
const event = (session_id, event_type, minutesAgo, data = {}, pathname = '/product/test-item/101/') => ({
  event_id: `${session_id}-${event_type}-${minutesAgo}`,
  session_id,
  event_type,
  pathname,
  received_at: at(minutesAgo),
  timestamp: at(minutesAgo).valueOf(),
  data,
});

test('computes only from ended, non-purchasing sessions and explicit KRW prices', () => {
  const rows = [
    event('cart-session', 'enter_product', 90, { product_id: '101', product_name: '실제 수집 상품', product_price: 10000, currency: 'KRW' }),
    event('cart-session', 'add_to_cart_success', 80, { product_id: '101', product_name: '실제 수집 상품', product_price: '10,000', currency: 'KRW' }),
    event('unpriced-session', 'enter_product', 70, { product_id: '102', product_name: '가격 미수집 상품' }, '/product/unpriced/102/'),
    event('purchase-intent', 'section_enter', 65, { section: 'size', product_id: '103' }, '/product/size/103/'),
    event('purchase-intent', 'section_enter', 64, { section: 'size', product_id: '103' }, '/product/size/103/'),
    event('purchase-intent', 'purchase_click', 60, { product_id: '103' }, '/product/size/103/'),
    event('active-session', 'enter_product', 5, { product_id: '104', product_price: 50000, currency: 'KRW' }, '/product/active/104/'),
  ];
  const result = buildOperationalInsights(rows, { now, start: now - 12 * 3600000 });
  assert.equal(result.totals.people, 2);
  assert.equal(result.totals.loss, 10000);
  assert.equal(result.totals.strong_money, 10000);
  assert.equal(result.totals.unmatched, 1);
  assert.equal(result.totals.active, 1);
  assert.equal(result.totals.excluded_order_signals, 1);
  assert.equal(result.products.find((row) => row.id === '101').cart, 1);
  assert.equal(result.products.find((row) => row.id === '102').amount, null);
});

test('does not infer price or information areas from arbitrary source HTML', () => {
  const result = buildOperationalInsights([
    event('source-only', 'enter_product', 90, { product_id: '101', source: '<div>size review 99,000원</div>' }),
  ], { now, start: now - 12 * 3600000 });
  assert.equal(result.totals.loss, null);
  assert.equal(result.totals.unmatched, 1);
  assert.equal(result.information.reduce((sum, row) => sum + row.entries, 0), 0);
});

test('suppresses totals when the backend query is truncated', () => {
  const result = buildOperationalInsights([
    event('truncated', 'enter_product', 90, { product_id: '101', product_price: 10000, currency: 'KRW' }),
  ], { now, start: now - 12 * 3600000, truncated: true });
  assert.equal(result.totals.loss, null);
  assert.equal(result.totals.strong_money, null);
  assert.match(result.notes.at(-1), /조회 한도/);
});

test('returns only the selected session product interests in selection mode', () => {
  const result = buildOperationalInsights([
    event('selected', 'enter_product', 20, { product_id: '101', product_name: '선택 상품' }),
    event('selected', 'add_to_wishlist_success', 19, { product_id: '101', product_name: '선택 상품' }),
  ], { now, start: 0, selection: true });
  assert.equal(result.selection.products.length, 1);
  assert.equal(result.selection.products[0].stage, 'wish');
});

test('uses persisted top-level SDK product price fields', () => {
  const row = event('top-level', 'enter_product', 90, {}, '/product/top-level/105/');
  row.product_id = '105';
  row.product_price = 42000;
  row.product_currency = 'KRW';
  const result = buildOperationalInsights([row], { now, start: now - 12 * 3600000 });
  assert.equal(result.totals.loss, 42000);
  assert.equal(result.products[0].price, 42000);
});
