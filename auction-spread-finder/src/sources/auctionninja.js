import * as cheerio from 'cheerio';
import { fetchText, renderPage } from '../http.js';

/**
 * AuctionNinja has no public API and its markup changes without notice.
 *
 * Rather than hardcode selectors that were guessed rather than observed, this
 * extractor runs four strategies in order of reliability and reports which one
 * actually fired. Strategy A in particular does not assume a schema at all: it
 * walks whatever JSON the page embeds and scores objects by SHAPE -- does this
 * look like a thing with a title, a price, and an id? -- which survives most
 * front-end refactors.
 *
 * When they all miss, `npm run probe` dumps the page and tells you exactly
 * what it saw, so fixing this is a five-minute job instead of a mystery.
 */

const STRATEGIES = ['embedded-json', 'json-ld', 'dom-selectors', 'rendered-dom'];

export async function scrapeSource(source, opts = {}) {
  const report = { url: source.url, strategiesTried: [], lots: [], html: null, error: null };

  let html;
  try {
    html = await fetchText(source.url);
  } catch (err) {
    report.error = err.message;
    return report;
  }
  report.html = html;

  for (const strategy of ['embedded-json', 'json-ld', 'dom-selectors']) {
    const lots = runStrategy(strategy, html, source.url);
    report.strategiesTried.push({ strategy, found: lots.length });
    if (lots.length > 0) {
      report.lots = lots;
      report.strategy = strategy;
      return report;
    }
  }

  // Nothing in the static HTML -- the page is probably rendered client-side.
  if (opts.allowRender !== false) {
    try {
      const rendered = await renderPage(source.url);
      report.html = rendered;
      for (const strategy of ['embedded-json', 'json-ld', 'dom-selectors']) {
        const lots = runStrategy(strategy, rendered, source.url);
        report.strategiesTried.push({ strategy: `rendered:${strategy}`, found: lots.length });
        if (lots.length > 0) {
          report.lots = lots;
          report.strategy = `rendered:${strategy}`;
          return report;
        }
      }
    } catch (err) {
      report.renderError = err.message;
      report.renderErrorCode = err.code;
    }
  }

  return report;
}

function runStrategy(strategy, html, baseUrl) {
  try {
    if (strategy === 'embedded-json') return fromEmbeddedJson(html, baseUrl);
    if (strategy === 'json-ld') return fromJsonLd(html, baseUrl);
    if (strategy === 'dom-selectors') return fromDomSelectors(html, baseUrl);
  } catch {
    return [];
  }
  return [];
}

/* ---------- Strategy A: embedded JSON state, schema-agnostic ---------- */

/**
 * Finds JSON blobs the page ships (__NEXT_DATA__, __NUXT__, __INITIAL_STATE__,
 * or any inline `= {...}` assignment) and walks them looking for lot-shaped
 * objects. We match on the SHAPE of an object rather than on known field
 * names, so a rename from `currentBid` to `current_bid` doesn't break us.
 */
export function fromEmbeddedJson(html, baseUrl) {
  const $ = cheerio.load(html);
  const blobs = [];

  $('script').each((_, el) => {
    const id = $(el).attr('id');
    const type = $(el).attr('type');
    const text = $(el).contents().text();
    if (!text || text.length < 40) return;

    if (id === '__NEXT_DATA__' || type === 'application/json') {
      blobs.push(text);
      return;
    }
    // window.__X__ = {...};  /  self.__next_f.push([...])
    for (const m of text.matchAll(/(?:__[A-Z_a-z0-9]+__|__INITIAL_STATE__|__NUXT__)\s*=\s*(\{[\s\S]*?\});?\s*(?:\n|$)/g)) {
      blobs.push(m[1]);
    }
  });

  const found = new Map();
  for (const blob of blobs) {
    let parsed;
    try {
      parsed = JSON.parse(blob);
    } catch {
      continue;
    }
    walk(parsed, (obj) => {
      const lot = objectToLot(obj, baseUrl);
      if (lot) found.set(lot.id, lot);
    });
  }
  return [...found.values()];
}

function walk(node, visit, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit, depth + 1);
}

