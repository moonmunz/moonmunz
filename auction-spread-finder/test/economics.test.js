import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buyCost, sellProceeds, estimateMarketPrice, evaluateLot, maxBidForTargetSpread,
} from '../src/economics.js';
import { buildQuery, scoreConfidence } from '../src/match.js';

const ECON = {
  buyersPremiumPct: 0.15,
  salesTaxPct: 0.0635,
  ebayFinalValuePct: 0.1335,
  ebayPerOrderFee: 0.40,
  assumedShippingCost: 12.00,
  askToSaleRatio: 0.75,
};

const FILTERS = { minSpreadDollars: 250 };

test('buyCost stacks premium then tax on the total', () => {
  const c = buyCost(100, ECON);
  assert.equal(c.premium, 15);
  // Tax applies to hammer + premium ($115), not just hammer.
  assert.equal(c.tax, 7.3);
  assert.equal(c.total, 122.3);
});

test('sellProceeds subtracts eBay fees, per-order fee, and shipping', () => {
  const s = sellProceeds(500, ECON);
  assert.equal(s.ebayFees, 67.15);   // 500*0.1335 + 0.40
  assert.equal(s.net, 420.85);       // 500 - 67.15 - 12
});

test('the naive spread is badly wrong -- this is the whole point of the tool', () => {
  // Naive read: bid $300, "sells for $550" => $250 spread. Looks like a hit.
  const lot = { currentBid: 300 };
  const market = { estimatedSalePrice: 550, askMedian: 733, sampleSize: 8 };
  const v = evaluateLot(lot, market, ECON, FILTERS);

  assert.equal(v.grossSpread, 250);          // what a naive tool would report
  assert.ok(v.netSpread < 100, `netSpread was ${v.netSpread}`);
  // Real answer: ~$97. Not a $250 opportunity.
  assert.equal(v.netSpread, 97.27);
});

test('maxBid inverts the fee math to the number you need at the keyboard', () => {
  const maxBid = maxBidForTargetSpread(550, 250, ECON);
  // Bidding exactly this much should leave almost exactly $250 of spread.
  const v = evaluateLot({ currentBid: maxBid }, { estimatedSalePrice: 550 }, ECON, FILTERS);
  assert.ok(Math.abs(v.netSpread - 250) < 0.05, `spread at maxBid was ${v.netSpread}`);
});

test('estimateMarketPrice uses a trimmed median, not a mean', () => {
  // One fantasy listing must not manufacture a spread.
  const comps = [
    { price: 100 }, { price: 110 }, { price: 105 }, { price: 95 },
    { price: 115 }, { price: 9999 },
  ];
  const m = estimateMarketPrice(comps, ECON);
  assert.ok(m.askMedian < 130, `median was ${m.askMedian}`);
  assert.equal(m.rawSampleSize, 6);
  assert.ok(m.sampleSize < 6, 'the outlier should have been trimmed');
});

test('estimateMarketPrice returns null with no usable comps', () => {
  assert.equal(estimateMarketPrice([], ECON), null);
});

test('buildQuery strips estate-listing filler', () => {
  const q = buildQuery('Nice Large Lot of Assorted Vintage Sterling Silver Reed & Barton Spoons');
  assert.ok(!/\bassorted\b/i.test(q.query));
  assert.ok(!/\bnice\b/i.test(q.query));
  assert.ok(/sterling/i.test(q.query));
  assert.ok(q.matchedBrands.includes('sterling'));
});

test('buildQuery keeps model numbers', () => {
  const q = buildQuery('Nikon F3 35mm Camera Body');
  assert.ok(/F3/.test(q.query));
});

test('confidence rises with a known maker and tight comps', () => {
  const lot = { title: 'Tiffany Sterling Silver Bowl' };
  const q = buildQuery(lot.title);
  const tight = [
    { title: 'Tiffany Sterling Silver Bowl', price: 400 },
    { title: 'Tiffany Sterling Silver Bowl 8in', price: 420 },
    { title: 'Tiffany & Co Sterling Bowl', price: 390 },
    { title: 'Tiffany Sterling Silver Bowl', price: 410 },
    { title: 'Tiffany Sterling Bowl Vintage', price: 405 },
  ];
  const { score } = scoreConfidence(lot, q, tight);
  assert.ok(score > 0.6, `expected high confidence, got ${score}`);
});

test('confidence falls for a vague multi-item lot with scattered comps', () => {
  const lot = { title: 'Box Lot of Assorted Household Items' };
  const q = buildQuery(lot.title);
  const scattered = [
    { title: 'Antique Brass Lamp', price: 40 },
    { title: 'Rare Gold Coin Collection', price: 3000 },
    { title: 'Plastic Storage Bin', price: 12 },
  ];
  const { score } = scoreConfidence(lot, q, scattered);
  assert.ok(score < 0.4, `expected low confidence, got ${score}`);
});

test('no comps means zero confidence', () => {
  const { score } = scoreConfidence({ title: 'X' }, buildQuery('X'), []);
  assert.equal(score, 0);
});
