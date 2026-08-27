import { fetchJson, fetchText } from '../http.js';

/**
 * eBay Browse API adapter.
 *
 * IMPORTANT about what this returns: the Browse API searches ACTIVE listings,
 * which are asks, not sales. Real sold-comp data lives behind eBay's
 * Marketplace Insights API, which requires a business-justification application
 * and is not granted to most developers. So we search active listings and
 * discount them via economics.askToSaleRatio.
 *
 * If you do get Marketplace Insights access, implement `searchSold` below with
 * the same return shape and the rest of the app picks it up unchanged.
 */

// EBAY_API_BASE points these at a mock so the comp path can be exercised
// without live credentials; unset, they are eBay's production endpoints.
const API_BASE = process.env.EBAY_API_BASE || 'https://api.ebay.com';
const OAUTH_URL = `${API_BASE}/identity/v1/oauth2/token`;
const BROWSE_URL = `${API_BASE}/buy/browse/v1/item_summary/search`;

let tokenCache = { token: null, expiresAt: 0 };

async function getToken(cfg) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;

  if (!cfg.ebay.clientId || !cfg.ebay.clientSecret) {
    const err = new Error(
      'No eBay API credentials. Get free keys at https://developer.ebay.com (create an app, ' +
      'use the Production keyset), then set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET or put them in config.json.'
    );
    err.code = 'NO_EBAY_CREDS';
    throw err;
  }

  const basic = Buffer.from(`${cfg.ebay.clientId}:${cfg.ebay.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });

  const text = await fetchText(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const json = JSON.parse(text);
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000,
  };
  return tokenCache.token;
}

/**
 * Search active listings. Returns a normalized comp array the rest of the app
 * understands, regardless of which eBay API produced it.
 */
export async function searchActive(query, cfg, { limit = 50 } = {}) {
  const token = await getToken(cfg);
  const url = new URL(BROWSE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  // Exclude auction-format listings: their current bids are mid-auction noise,
  // not asks. Fixed-price listings are the cleaner ask signal.
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');

  const json = await fetchJson(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': cfg.ebay.marketplaceId,
    },
  });

  const items = json.itemSummaries ?? [];
  return items.map((it) => ({
    title: it.title,
    price: parseFloat(it.price?.value ?? 'NaN'),
    currency: it.price?.currency ?? 'USD',
    condition: it.condition ?? null,
    url: it.itemWebUrl,
    image: it.image?.imageUrl ?? null,
    source: 'ebay-active',
  })).filter((c) => Number.isFinite(c.price) && c.price > 0);
}

/**
 * Placeholder for eBay Marketplace Insights (real sold prices).
 * Implement to return the same shape as searchActive() and set
 * economics.askToSaleRatio to 1.0.
 */
export async function searchSold() {
  const err = new Error('Sold-comp data requires eBay Marketplace Insights API access.');
  err.code = 'NO_SOLD_ACCESS';
  throw err;
}