// Field-name candidates, matched case-insensitively and ignoring _ / -.
const TITLE_KEYS = ['title', 'name', 'lottitle', 'itemtitle', 'itemname', 'description', 'lotname'];
const BID_KEYS = ['currentbid', 'currentprice', 'highbid', 'bid', 'price', 'currentbidamount', 'winningbid', 'startingbid', 'openingbid'];
const ID_KEYS = ['id', 'lotid', 'itemid', 'itemnumber', 'lotnumber', 'auctionitemid', 'uuid', 'slug'];
const URL_KEYS = ['url', 'link', 'href', 'permalink', 'itemurl', 'loturl', 'slug'];
const IMAGE_KEYS = ['image', 'imageurl', 'thumbnail', 'thumb', 'photo', 'imagesrc', 'primaryimage', 'images'];
const END_KEYS = ['endtime', 'enddate', 'endsat', 'closingtime', 'closedate', 'endtimeutc', 'auctionendtime'];
// Buyer's premium is set per seller and is the biggest single input to the
// spread, so prefer the page's own value over the configured default.
// Deliberately no bare 'premium' -- too generic, it would match unrelated fields.
const BP_KEYS = [
  'buyerspremium', 'buyerpremium', 'buyerspremiumpercent', 'buyerpremiumpercent',
  'buyerspremiumrate', 'bppercent', 'buyerspremiumpct',
];
const LOCATION_KEYS = ['city', 'location', 'zip', 'zipcode', 'postalcode', 'state', 'address'];

function norm(key) {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

function pick(obj, candidates) {
  for (const [key, value] of Object.entries(obj)) {
    if (candidates.includes(norm(key)) && value != null && value !== '') return value;
  }
  return undefined;
}

/**
 * Decide whether a plain object is a lot. Requires a plausible title, a
 * plausible price, and something to identify it by -- an id field, or failing
 * that its listing URL. Title plus price is already rare enough in nav and
 * config objects to keep false positives near zero.
 */
export function objectToLot(obj, baseUrl, { requirePrice = true } = {}) {
  const title = pick(obj, TITLE_KEYS);
  if (typeof title !== 'string' || title.length < 4 || title.length > 300) return null;

  const rawBid = pick(obj, BID_KEYS);
  const bid = parsePrice(rawBid);

  /**
   * A price is required when walking a page's embedded JSON, where most
   * objects are nav entries and config blobs and title+price+id is what
   * separates a real lot from noise.
   *
   * It is NOT required when the caller already knows every record is an item
   * -- a dedicated scraper's output, say. Many listings have no live bid yet,
   * and discarding them loses items worth valuing.
   */
  if (bid == null && requirePrice) return null;

  const url = resolveUrl(firstString(pick(obj, URL_KEYS)), baseUrl);
  const image = resolveUrl(firstString(pick(obj, IMAGE_KEYS)), baseUrl);

  // Prefer an explicit id, but a listing URL identifies a lot just as well and
  // some sources ship no id field at all. Requiring one would silently discard
  // otherwise-complete lots.
  let rawId = pick(obj, ID_KEYS);
  if (rawId == null || typeof rawId === 'object') rawId = url ?? null;
  if (rawId == null) return null;

  return {
    id: `an:${rawId}`,
    sourceId: String(rawId),
    title: title.trim(),
    currentBid: bid,   // null when the listing shows no bid yet
    url,
    image,
    endsAt: parseDate(pick(obj, END_KEYS)),
    location: extractLocation(obj),
    buyersPremiumPct: parsePercent(pick(obj, BP_KEYS)),
    extractedBy: 'embedded-json',
  };
}

function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = firstString(v);
      if (s) return s;
    }
  }
  if (value && typeof value === 'object') {
    return firstString(value.url ?? value.src ?? value.href ?? null);
  }
  return null;
}

/**
 * Location arrives two ways: as a nested address object, or as flat sibling
 * keys on the lot itself (city/state/zip). Taking only the first matching key
 * would turn {city:'Westport', state:'CT'} into a bare "Westport", so assemble
 * the parts instead.
 */
function extractLocation(obj) {
  // Nested object form first.
  for (const [key, value] of Object.entries(obj)) {
    const n = norm(key);
    if ((n === 'location' || n === 'address') && value && typeof value === 'object') {
      const parts = stringifyLocation(value);
      if (parts) return parts;
    }
  }

  // Flat sibling form: gather city / state / zip wherever they appear.
  const parts = {};
  for (const [key, value] of Object.entries(obj)) {
    const n = norm(key);
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (n === 'city') parts.city ??= String(value);
    else if (n === 'state' || n === 'stateabbr') parts.state ??= String(value);
    else if (n === 'zip' || n === 'zipcode' || n === 'postalcode') parts.zip ??= String(value);
  }
  const assembled = [parts.city, parts.state, parts.zip].filter(Boolean).join(', ');
  if (assembled) return assembled;

  // Last resort: a plain string under a location-ish key.
  const flat = pick(obj, LOCATION_KEYS);
  return typeof flat === 'string' ? flat : null;
}

