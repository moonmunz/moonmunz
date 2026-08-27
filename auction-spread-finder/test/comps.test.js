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

test('URLs in error messages never carry the API token', async () => {
  const { redactUrl } = await import('../src/http.js');
  const real = 'https://api.apify.com/v2/acts/x~y/runs/last/dataset/items'
    + '?token=apify_api_SECRETVALUE123&status=SUCCEEDED&limit=500';

  const safe = redactUrl(real);
  assert.ok(!safe.includes('SECRETVALUE123'), 'token must not survive redaction');
  assert.ok(safe.includes('token=***'));
  // Non-secret parameters stay, so the message is still diagnosable.
  assert.ok(safe.includes('status=SUCCEEDED'));
  assert.ok(safe.includes('/acts/x~y/'));
});

test('redactUrl scrubs even unparseable input', async () => {
  const { redactUrl } = await import('../src/http.js');
  assert.ok(!redactUrl('not a url ?token=LEAKED').includes('LEAKED'));
});

test('items with no bid are kept and valued, not discarded', async () => {
  const { normalizeItems } = await import('../src/sources/apify.js');
  // Exactly the shape the AuctionNinja Actor returned: no currentBid at all.
  const rows = [
    { image: 'x.jpg', title: 'Mid-Century, Swarovski, Lladro, And More!', currentBid: null,
      itemUrl: 'https://www.auctionninja.com/a', auctioneer: 'Clearing House', location: 'Fairfield, CT' },
    { image: 'y.jpg', title: 'Darien Finds: Extraordinary Furniture', currentBid: null,
      itemUrl: 'https://www.auctionninja.com/b', auctioneer: 'Darien Scouts', location: 'Darien, CT' },
  ];

  const lots = normalizeItems(rows);
  assert.equal(lots.length, 2, 'a missing bid must not disqualify an item');
  assert.ok(lots.every((l) => l.currentBid === null));
  // Identity falls back to the listing URL, and location still parses.
  assert.ok(lots.every((l) => l.url?.startsWith('https://www.auctionninja.com')));
  assert.equal(lots[0].location, 'Fairfield, CT');
});

test('embedded page JSON still requires a price, to avoid nav-object noise', async () => {
  const { fromEmbeddedJson } = await import('../src/sources/auctionninja.js');
  // Walking a whole page's state, title-without-price is almost always a menu
  // entry rather than a lot, so that path stays strict.
  const html = `<html><script type="application/json">${JSON.stringify({
    nav: [{ id: 1, title: 'Browse Estate Sales', url: '/browse' },
          { id: 2, title: 'How Bidding Works', url: '/help' }],
  })}</script></html>`;
  assert.equal(fromEmbeddedJson(html, 'https://www.auctionninja.com').length, 0);
});

test('the same Actor returning real lots works fine', async () => {
  const { normalizeItems } = await import('../src/sources/apify.js');
  const lots = [
    { title: 'Sterling Silver Bowl', currentBid: 45, itemUrl: 'https://www.auctionninja.com/l/1' },
    { title: 'Eames Lounge Chair', currentBid: 450, itemUrl: 'https://www.auctionninja.com/l/2' },
  ];
  assert.equal(normalizeItems(lots).length, 2);
});
