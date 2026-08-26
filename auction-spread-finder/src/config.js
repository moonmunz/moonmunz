import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Defaults are tuned for 06897 (Weston, CT). Everything here can be overridden
 * by config.json in the project root, which is gitignored so your keys and
 * your tuning stay local.
 */
const DEFAULTS = {
  location: {
    zip: '06897',
    radiusMiles: 40,
  },

  /**
   * AuctionNinja does not publish an API, and their browse URLs change. Rather
   * than guessing a URL scheme, paste the URLs straight out of your browser
   * after you've searched/filtered the way you like. Each one is crawled on
   * every refresh.
   *
   * These defaults are a starting guess -- run `npm run probe` to see whether
   * they actually return listings, and replace them with real URLs from your
   * browser if they don't.
   */
  sources: [
    { name: 'auctionninja-local', url: 'https://www.auctionninja.com/sales', enabled: true },
  ],

  economics: {
    // What you pay ON TOP of the hammer price at AuctionNinja.
    buyersPremiumPct: 0.15,   // AN sellers commonly set 15-18%. Check your sale.
    salesTaxPct: 0.0635,      // CT state rate, applied to hammer + premium.

    // What eBay takes OUT of your sale price.
    ebayFinalValuePct: 0.1335,
    ebayPerOrderFee: 0.40,

    // Shipping you eat if you offer free shipping. Rough per-item average.
    assumedShippingCost: 12.00,

    /**
     * Active eBay listings are ASKS, not sales -- people list optimistically.
     * We multiply the median active ask by this to approximate what an item
     * actually realizes. 0.75 is deliberately conservative.
     * If you get access to eBay's Marketplace Insights API (real sold data),
     * set this to 1.0 and switch the comp source to 'sold'.
     */
    askToSaleRatio: 0.75,
  },

  filters: {
    minSpreadDollars: 250,   // your headline number
    minConfidence: 0.45,     // hide matches we don't trust
    minCompCount: 3,         // need at least this many eBay comps to trust a price
    maxLotPriceDollars: 2000, // ignore big-ticket lots you don't want to bid on
  },

  ebay: {
    // Free at developer.ebay.com -> create an app -> Production keys.
    // Can also be supplied via EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars.
    clientId: '',
    clientSecret: '',
    marketplaceId: 'EBAY_US',
    compCacheHours: 72,
  },

  http: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    delayMs: 1500,        // politeness delay between requests to the same host
    timeoutMs: 30000,
    maxDetailFetches: 60, // cap per refresh so a run stays quick and polite
  },

  server: { port: 4317 },
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override;
  if (typeof override !== 'object' || override === null) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let cfg = DEFAULTS;
  if (fs.existsSync(file)) {
    try {
      cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      console.error(`config.json is not valid JSON (${err.message}) -- using defaults.`);
    }
  }
  // Env vars win over config.json so you can keep keys out of files entirely.
  if (process.env.EBAY_CLIENT_ID) cfg.ebay.clientId = process.env.EBAY_CLIENT_ID;
  if (process.env.EBAY_CLIENT_SECRET) cfg.ebay.clientSecret = process.env.EBAY_CLIENT_SECRET;
  return cfg;
}

export { ROOT, DEFAULTS };
