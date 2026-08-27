import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where settings saved from the UI are stored.
 *
 * On a host, the app directory is rebuilt on every deploy and restart, so a
 * config.json written there would silently vanish -- you'd set your Actor,
 * watch it work, and find it reverted days later. DATA_DIR points at the
 * persistent disk, so settings live there when one exists.
 */
const CONFIG_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'config.json')
  : path.join(ROOT, 'config.json');

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
   * AuctionNinja browses by town: auctionninja.com/<state>/<town-slug>.
   * These are the towns closest to 06897 (Weston). Add or remove any in the
   * Settings panel -- or paste URLs straight out of your browser after
   * searching their site however you like. Every enabled URL is crawled on
   * each refresh, throttled to one request per 1.5s.
   *
   * Note: these pages were never loaded during development (the build sandbox
   * had no access to the site), so if a URL 404s, replace it with one from
   * your browser's address bar.
   */
  sources: [
    { name: 'weston', url: 'https://www.auctionninja.com/ct/weston', enabled: true },
    { name: 'westport', url: 'https://www.auctionninja.com/ct/westport', enabled: true },
    { name: 'wilton', url: 'https://www.auctionninja.com/ct/wilton', enabled: true },
    { name: 'redding', url: 'https://www.auctionninja.com/ct/redding', enabled: true },
    { name: 'ridgefield', url: 'https://www.auctionninja.com/ct/ridgefield', enabled: true },
    { name: 'new-canaan', url: 'https://www.auctionninja.com/ct/new-canaan', enabled: true },
    { name: 'norwalk', url: 'https://www.auctionninja.com/ct/norwalk', enabled: true },
    { name: 'fairfield', url: 'https://www.auctionninja.com/ct/fairfield', enabled: true },
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

  /**
   * Where eBay comps come from.
   *   'ebay-api' -- eBay's official Browse API. Needs Production keys, which
   *                 eBay issues only after manually reviewing your developer
   *                 account (can take days).
   *   'apify'    -- an eBay scraper Actor on Apify. No eBay approval needed,
   *                 and if the Actor scrapes SOLD listings you get real
   *                 realized prices rather than asking prices.
   */
  comps: {
    /**
     * 'auto' is the best of both: sold prices where they exist (real
     * transactions, no guessed discount), and eBay's free API as a backstop
     * for items with no recent completed sale. It also spends nothing on
     * items the paid source already answered.
     */
    source: 'ebay-api',
    apify: {
      actorId: '',
      // Blank falls back to the main Apify token.
      token: '',
      maxItems: 50,
      /**
       * Sent as the Actor's input. {{query}} is replaced with the search term
       * wherever it appears, at any depth.
       *
       * This default matches crawloop~ebay-sold-listings-scraper. Every Actor
       * names its fields differently, so if you use a different one, copy the
       * shape from its Input tab (the "JSON example" view) and put {{query}}
       * where the search term goes.
       */
      inputTemplate: {
        keywords: ['{{query}}'],
        count: 10,             // sold listings per item; billed per listing
        daysToScrape: 90,      // estate items sell slowly -- a wide window helps
        sortOrder: 'endedRecently',
        ebaySite: 'ebay.com',
        itemCondition: 'any',
        listingType: 'any',
        dedupeItemIds: true,
      },
      /**
       * Set true if your Actor returns SOLD listings. Sold prices are already
       * realized, so they skip the ask-to-sale discount.
       */
      isSoldData: false,
    },
  },

  /**
   * Optional: let Apify do the scraping instead of the built-in scraper.
   * When enabled this takes over completely -- the direct scraper is skipped.
   * Token also readable from the APIFY_TOKEN env var.
   */
  apify: {
    enabled: false,
    token: '',
    actorId: 'scrapersdelight~auctionninja-scraper',
    // 'last' reads the newest successful run (pair with a schedule inside
    // Apify); 'run' triggers the Actor now and waits.
    mode: 'last',
    maxItems: 500,
    // Override only for testing against a mock API.
    apiBase: 'https://api.apify.com/v2',
    /**
     * Sent as the Actor's input in 'run' mode. Actors differ, so copy the
     * exact input JSON from the Actor's page in Apify Console (the Input tab
     * shows it) and paste it into Settings. This default follows the common
     * startUrls convention but is not guaranteed to match your Actor.
     */
    input: {
      startUrls: [{ url: 'https://www.auctionninja.com/ct/weston' }],
    },
  },

  http: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    delayMs: 1500,        // politeness delay between requests to the same host
    timeoutMs: 30000,
    maxDetailFetches: 60, // cap per refresh so a run stays quick and polite
  },

  server: {
    port: 4317,
    // Hosted deployments refresh themselves on this cadence so data is fresh
    // when you open the page. 0 disables it (the local default -- you press
    // Refresh). Set via REFRESH_INTERVAL_HOURS.
    refreshIntervalHours: 0,
    // Bind to loopback only: this app holds your eBay API keys and exposes a
    // settings endpoint, neither of which belong on a coffee-shop network.
    // Set to '0.0.0.0' only if you want to reach it from another device
    // (see the Tailscale note in the README).
    host: '127.0.0.1',
  },
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
  const file = CONFIG_FILE;
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
  if (process.env.APIFY_TOKEN) {
    cfg.apify.token = process.env.APIFY_TOKEN;
    cfg.apify.enabled = true;
  }
  // Hosts (Render, Railway, Fly) assign the port and require binding all
  // interfaces; locally we stay on loopback.
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.server.host = process.env.HOST;
  if (process.env.REFRESH_INTERVAL_HOURS) {
    cfg.server.refreshIntervalHours = Number(process.env.REFRESH_INTERVAL_HOURS);
  }
  return cfg;
}

