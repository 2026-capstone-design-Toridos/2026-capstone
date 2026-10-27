/**
 * Resolve missing product prices from the authenticated shop's own public pages.
 * Only exact Cafe24 product meta tags are accepted; visible text and arbitrary HTML
 * are never interpreted as prices.
 */
const { originVariants } = require('../middleware/siteAccess');

const CACHE_OK_MS = 10 * 60 * 1000;
const CACHE_ERROR_MS = 60 * 1000;
const MAX_PRODUCTS = 30;
const MAX_HTML_BYTES = 1024 * 1024;
const cache = new Map();

const clean = (value) => String(value ?? '').trim();

function productIdOf(event = {}) {
  const explicit = clean(event.data?.product_id || event.product_id);
  if (explicit) return explicit;
  const raw = clean(event.pathname || event.page_url);
  const pathMatch = raw.match(/\/product\/[^/]+\/(\d+)(?:\/|$)/i);
  if (pathMatch) return pathMatch[1];
  try { return new URL(event.page_url).searchParams.get('product_no') || ''; } catch { return ''; }
}

function metaValue(html, property) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[match[1].toLowerCase()] = match[3].trim();
    if ((attrs.property || '').toLowerCase() === property.toLowerCase()) return attrs.content || '';
  }
  return '';
}

function parseCafe24Price(html, expectedProductId = '') {
  const productId = metaValue(html, 'product:productId') || metaValue(html, 'product:retailer_item_id');
  const amountRaw = metaValue(html, 'product:price:amount').replace(/,/g, '');
  const currency = metaValue(html, 'product:price:currency').toUpperCase();
  if (!productId || (expectedProductId && productId !== String(expectedProductId))) return null;
  if (!/^\d+(?:\.\d+)?$/.test(amountRaw) || currency !== 'KRW') return null;
  const price = Number(amountRaw);
  return Number.isFinite(price) && price >= 0 ? { productId, price, currency } : null;
}

function allowedHosts(origin) {
  return new Set(originVariants(origin).map((value) => {
    try { return new URL(value).host.toLowerCase(); } catch { return ''; }
  }).filter(Boolean));
}

function productUrl(event, origin, hosts) {
  const raw = clean(event.page_url || event.pathname);
  if (!raw) return null;
  try {
    const url = new URL(raw, origin);
    if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.host.toLowerCase())) return null;
    if (!productIdOf(event)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

async function readHtml(response) {
  if (!response.ok || !String(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) return '';
  if (!response.body?.getReader) return (await response.text()).slice(0, MAX_HTML_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let size = 0;
  while (size < MAX_HTML_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (/<\/head\s*>/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

async function fetchPrice(url, productId, hosts, fetchImpl, now) {
  const key = `${url.origin}:${productId}`;
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'SEER-PriceMatcher/1.0' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const finalUrl = new URL(response.url || url);
    if (!hosts.has(finalUrl.host.toLowerCase())) throw new Error('cross-origin redirect');
    const value = parseCafe24Price(await readHtml(response), productId);
    cache.set(key, { value, expires: now + (value ? CACHE_OK_MS : CACHE_ERROR_MS) });
    return value;
  } catch {
    cache.set(key, { value: null, expires: now + CACHE_ERROR_MS });
    return null;
  } finally { clearTimeout(timer); }
}

async function resolveProductPrices(events, { origin, fetchImpl = global.fetch, now = Date.now() } = {}) {
  if (!origin || typeof fetchImpl !== 'function' || !Array.isArray(events) || !events.length) return events;
  const hosts = allowedHosts(origin);
  if (!hosts.size) return events;
  const candidates = new Map();
  for (const event of events) {
    const productId = productIdOf(event);
    if (!productId || event.product_price !== undefined || event.data?.product_price !== undefined) continue;
    const url = productUrl(event, origin, hosts);
    if (url && !candidates.has(productId)) candidates.set(productId, url);
    if (candidates.size >= MAX_PRODUCTS) break;
  }
  const resolved = new Map();
  await Promise.all([...candidates].map(async ([productId, url]) => {
    const value = await fetchPrice(url, productId, hosts, fetchImpl, now);
    if (value) resolved.set(productId, value);
  }));
  if (!resolved.size) return events;
  return events.map((event) => {
    const price = resolved.get(productIdOf(event));
    return price ? {
      ...event,
      product_price: price.price,
      product_currency: price.currency,
      product_price_source: '연결된 쇼핑몰 상품 페이지의 Cafe24 판매가',
    } : event;
  });
}

function clearProductPriceCache() { cache.clear(); }

module.exports = { resolveProductPrices, parseCafe24Price, productIdOf, clearProductPriceCache };
