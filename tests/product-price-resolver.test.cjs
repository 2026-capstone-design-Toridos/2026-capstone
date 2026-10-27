const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProductPrices, parseCafe24Price, clearProductPriceCache } = require('../backend/lib/productPriceResolver');

const html = (id = '136') => `<!doctype html><head>
  <meta content="${id}" property="product:productId">
  <meta property="product:price:amount" content="54000">
  <meta property="product:price:currency" content="KRW">
</head><body>소비자가 99,999원</body>`;

test('accepts only exact Cafe24 product price metadata', () => {
  assert.deepEqual(parseCafe24Price(html(), '136'), { productId: '136', price: 54000, currency: 'KRW' });
  assert.equal(parseCafe24Price('<div>판매가 54,000원</div>', '136'), null);
  assert.equal(parseCafe24Price(html('999'), '136'), null);
  assert.equal(parseCafe24Price(html().replace('KRW', 'USD'), '136'), null);
});

test('hydrates missing prices only from the authorized shop host', async () => {
  clearProductPriceCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return { ok: true, url: String(url), headers: { get: () => 'text/html' }, body: null, text: async () => html() };
  };
  const events = [
    { session_id: 's1', page_url: 'https://dignolucir.co.kr/product/item/136/', data: { product_id: '136' } },
    { session_id: 's1', page_url: 'https://dignolucir.co.kr/product/item/136/', data: { product_id: '136' } },
  ];
  const result = await resolveProductPrices(events, { origin: 'https://dignolucir.co.kr', fetchImpl, now: 1000 });
  assert.equal(calls.length, 1);
  assert.equal(result[0].product_price, 54000);
  assert.equal(result[0].product_currency, 'KRW');
  assert.match(result[0].product_price_source, /상품 페이지/);
});

test('never requests a product URL outside the authorized shop aliases', async () => {
  clearProductPriceCache();
  let called = false;
  const result = await resolveProductPrices([
    { page_url: 'https://evil.example/product/item/136/', data: { product_id: '136' } },
  ], { origin: 'https://dignolucir.co.kr', fetchImpl: async () => { called = true; }, now: 2000 });
  assert.equal(called, false);
  assert.equal(result[0].product_price, undefined);
});
