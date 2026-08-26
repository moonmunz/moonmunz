import { fetchJson } from '../http.js';
import { objectToLot } from './auctionninja.js';

/**
 * Apify as the scrape source.
 *
 * This exists because the direct scraper in auctionninja.js was written without
 * ever loading the real site. Apify sells maintained AuctionNinja scrapers that
 * run on their own infrastructure with their own proxies -- so if the direct
 * scraper misses, this path works without anyone editing selectors.
 *
 * Two modes, and 'last' is the one you want for daily use:
 *
 *   'last' -- read the most recent successful run's results. Pair this with a
 *             schedule set up inside Apify (Apify runs the scrape overnight;
 *             this app just reads what it produced). Fast, cheap, and immune
 *             to the 300-second synchronous-run limit.
 *
 *   'run'  -- trigger the Actor now and wait for results. Simpler to set up,
 *             but a large scrape can exceed Apify's 300s sync ceiling; on that
 *             timeout we fall back to reading the last completed run.
 *
 * The Actor's output field names are not assumed. Items are normalized through
 * the same shape-matching logic the direct scraper uses, so whichever
 * AuctionNinja Actor you pick, anything with a title, a price, and an id is
 * recognized.
 */

const DEFAULT_API = 'https://api.apify.com/v2';
const BASE_URL = 'https://www.auctionninja.com';

export async function fetchFromApify(cfg, { onProgress = () => {} } = {}) {
  const { token, actorId, mode, input, maxItems } = cfg.apify;
  const API = cfg.apify.apiBase ?? DEFAULT_API;

  if (!token) {
    const err = new Error(
      'No Apify API token. Find it in Apify Console under Settings -> Integrations, ' +
      'then paste it into this app\'s Settings panel.'
    );
    err.code = 'NO_APIFY_TOKEN';
    throw err;
  }
  if (!actorId) {
    const err = new Error('No Apify Actor set. Paste the Actor ID (e.g. username~actor-name) into Settings.');
    err.code = 'NO_APIFY_ACTOR';
    throw err;
  }

  // The API path wants a tilde, but people copy "username/actor-name" from the
  // browser URL. Accept either.
  const id = encodeURIComponent(actorId.trim().replace('/', '~'));

  let items;
  if (mode === 'last') {
    onProgress(`Reading last Apify run of ${actorId}`);
    try {
      items = await lastRunItems(API, id, token, maxItems);
    } catch (err) {
      // A 404 here is ambiguous and the raw status is useless to act on, so
      // name both causes and what to do about each.
      if (err.status === 404) {
        const e = new Error(
          `Apify has no completed run for Actor "${actorId}". Either the Actor ID is wrong, ` +
          `or it exists but has never finished a run. Open the Actor in Apify Console, check ` +
          `the ID in its page URL, and press Start once — then refresh here.`
        );
        e.code = 'APIFY_NO_RUN';
        throw e;
      }
      if (err.status === 401 || err.status === 403) {
        const e = new Error('Apify rejected the API token. Check it in Settings.');
        e.code = 'APIFY_AUTH';
        throw e;
      }
      throw err;
    }
  } else {
    onProgress(`Running Apify Actor ${actorId} (this can take a few minutes)`);
    try {
      items = await runSync(API, id, token, input, maxItems);
    } catch (err) {
      if (err.status !== 408) throw err;
      // The run is still going server-side; take the previous completed run so
      // this refresh returns something useful.
      onProgress('Run exceeded Apify\'s 300s sync limit — reading the last completed run instead');
      items = await lastRunItems(API, id, token, maxItems);
    }
  }

  const lots = normalizeItems(items);

  // Returning items but recognizing none of them is the confusing failure:
  // the Actor worked, the app shows nothing, and neither says why. Carry
  // enough detail back for the caller to explain it.
  return {
    lots,
    rawCount: Array.isArray(items) ? items.length : 0,
    diagnosis: lots.length === 0 ? diagnose(items) : null,
  };
}

/**
 * Work out why nothing was recognized. The common cause is an Actor that
 * scraped sale pages rather than individual lots -- those have titles and URLs
 * but no bid, and a lot without a price cannot be valued.
 */
function diagnose(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'The Actor returned no items at all. Check its input in Apify Console.';
  }

  const sample = items.find((i) => i && typeof i === 'object') ?? {};
  const keys = Object.keys(sample);

  const priceKeys = ['currentbid', 'currentprice', 'highbid', 'bid', 'price', 'startingbid'];
  const priced = keys.filter((k) => priceKeys.includes(k.toLowerCase().replace(/[_\-\s]/g, '')));
  const hasPriceField = priced.length > 0;
  const allNull = hasPriceField && items.every((i) => priced.every((k) => i?.[k] == null));

  if (allNull) {
    return `The Actor returned ${items.length} items, but every one has an empty ${priced.join('/')}. ` +
      `That usually means it scraped SALE pages (whole auctions) rather than individual LOTS. ` +
      `In Apify, change the Actor's input so it returns lots — its examples include "scrape lots with bid counts". ` +
      `Fields it did return: ${keys.slice(0, 12).join(', ')}.`;
  }
  if (!hasPriceField) {
    return `The Actor returned ${items.length} items with no bid or price field at all. ` +
      `Fields present: ${keys.slice(0, 12).join(', ')}. This app needs a current bid to value a lot.`;
  }
  return `The Actor returned ${items.length} items but none had both a title and a usable price. ` +
    `Fields present: ${keys.slice(0, 12).join(', ')}.`;
}

async function runSync(API, id, token, input, maxItems) {
  const url = `${API}/acts/${id}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`
    + (maxItems ? `&limit=${maxItems}` : '');
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
}

async function lastRunItems(API, id, token, maxItems) {
  const url = `${API}/acts/${id}/runs/last/dataset/items`
    + `?token=${encodeURIComponent(token)}&status=SUCCEEDED`
    + (maxItems ? `&limit=${maxItems}` : '');
  return fetchJson(url);
}

/**
 * Turn Actor output into our lot shape. Runs each item through the same
 * shape-matcher the direct scraper uses, then retries on any nested object
 * (some Actors wrap the lot under `lot`, `item`, or `data`).
 */
export function normalizeItems(items) {
  if (!Array.isArray(items)) return [];

  const out = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    let lot = objectToLot(item, BASE_URL);

    if (!lot) {
      for (const value of Object.values(item)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          lot = objectToLot(value, BASE_URL);
          if (lot) break;
        }
      }
    }

    if (lot) out.set(lot.id, { ...lot, extractedBy: 'apify' });
  }
  return [...out.values()];
}
