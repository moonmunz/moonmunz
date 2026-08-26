import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComps, substituteQuery, parseCompPrice } from '../src/comps/apify-ebay.js';
import { estimateMarketPrice } from '../src/economics.js';

const ECON = {
  buyersPremiumPct: 0.15, salesTaxPct: 0.0635,
  ebayFinalValuePct: 0.1335, ebayPerOrderFee: 0.40,
  assumedShippingCost: 12.00, askToSaleRatio: 0.75,
};

test('substituteQuery fills the placeholder wherever it appears', () => {
  assert.deepEqual(
    substituteQuery({ searchTerms: ['{{query}}'] }, 'sterling bowl'),
    { searchTerms: ['sterling bowl'] }
  );
  // Different Actors name the field differently and nest it differently.
  assert.deepEqual(
    substituteQuery({ search: { keyword: '{{ query }}' }, limit: 50 }, 'nikon f3'),
    { search: { keyword: 'nikon f3' }, limit: 50 }
  );
  assert.deepEqual(
    substituteQuery({ url: 'https://ebay.com/sch/?q={{query}}' }, 'eames chair'),
    { url: 'https://ebay.com/sch/?q=eames chair' }
  );
});

test('substituteQuery leaves non-strings alone', () => {
  assert.deepEqual(
    substituteQuery({ n: 5, b: true, nil: null }, 'x'),
    { n: 5, b: true, nil: null }
  );
});

test('parseCompPrice handles the shapes scrapers emit', () => {
  assert.equal(parseCompPrice(249.99), 249.99);
  assert.equal(parseCompPrice('$1,250.00'), 1250);
  assert.equal(parseCompPrice({ value: '89.95', currency: 'USD' }), 89.95);
  assert.equal(parseCompPrice('Best offer'), null);
  assert.equal(parseCompPrice(0), null);
  assert.equal(parseCompPrice(null), null);
});

test('normalizeComps reads varied Actor output shapes', () => {
  const items = [
    { title: 'Gorham Sterling Candlesticks', price: 245, itemUrl: 'https://ebay.com/1' },
    { name: 'Sterling Candlestick Pair', soldPrice: '$265.00', link: 'https://ebay.com/2' },
    { item: { itemTitle: 'Gorham Candlesticks', currentPrice: { value: 220 }, url: 'https://ebay.com/3' } },
    { irrelevant: 'no title or price here' },
  ];

  const comps = normalizeComps(items);
  assert.equal(comps.length, 3);
  assert.deepEqual(comps.map((c) => c.price).sort((a, b) => a - b), [220, 245, 265]);
  assert.ok(comps.every((c) => c.source === 'apify-ebay'));
});

test('normalizeComps tolerates junk input', () => {
  assert.deepEqual(normalizeComps(null), []);
  assert.deepEqual(normalizeComps('nope'), []);
  assert.deepEqual(normalizeComps([null, 5, 'x']), []);
});

test('sold comps must not be discounted a second time', () => {
  const comps = [{ price: 400 }, { price: 420 }, { price: 390 }, { price: 410 }];

  // Active asks get discounted toward a realistic sale price.
  const asks = estimateMarketPrice(comps, ECON);
  assert.equal(asks.estimatedSalePrice, 303.75);   // 405 * 0.75

  // Sold prices are already realized, so the ratio is 1.0 and they pass through.
  const sold = estimateMarketPrice(comps, { ...ECON, askToSaleRatio: 1.0 });
  assert.equal(sold.estimatedSalePrice, 405);
  assert.ok(sold.estimatedSalePrice > asks.estimatedSalePrice,
    'treating sold data as asks would understate every spread');
});
