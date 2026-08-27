import { loadConfig } from './config.js';
import { Store } from './store.js';
import { scrapeSource } from './sources/auctionninja.js';
import { fetchFromApify } from './sources/apify.js';
import { fetchComps } from './comps/index.js';
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
      const { lots, rawCount, diagnosis } = await fetchFromApify(cfg, { onProgress });
      if (lots.length === 0) {
        summary.sourcesFailed++;
        summary.errors.push(
          diagnosis ?? `Apify returned ${rawCount} items but no usable lots.`
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
    // A missing bid is no longer disqualifying -- the item is still worth
    // valuing, and the max-bid figure doesn't depend on the current bid.
    .filter((lot) => lot.currentBid == null || lot.currentBid <= cfg.filters.maxLotPriceDollars)
    .filter((lot) => !isEnded(lot))
    // Cheapest first, since that's where the spread usually is. Lots with no
    // bid sort alongside the cheap ones: they may not have opened yet.
    .sort((a, b) => (a.currentBid ?? 0) - (b.currentBid ?? 0))
    .slice(0, cfg.http.maxDetailFetches);

  let credsMissing = false;
  let compFailures = 0;
  let firstCompError = null;

  /**
   * Each sold-comp lookup can take minutes, because it waits for a scraper to
   * run. Across dozens of lots that is hours, which is no use to someone
   * opening the page in the morning. Price as many as fit the budget, keep the
   * results, and say what was left -- the next refresh resumes from the cache.
   */
  const compBudgetMs = (cfg.filters.compBudgetMinutes ?? 12) * 60_000;
  const compDeadline = Date.now() + compBudgetMs;
  let ranOutOfTime = false;

  for (const lot of needPricing) {
    const queryInfo = buildQuery(lot.title);
    const cacheKey = `ebay:${queryInfo.query.toLowerCase()}`;

    let cached = store.getComps(cacheKey, cfg.ebay.compCacheHours);
    let comps = Array.isArray(cached) ? cached : cached?.comps;
    // Whether these are sold prices decides if the ask discount applies, so it
    // has to survive caching alongside them.
    let isSold = Array.isArray(cached) ? false : Boolean(cached?.isSold);

    if (comps) {
      summary.compsCached++;
    } else {
      if (credsMissing) continue;
      if (Date.now() > compDeadline) {
        ranOutOfTime = true;
        break;
      }
      try {
        onProgress(`Comping "${queryInfo.query}"`);
        const result = await fetchComps(queryInfo.query, cfg, { onProgress });
        comps = result.comps;
        isSold = result.isSold;
        store.putComps(cacheKey, { comps, isSold, usedSource: result.usedSource });
        summary.compLookups++;
      } catch (err) {
        if (err.code === 'NO_EBAY_CREDS' || err.code === 'NO_APIFY_COMP_ACTOR' || err.code === 'NO_APIFY_TOKEN') {
          credsMissing = true;
          summary.warnings.push(err.message);
          continue;
        }
        // A misconfigured comp source fails identically for every item, so
        // reporting it per item buries the one fact that matters. Record the
        // first, count the rest, and stop hammering a source that is clearly
        // not going to answer.
        compFailures++;
        if (!firstCompError) {
          firstCompError = err.message;
          summary.errors.push(`Comp lookup failed: ${err.message}`);
        }
        if (compFailures >= 3) {
          summary.errors.push(
            `Gave up on comps after ${compFailures} identical failures — fix the comp source in Settings, then refresh.`
          );
          break;
        }
        continue;
      }
    }

    // A premium scraped from the listing beats the configured default, which
    // is only a guess at what this particular seller charges.
    let econ = lot.buyersPremiumPct != null
      ? { ...cfg.economics, buyersPremiumPct: lot.buyersPremiumPct }
      : cfg.economics;

    // Sold comps are realized prices, so they must not be discounted again by
    // the ask-to-sale ratio -- that would understate every spread. Decided per
    // item, since a fallback to active listings can happen for any one of them.
    if (isSold) econ = { ...econ, askToSaleRatio: 1.0 };

    const confidence = scoreConfidence(lot, queryInfo, comps);
    const market = estimateMarketPrice(comps, econ);
    const valuation = evaluateLot(lot, market, econ, cfg.filters);
    if (valuation) {
      valuation.premiumSource = lot.buyersPremiumPct != null ? 'listing' : 'config';
      // Sold vs asking changes how much the estimate is worth trusting, so the
      // UI shows it rather than presenting both as the same kind of number.
      valuation.compBasis = isSold ? 'sold' : 'asking';
    }

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

  if (ranOutOfTime) {
    const left = needPricing.length - summary.lotsPriced;
    summary.warnings.push(
      `Priced ${summary.lotsPriced} lots before the time budget ran out; ` +
      `${left} still to go. Refresh again to continue — already-priced lots are cached and won't be re-fetched.`
    );
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

  const passing = all.filter((lot) => {
    if (lot.confidence.score < filters.minConfidence) return false;
    if ((lot.comps?.length ?? 0) < filters.minCompCount) return false;
    if (isEnded(lot)) return false;

    // With a bid, the test is the actual spread at that bid. Without one, the
    // question is whether the item could clear the bar at any price -- i.e.
    // whether what it resells for, after fees, leaves enough room.
    return lot.valuation.hasBid
      ? lot.valuation.netSpread >= filters.minSpreadDollars
      : lot.valuation.bestCaseNet >= filters.minSpreadDollars;
  });

  // Rank by whichever number the lot actually has: realized spread when a bid
  // is known, otherwise headroom.
  const rank = (lot) => (lot.valuation.hasBid ? lot.valuation.netSpread : lot.valuation.bestCaseNet);
  passing.sort((a, b) => rank(b) - rank(a));

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
