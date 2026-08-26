import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromEmbeddedJson, fromJsonLd, fromDomSelectors, parsePrice, parsePercent,
} from '../src/sources/auctionninja.js';

const BASE = 'https://www.auctionninja.com/sales';

/**
 * These fixtures are SYNTHETIC. They were not captured from AuctionNinja --
 * this repo was built without network access to the site. They prove the
 * extractor handles the shapes it claims to handle; they do NOT prove
 * AuctionNinja emits any of these shapes. Run `npm run probe` for that.
 */

test('embedded JSON: Next.js-style payload', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { items: [
      { id: 8812, title: 'Sterling Silver Reed & Barton Serving Spoon', currentBid: 45.00,
        url: '/sale/1/lot/8812', imageUrl: '/img/8812.jpg', endTime: '2026-09-02T18:00:00Z',
        city: 'Westport', state: 'CT' },
      { id: 8813, title: 'Mid Century Danish Teak Credenza', currentBid: 320,
        url: '/sale/1/lot/8813', imageUrl: '/img/8813.jpg' },
    ] } },
  })}</script></body></html>`;

  const lots = fromEmbeddedJson(html, BASE);
  assert.equal(lots.length, 2);

  const spoon = lots.find((l) => l.sourceId === '8812');
  assert.equal(spoon.title, 'Sterling Silver Reed & Barton Serving Spoon');
  assert.equal(spoon.currentBid, 45);
  assert.equal(spoon.url, 'https://www.auctionninja.com/sale/1/lot/8812');
  assert.equal(spoon.image, 'https://www.auctionninja.com/img/8812.jpg');
  assert.equal(spoon.endsAt, '2026-09-02T18:00:00.000Z');
  assert.equal(spoon.location, 'Westport, CT');
});

test('embedded JSON: survives snake_case field renames', () => {
  // The whole point of shape-matching over name-matching.
  const html = `<html><script type="application/json">${JSON.stringify({
    data: { lots: [
      { lot_id: 'abc-1', lot_name: 'Tiffany Sterling Bowl', current_bid: 210.5, permalink: '/l/abc-1' },
    ] },
  })}</script></html>`;

  const lots = fromEmbeddedJson(html, BASE);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].title, 'Tiffany Sterling Bowl');
  assert.equal(lots[0].currentBid, 210.5);
});

test('embedded JSON: finds lots nested deep in a state tree', () => {
  const html = `<html><script>window.__INITIAL_STATE__ = ${JSON.stringify({
    a: { b: { c: { d: { results: [
      { itemId: 55, itemTitle: 'Waterford Crystal Decanter', highBid: 75, href: '/x/55' },
    ] } } } },
  })};</script></html>`;

  const lots = fromEmbeddedJson(html, BASE);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].currentBid, 75);
});

test('embedded JSON: ignores non-lot objects', () => {
  // Nav/config objects have titles but no price+id trio.
  const html = `<html><script type="application/json">${JSON.stringify({
    nav: [{ title: 'Home', url: '/' }, { title: 'About Us', url: '/about' }],
    config: { title: 'AuctionNinja', version: 3 },
    analytics: { id: 'GA-123', name: 'tracker' },
  })}</script></html>`;

  assert.equal(fromEmbeddedJson(html, BASE).length, 0);
});

test('JSON-LD: Product with Offer', () => {
  const html = `<html><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product',
    name: 'Herman Miller Eames Lounge Chair',
    sku: 'LOT-9001',
    image: ['https://cdn.example.com/chair.jpg'],
    url: 'https://www.auctionninja.com/lot/9001',
    offers: { '@type': 'Offer', price: '1250.00', priceCurrency: 'USD' },
  })}</script></html>`;

  const lots = fromJsonLd(html, BASE);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].title, 'Herman Miller Eames Lounge Chair');
  assert.equal(lots[0].currentBid, 1250);
  assert.equal(lots[0].image, 'https://cdn.example.com/chair.jpg');
});

test('DOM selectors: card markup', () => {
  const card = (n, title, bid) => `
    <div class="lot-card">
      <a href="/lot/${n}"><img src="/i/${n}.jpg"></a>
      <div class="lot-card__title">${title}</div>
      <div class="lot-card__bid">Current Bid: $${bid}</div>
    </div>`;

  const html = `<html><body>
    ${card(1, 'Gorham Sterling Candlesticks', '125.00')}
    ${card(2, 'Persian Heriz Area Rug', '400.00')}
    ${card(3, 'Lenox China Service', '55.00')}
  </body></html>`;

  const lots = fromDomSelectors(html, BASE);
  assert.equal(lots.length, 3);
  assert.equal(lots[0].title, 'Gorham Sterling Candlesticks');
  assert.equal(lots[0].currentBid, 125);
  assert.equal(lots[1].currentBid, 400);
  assert.equal(lots[0].url, 'https://www.auctionninja.com/lot/1');
});

test('DOM selectors: refuses to latch onto a single stray match', () => {
  const html = `<html><div class="lot-card">
    <div class="title">Only One Thing</div><div class="bid">$10</div>
  </div></html>`;
  assert.equal(fromDomSelectors(html, BASE).length, 0);
});

test('parsePercent normalizes both ways of writing a rate', () => {
  assert.equal(parsePercent(18), 0.18);      // "18" meaning 18%
  assert.equal(parsePercent(0.18), 0.18);    // already fractional
  assert.equal(parsePercent('18%'), 0.18);
  assert.equal(parsePercent('Buyer\'s Premium: 15%'), 0.15);
  assert.equal(parsePercent(15), 0.15);
});

test('parsePercent rejects implausible rates rather than wrecking the math', () => {
  assert.equal(parsePercent(85), null);      // not a buyer's premium
  assert.equal(parsePercent(0), null);
  assert.equal(parsePercent(-5), null);
  assert.equal(parsePercent('n/a'), null);
  assert.equal(parsePercent(null), null);
});

test('embedded JSON picks up a per-lot buyers premium', () => {
  const html = `<html><script type="application/json">${JSON.stringify({
    items: [
      { id: 1, title: 'Sterling Bowl', currentBid: 100, buyersPremium: 18 },
      { id: 2, title: 'Brass Lamp', currentBid: 40 },
    ],
  })}</script></html>`;

  const lots = fromEmbeddedJson(html, BASE);
  const withBp = lots.find((l) => l.sourceId === '1');
  const without = lots.find((l) => l.sourceId === '2');
  assert.equal(withBp.buyersPremiumPct, 0.18);
  assert.equal(without.buyersPremiumPct, null);
});

test('parsePrice handles the formats these pages use', () => {
  assert.equal(parsePrice('$1,250.00'), 1250);
  assert.equal(parsePrice('Current Bid: $45.50 (12 bids)'), 45.5);
  assert.equal(parsePrice('USD 320'), 320);
  assert.equal(parsePrice(99.99), 99.99);
  assert.equal(parsePrice('No bids yet'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
});
