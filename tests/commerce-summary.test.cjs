const assert = require('node:assert/strict');
const { buildCommerceSummary } = require('../backend/lib/commerceSummary');

const events = [
  {
    session_id: 's1',
    event_type: 'enter_product',
    pathname: '/product/test-shirt/10/category/20/',
    data: { source: '<button>장바구니 담기</button><a>WISH</a>' },
    received_at: '2026-08-01T00:00:00Z',
  },
  {
    session_id: 's1',
    event_type: 'subsection_enter',
    pathname: '/product/test-shirt/10/category/20/',
    data: { subsection_id: 'review', subsection_label: '상품후기' },
    received_at: '2026-08-01T00:01:00Z',
  },
  {
    session_id: 's1',
    event_type: 'click',
    pathname: '/product/test-shirt/10/category/20/',
    data: { click_text: '장바구니 이동' },
    received_at: '2026-08-01T00:02:00Z',
  },
  {
    session_id: 's1',
    event_type: 'session_start',
    pathname: '/order/basket.html',
    data: {},
    received_at: '2026-08-01T00:03:00Z',
  },
  {
    session_id: 's2',
    event_type: 'click',
    pathname: '/product/test-pants/11/',
    data: { button_text: '장바구니 담기' },
    received_at: '2026-08-01T00:04:00Z',
  },
  {
    session_id: 's2',
    event_type: 'click',
    pathname: '/product/test-pants/11/',
    data: { target_text: '찜하기' },
    received_at: '2026-08-01T00:04:30Z',
  },
  {
    session_id: 's2',
    event_type: 'click',
    pathname: '/order/orderform.html',
    data: { click_text: '결제하기' },
    received_at: '2026-08-01T00:05:00Z',
  },
  {
    session_id: 's2',
    event_type: 'order_complete',
    pathname: '/order/order_result.html',
    data: {},
    received_at: '2026-08-01T00:06:00Z',
  },
];

const summary = buildCommerceSummary(events);

assert.equal(summary.counts.review_views, 1);
assert.equal(summary.counts.cart_visits, 1);
assert.equal(summary.counts.cart_moves, 1);
assert.equal(summary.counts.add_to_cart, 1, 'HTML source text must not create false add-to-cart events');
assert.equal(summary.counts.wishlist_adds, 1, 'only the real wishlist click is counted; HTML source text is ignored');
assert.equal(summary.counts.checkout_starts, 1, 'checkout is counted once per session');
assert.equal(summary.counts.order_completions, 1, 'order completion is counted once per session');

console.log('commerce summary test passed');
