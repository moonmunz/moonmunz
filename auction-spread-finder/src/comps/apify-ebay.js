import { fetchJson } from '../http.js';
import { normalizeActorId } from '../sources/apify.js';

/**
 * eBay comps via an Apify Actor, as an alternative to eBay's official API.
 *
 * Why this exists: eBay manually reviews developer accounts before issuing
 * Production keys, which can block you for days. Apify has eBay scrapers and
 * you already have an Apify account, so this path needs no eBay approval at
 * all. It's also the only route to sold-price data without eBay's restricted
 * Marketplace Insights API, if the Actor you pick scrapes sold listings.
 *
 * Actors differ, so nothing about the input or output shape is assumed:
 * you supply an input template with a {{query}} placeholder, and results are
 * normalized by matching on shape rather than field name.
 */

const DEFAULT_API = 'https://api.apify.com/v2';

export async function searchCompsViaApify(query, cfg) {
  const c = cfg.comps?.apify ?? {};
  const token = c.token || cfg.apify?.token;

  if (!token) {
    const err = new Error(
      'Comps are set to use Apify, but no Apify token is saved. Add it in Settings.'
    );
    err.code = 'NO_APIFY_TOKEN';
    throw err;
  }
  if (!c.actorId) {
    const err = new Error(
      'Comps are set to use Apify, but no eBay Actor is set. Pick one from the Apify Store ' +
      'and paste its ID into Settings.'
    );
    err.code = 'NO_APIFY_COMP_ACTOR';
    throw err;
  }

  const api = c.apiBase ?? cfg.apify?.apiBase ?? DEFAULT_API;
  const id = encodeURIComponent(normalizeActorId(c.actorId));
  const input = substituteQuery(c.inputTemplate ?? { searchTerms: ['{{query}}'] }, query);

  const url = `${api}/acts/${id}/run-sync-get-dataset-items`
    + `?token=${encodeURIComponent(token)}`
    + (c.maxItems ? `&limit=${c.maxItems}` : '&limit=50');

  const items = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    // run-sync blocks until the Actor finishes. Apify cuts it off at 300s, so
    // allow slightly more than that and let their limit be the one that fires.
    timeoutMs: 310_000,
  });

  return normalizeComps(items);
}

/**
 * Replace {{query}} anywhere in the input template -- in strings, inside
 * arrays, at any depth -- so it works whichever field the Actor expects.
 */
export function substituteQuery(template, query) {
  if (typeof template === 'string') {
    return template.replace(/\{\{\s*query\s*\}\}/g, query);
  }
  if (Array.isArray(template)) {
    return template.map((v) => substituteQuery(v, query));
  }
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = substituteQuery(v, query);
    return out;
  }
  return template;
}

const TITLE_KEYS = ['title', 'name', 'itemtitle', 'productname', 'heading'];
const PRICE_KEYS = ['price', 'soldprice', 'currentprice', 'value', 'amount', 'buyitnowprice', 'saleprice'];
const URL_KEYS = ['url', 'itemurl', 'link', 'href', 'permalink', 'itemweburl'];
const IMAGE_KEYS = ['image', 'imageurl', 'thumbnail', 'img', 'galleryurl'];
const CONDITION_KEYS = ['condition', 'itemcondition'];

function norm(k) { return k.toLowerCase().replace(/[_\-\s]/g, ''); }

function pick(obj, keys) {
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(norm(k)) && v != null && v !== '') return v;
  }
  return undefined;
}

/** Prices arrive as numbers, strings, or nested {value, currency} objects. */
export function parseCompPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const m = value.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    const n = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (value && typeof value === 'object') {
    return parseCompPrice(value.value ?? value.amount ?? value.price ?? null);
  }
  return null;
}

export function normalizeComps(items) {
  if (!Array.isArray(items)) return [];

  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;

    // Some Actors wrap each result; try the item, then one level in.
    for (const obj of [raw, ...Object.values(raw).filter((v) => v && typeof v === 'object' && !Array.isArray(v))]) {
      const title = pick(obj, TITLE_KEYS);
      const price = parseCompPrice(pick(obj, PRICE_KEYS));
      if (typeof title !== 'string' || price == null) continue;

      out.push({
        title: title.trim(),
        price,
        currency: 'USD',
        condition: stringOrNull(pick(obj, CONDITION_KEYS)),
        url: stringOrNull(pick(obj, URL_KEYS)),
        image: stringOrNull(pick(obj, IMAGE_KEYS)),
        source: 'apify-ebay',
      });
      break;
    }
  }
  return out;
}

function stringOrNull(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return stringOrNull(v.url ?? v.src ?? v.name ?? null);
  return null;
}
