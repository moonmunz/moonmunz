/**
 * Turns a raw bid and a set of eBay comps into a real, net spread.
 *
 * The naive version of this tool would compute `ebayPrice - currentBid >= 250`
 * and hand you a list of losers. It ignores that:
 *   - you pay a 15-18% buyer's premium on top of the hammer price,
 *   - CT charges 6.35% sales tax on hammer + premium,
 *   - eBay takes ~13.35% of the sale plus a per-order fee,
 *   - you eat shipping on most sub-$500 items,
 *   - and active eBay listings are ASKS, not realized sale prices.
 *
 * Stacked up, that's roughly a 45% round trip. An item you buy at $300 and
 * "sell for $550" nets you about $60, not $250.
 */

/** All-in cost to actually take the item home at a given hammer price. */
export function buyCost(hammer, econ) {
  const premium = hammer * econ.buyersPremiumPct;
  const taxable = hammer + premium;
  const tax = taxable * econ.salesTaxPct;
  return {
    hammer,
    premium: round2(premium),
    tax: round2(tax),
    total: round2(hammer + premium + tax),
  };
}

/** What lands in your pocket after eBay and shipping, for a given sale price. */
export function sellProceeds(salePrice, econ) {
  const fvf = salePrice * econ.ebayFinalValuePct;
  const proceeds = salePrice - fvf - econ.ebayPerOrderFee - econ.assumedShippingCost;
  return {
    salePrice: round2(salePrice),
    ebayFees: round2(fvf + econ.ebayPerOrderFee),
    shipping: round2(econ.assumedShippingCost),
    net: round2(proceeds),
  };
}

/**
 * Robust central estimate of what an item sells for. Uses the median rather
 * than the mean, and trims the tails first, because comp sets are full of
 * fantasy prices -- one $9,999 "RARE!!!" listing must not manufacture a spread.
 */
export function estimateMarketPrice(comps, econ) {
  const prices = comps.map((c) => c.price).filter((p) => typeof p === 'number' && p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;

  const trimmed = trimOutliers(prices);
  const askMedian = median(trimmed);

  return {
    askMedian: round2(askMedian),
    askLow: round2(trimmed[0]),
    askHigh: round2(trimmed[trimmed.length - 1]),
    // Discount asks toward realistic realized prices.
    estimatedSalePrice: round2(askMedian * econ.askToSaleRatio),
    sampleSize: trimmed.length,
    rawSampleSize: prices.length,
  };
}

/** Drop values outside 1.5*IQR so outliers can't drag the median. */
function trimOutliers(sorted) {
  if (sorted.length < 4) return sorted;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = sorted.filter((p) => p >= lo && p <= hi);
  return kept.length >= 3 ? kept : sorted;
}

/**
 * The headline calculation: net spread at the current bid.
 *
 * Also computes maxBid -- the highest hammer price at which you'd still clear
 * your target spread. That's the number you actually want at the keyboard when
 * the auction is closing, so it's what the UI leads with.
 */
export function evaluateLot(lot, market, econ, filters) {
  if (!market) return null;

  const sale = sellProceeds(market.estimatedSalePrice, econ);
  const maxBid = maxBidForTargetSpread(market.estimatedSalePrice, filters.minSpreadDollars, econ);

  // Many sources publish an item without a live bid -- a sale that hasn't
  // opened, or a scraper that only reads listing pages. The item is still
  // worth valuing: what it resells for, and the most you could pay for it,
  // are both knowable without knowing what anyone has bid so far.
  if (lot.currentBid == null) {
    return {
      currentBid: null,
      hasBid: false,
      buyCost: null,
      sell: sale,
      netSpread: null,
      grossSpread: null,
      roi: null,
      // The headline when there's no bid: the ceiling you should not cross.
      maxBid,
      // Best case, if the item were free. Establishes whether it's worth
      // chasing at all before you know the price.
      bestCaseNet: sale.net,
      market,
    };
  }

  const bid = lot.currentBid;
  const cost = buyCost(bid, econ);
  const netSpread = round2(sale.net - cost.total);

  return {
    currentBid: bid,
    hasBid: true,
    buyCost: cost,
    sell: sale,
    netSpread,
    // Gross spread is the number most people quote. Kept only to show the gap.
    grossSpread: round2(market.estimatedSalePrice - bid),
    roi: cost.total > 0 ? round2(netSpread / cost.total) : null,
    maxBid,
    bestCaseNet: sale.net,
    market,
  };
}

/**
 * Invert the fee math: given an expected sale price, what's the most we can
 * bid and still clear `target` dollars of profit?
 *
 *   net = sellNet - hammer*(1 + premium)*(1 + tax)
 *   hammer = (sellNet - target) / ((1 + premium)*(1 + tax))
 */
export function maxBidForTargetSpread(estimatedSalePrice, target, econ) {
  const sellNet = sellProceeds(estimatedSalePrice, econ).net;
  const costMultiplier = (1 + econ.buyersPremiumPct) * (1 + econ.salesTaxPct);
  const hammer = (sellNet - target) / costMultiplier;
  return round2(Math.max(0, hammer));
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export { round2 };
