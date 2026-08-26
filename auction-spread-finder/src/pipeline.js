import { loadConfig } from './config.js';
import { Store } from './store.js';
import { scrapeSource } from './sources/auctionninja.js';
import { fetchFromApify } from './sources/apify.js';
import { searchActive } from './comps/ebay.js';
import { buildQuery, scoreConfidence } from './match.js';
import { estimateMarketPrice, evaluateLot } from './economics.js';

/**
 * One full refresh: scrape every configured source, comp the lots we haven't
 * priced recently, and score the spreads. Safe to run repeatedly -- comps are
 * cached and lots are merged, so a second run in the same day is cheap.
 */
export async function refresh({ onProgress = () => {} } = {}) {
  const cfg = loadConfig();
  const store = new Store();

  const summary = {
    sourcesOk: 0,
    sourcesFailed: 0,
    lotsFound: 0,
    lotsNew: 0,
    lotsPriced: 0,
    compLookups: 0,
    compsCached: 0,
    errors: [],
    warnings: [],
  };

  /* ---- 1. Scrape ---- */
  const scraped = [];

  if (cfg.apify?.enabled) {
    // Apify replaces the built-in scraper entirely -- running both would just
    // produce duplicate lots and double the cost.
    try {
      const lots = await fetchFromApify(cfg, { onProgress });
      if (lots.length === 0) {
        summary.sourcesFailed++;
        summary.errors.push(
          cfg.apify.mode === 'last'
            ? 'Apify returned no lots. Has the Actor run successfully yet? Run it once in Apify Console, then refresh here.'
            : 'Apify ran but returned no recognizable lots. Check the Actor input in Settings against the Actor\'s own Input tab.'
        );
      } else {
        summary.sourcesOk++;
        summary.viaApify = true;
        onProgress(`  got ${lots.length} lots from Apify`);
        scraped.push(...lots);
      }
    } catch (err) {
      summary.sourcesFailed++;
      summary.errors.push(`Apify: ${err.message}`);
    }
  }

  for (const source of cfg.apify?.enabled ? [] : cfg.sources.filter((s) => s.enabled !== false)) {
    onProgress(`Scraping ${source.url}`);
    const report = await scrapeSource(source);

    if (report.error) {
      summary.sourcesFailed++;
      summary.errors.push(`${source.name}: ${report.error}`);
      continue;
    }
    if (report.lots.length === 0) {
      summary.sourcesFailed++;
      const detail = report.renderError
        ? ` (browser render also failed: ${report.renderError})`
        : '';
      summary.errors.push(
        `${source.name}: page fetched OK but no lots could be extracted${detail}. ` +
        `Run \`npm run probe\` to see what the page actually contains.`
      );
      continue;
    }

    summary.sourcesOk++;
    onProgress(`  found ${report.lots.length} lots via ${report.strategy}`);
    scraped.push(...report.lots);
  }

  summary.lotsFound = scraped.length;

  for (const lot of scraped) {
    const { isNew } = store.upsertLot(lot);
    if (isNew) summary.lotsNew++;
  }

  /* ---- 2. Comp + score ---- */
  const needPricing = store.allLots()
    .filter((lot) => lot.currentBid != null)
    .filter((lot) => lot.currentBid <= cfg.filters.maxLotPriceDollars)
    .filter((lot) => !isEnded(lot))
    // Price the cheapest first: that's where the spread usually is.
    .sort((a, b) => a.currentBid - b.currentBid)
    .slice(0, cfg.http.maxDetailFetches);

  let credsMissing = false;

  for (const lot of needPricing) {
    const queryInfo = buildQuery(lot.title);
    const cacheKey = `ebay:${queryInfo.query.toLowerCase()}`;

    let comps = store.getComps(cacheKey, cfg.ebay.compCacheHours);
    if (comps) {
      summary.compsCached++;
    } else {
      if (credsMissing) continue;
      try {
        onProgress(`Comping "${queryInfo.query}"`);
        comps = await searchActive(queryInfo.query, cfg);
        store.putComps(cacheKey, comps);
        summary.compLookups++;
      } catch (err) {
        if (err.code === 'NO_EBAY_CREDS') {
          credsMissing = true;
          summary.warnings.push(err.message);
          continue;
        }
        summary.errors.push(`comp lookup failed for "${queryInfo.query}": ${err.message}`);
        continue;
      }
    }

    // A premium scraped from the listing beats the configured default, which
    // is only a guess at what this particular seller charges.
    const econ = lot.buyersPremiumPct != null
      ? { ...cfg.economics, buyersPremiumPct: lot.buyersPremiumPct }
      : cfg.economics;

    const confidence = scoreConfidence(lot, queryInfo, comps);
    const market = estimateMarketPrice(comps, econ);
    const valuation = evaluateLot(lot, market, econ, cfg.filters);
    if (valuation) valuation.premiumSource = lot.buyersPremiumPct != null ? 'listing' : 'config';

    store.upsertLot({
      ...lot,
      query: queryInfo.query,
      comps: comps.slice(0, 8), // keep a few for the UI to show as evidence
      confidence,
      valuation,
      pricedAt: new Date().toISOString(),
    });
    summary.lotsPriced++;
  }

  store.prune(30);
  store.recordRun(summary);
  store.save();
  return summary;
}

function isEnded(lot) {
  return lot.endsAt ? new Date(lot.endsAt).getTime() < Date.now() : false;
}

/**
 * The view the web app reads: lots that clear your spread and confidence bars,
 * best opportunity first.
 */
export function getOpportunities(overrides = {}) {
  const cfg = loadConfig();
  const filters = { ...cfg.filters, ...overrides };
  const store = new Store();

  const all = store.allLots().filter((lot) => lot.valuation && lot.confidence);

  const passing = all.filter((lot) =>
    lot.valuation.netSpread >= filters.minSpreadDollars &&
    lot.confidence.score >= filters.minConfidence &&
    (lot.comps?.length ?? 0) >= filters.minCompCount &&
    !isEnded(lot)
  );

  passing.sort((a, b) => b.valuation.netSpread - a.valuation.netSpread);

  return {
    opportunities: passing,
    stats: {
      totalTracked: store.allLots().length,
      totalPriced: all.length,
      passing: passing.length,
      lastRun: store.lastRun(),
    },
    filters,
  };
}