function stringifyLocation(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return [value.city, value.state, value.zip ?? value.postalCode].filter(Boolean).join(', ') || null;
  }
  return null;
}

/* ---------- Strategy B: JSON-LD structured data ---------- */

export function fromJsonLd(html, baseUrl) {
  const $ = cheerio.load(html);
  const lots = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    walk(data, (node) => {
      const type = node['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (!types.some((t) => t === 'Product' || t === 'Offer' || t === 'IndividualProduct')) return;

      const offer = node.offers ?? node;
      const price = parsePrice(offer?.price ?? offer?.lowPrice ?? node.price);
      if (price == null || !node.name) return;

      lots.push({
        id: `an:${node.sku ?? node.productID ?? node.url ?? node.name}`,
        sourceId: String(node.sku ?? node.productID ?? node.name),
        title: String(node.name).trim(),
        currentBid: price,
        url: resolveUrl(node.url ?? offer?.url, baseUrl),
        image: resolveUrl(firstString(node.image), baseUrl),
        endsAt: parseDate(offer?.priceValidUntil ?? offer?.validThrough),
        location: null,
        extractedBy: 'json-ld',
      });
    });
  });

  return dedupe(lots);
}

/* ---------- Strategy C: DOM selectors ---------- */

/**
 * The brittle fallback. If AuctionNinja's markup doesn't match these, edit this
 * list -- it's the only place selectors live. `npm run probe` prints the classes
 * it actually saw on the page to make that edit quick.
 */
export const SELECTOR_SETS = [
  { container: '[class*="lot-card"]', title: '[class*="title"]', price: '[class*="bid"], [class*="price"]', link: 'a', image: 'img' },
  { container: '[class*="item-card"]', title: '[class*="title"], h3, h4', price: '[class*="bid"], [class*="price"]', link: 'a', image: 'img' },
  { container: '[class*="auction-item"]', title: 'h3, h4, [class*="title"]', price: '[class*="bid"], [class*="price"]', link: 'a', image: 'img' },
  { container: 'article, [class*="card"]', title: 'h2, h3, h4, [class*="title"]', price: '[class*="bid"], [class*="price"]', link: 'a', image: 'img' },
];

export function fromDomSelectors(html, baseUrl) {
  const $ = cheerio.load(html);

  for (const set of SELECTOR_SETS) {
    const lots = [];
    $(set.container).each((i, el) => {
      const $el = $(el);
      const title = $el.find(set.title).first().text().trim();
      const priceText = $el.find(set.price).first().text().trim();
      const bid = parsePrice(priceText);
      if (!title || title.length < 4 || bid == null) return;

      const href = $el.find(set.link).first().attr('href');
      const src = $el.find(set.image).first().attr('src') ?? $el.find(set.image).first().attr('data-src');

      lots.push({
        id: `an:${href ?? `${slug(title)}-${i}`}`,
        sourceId: href ?? slug(title),
        title,
        currentBid: bid,
        url: resolveUrl(href, baseUrl),
        image: resolveUrl(src, baseUrl),
        endsAt: null,
        location: null,
        extractedBy: 'dom-selectors',
      });
    });
    // Require a few hits so we don't latch onto one stray element.
    if (lots.length >= 3) return dedupe(lots);
  }
  return [];
}

/* ---------- shared helpers ---------- */

export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  // Grab the first $-style number; tolerate "Current Bid: $1,250.00 (12 bids)".
  const m = value.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a percentage to a fraction. Sites express these both ways --
 * 18 meaning 18%, or 0.18 meaning the same thing. Values at or below 1 are
 * treated as already-fractional; anything above as a percent. Rejects
 * implausible rates so a stray field can't wreck the math.
 */
export function parsePercent(value) {
  let n = typeof value === 'number' ? value : null;
  if (typeof value === 'string') {
    const m = value.match(/(\d+(?:\.\d+)?)\s*%?/);
    n = m ? parseFloat(m[1]) : null;
  }
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  const frac = n > 1 ? n / 100 : n;
  // A buyer's premium outside 0-50% is a misread field, not a real rate.
  return frac > 0 && frac <= 0.5 ? frac : null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function resolveUrl(href, baseUrl) {
  if (!href || typeof href !== 'string') return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
}

function dedupe(lots) {
  const map = new Map();
  for (const lot of lots) map.set(lot.id, lot);
  return [...map.values()];
}

export { STRATEGIES };