/**
 * Write user-editable settings back to config.json, so the Settings panel in
 * the web UI can replace hand-editing JSON. Only the fields the UI exposes are
 * written; anything else already in the file is preserved.
 */
export function saveSettings(patch) {
  const file = CONFIG_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let existing = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // A corrupt file shouldn't block saving; we're about to rewrite it.
    }
  }

  const next = { ...existing };

  if (patch.sources) {
    next.sources = patch.sources
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .map((url, i) => ({ name: `source-${i + 1}`, url, enabled: true }));
  }
  if (patch.ebay) {
    next.ebay = { ...existing.ebay };
    // An empty string means "leave what's already saved alone", so the UI can
    // show a masked placeholder without wiping the stored key on every save.
    if (patch.ebay.clientId) next.ebay.clientId = patch.ebay.clientId.trim();
    if (patch.ebay.clientSecret) next.ebay.clientSecret = patch.ebay.clientSecret.trim();
  }
  if (patch.comps) {
    next.comps = { ...existing.comps };
    if (['apify', 'ebay-api', 'auto'].includes(patch.comps.source)) {
      next.comps.source = patch.comps.source;
    }
    if (patch.comps.apify) {
      next.comps.apify = { ...existing.comps?.apify };
      if (patch.comps.apify.actorId !== undefined) {
        next.comps.apify.actorId = String(patch.comps.apify.actorId).trim();
      }
      if (typeof patch.comps.apify.isSoldData === 'boolean') {
        next.comps.apify.isSoldData = patch.comps.apify.isSoldData;
      }
      if (patch.comps.apify.inputTemplate && typeof patch.comps.apify.inputTemplate === 'object') {
        next.comps.apify.inputTemplate = patch.comps.apify.inputTemplate;
      }
    }
  }
  if (patch.apify) {
    next.apify = { ...existing.apify };
    if (typeof patch.apify.enabled === 'boolean') next.apify.enabled = patch.apify.enabled;
    if (patch.apify.actorId) next.apify.actorId = patch.apify.actorId.trim();
    if (patch.apify.mode === 'run' || patch.apify.mode === 'last') next.apify.mode = patch.apify.mode;
    if (patch.apify.input && typeof patch.apify.input === 'object') next.apify.input = patch.apify.input;
    // Blank means "keep the stored token", same as the eBay fields.
    if (patch.apify.token) next.apify.token = patch.apify.token.trim();
  }
  if (patch.economics) {
    next.economics = { ...existing.economics, ...numeric(patch.economics) };
  }
  if (patch.filters) {
    next.filters = { ...existing.filters, ...numeric(patch.filters) };
  }

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

function numeric(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export { ROOT, DEFAULTS };
