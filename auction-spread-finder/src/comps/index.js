import { searchActive } from './ebay.js';
import { searchCompsViaApify } from './apify-ebay.js';

/**
 * Chooses where an item's price comparisons come from.
 *
 * The two sources answer different questions. Sold listings are what buyers
 * actually paid -- the real answer, but sparse: a Rockford Jacobean sideboard
 * may have no completed sale in 90 days. Active listings always exist but are
 * asking prices, and for estate antiques those run well above what things
 * fetch, which is why they get discounted before use.
 *
 * 'auto' therefore tries sold data first and falls back to active listings
 * only when sold comps are too thin to trust. That gets real prices where they
 * exist, free coverage where they don't, and spends nothing on items the paid
 * source can already answer.
 */
export async function fetchComps(query, cfg, { onProgress = () => {}, queryInfo = null } = {}) {
  const source = cfg.comps?.source ?? 'ebay-api';
  const minComps = cfg.filters?.minCompCount ?? 3;

  if (source === 'apify') {
    const comps = await searchCompsViaApify(query, cfg);
    return { comps, isSold: Boolean(cfg.comps?.apify?.isSoldData), usedSource: 'apify' };
  }

  if (source === 'ebay-api') {
    const comps = await searchActive(query, cfg);
    return { comps, isSold: false, usedSource: 'ebay-api' };
  }

  /**
   * auto: sold data is slow and billed per listing, so spend it where it can
   * change an answer. A title naming a real maker -- Ethan Allen, Gorham,
   * Herman Miller -- comps precisely enough that a real sale price matters. A
   * title like "Three Drawer Dresser Purple Drawers" will produce scattered
   * comps whichever source answers, and the free API is as good a guess at a
   * fraction of the time and none of the cost.
   */
  const hasMaker = (queryInfo?.matchedBrands?.length ?? 0) > 0;
  if (!hasMaker) {
    try {
      const comps = await searchActive(query, cfg);
      if (comps.length >= minComps) {
        return { comps, isSold: false, usedSource: 'ebay-api', skippedSold: 'no recognized maker' };
      }
      // Too thin even from the free source -- fall through and try paid.
    } catch {
      // eBay unavailable; the paid path below is the remaining option.
    }
  }

  // sold first, active as backstop.
  let soldError = null;
  try {
    const comps = await searchCompsViaApify(query, cfg);
    if (comps.length >= minComps) {
      return { comps, isSold: Boolean(cfg.comps?.apify?.isSoldData), usedSource: 'apify' };
    }
    onProgress(`  only ${comps.length} sold comps — falling back to active listings`);
  } catch (err) {
    // A misconfigured paid source shouldn't take the free one down with it.
    soldError = err;
    onProgress(`  sold comps unavailable (${err.message.slice(0, 80)}) — trying active listings`);
  }

  try {
    const comps = await searchActive(query, cfg);
    return { comps, isSold: false, usedSource: 'ebay-api', soldError: soldError?.message ?? null };
  } catch (err) {
    // Both failed. Report whichever failure is more actionable: if sold data
    // broke first, that's the one the user configured most recently.
    throw soldError ?? err;
  }
}
