# Auction Spread Finder

A local web app you open each morning. It scrapes recent AuctionNinja lots near
06897, prices each one against eBay comps, and shows you the ones where the
**net** spread clears $250.

```
npm install
npm run doctor     # check what's working
npm run refresh    # scrape + price
npm start          # open http://localhost:4317
```

---

## Read this first — what is and isn't verified

This was built in a sandbox with **no network access to auctionninja.com or
ebay.com** (the egress gateway blocks both). That has one concrete consequence:

**The AuctionNinja scraper has never run against the real site.** I could not
inspect their markup, so the extractor is written to *discover* structure rather
than assume it, and there is a `probe` command to close the gap in a few minutes.
Everything else — the fee math, the comp statistics, the confidence scoring, the
matching, the server, the UI — is tested and verified end-to-end (`npm test`,
19 tests, plus a full pipeline run against a local fixture).

So expect step 1 below to need five minutes of your attention, once.

---

## Setup

### 1. Point it at the right AuctionNinja pages

Their browse URLs aren't documented and I couldn't observe them, so rather than
guessing a scheme, the app crawls **URLs you paste from your browser**. Search
AuctionNinja however you like — by your zip, by radius, by category — and copy
the resulting URL.

```bash
cp config.example.json config.json
```

Put your URLs in `sources`, then check that extraction works:

```bash
npm run probe
```

`probe` fetches each page, tries every extraction strategy, and tells you which
one worked. If none did, it saves the raw HTML and prints the page's actual
class names, script-tag counts, and whether prices appear in the HTML at all —
which is exactly what you need to either fix a selector or conclude the page is
client-rendered.

If it says the page renders client-side:

```bash
npm install playwright && npx playwright install chromium
```

The scraper then falls back to a real browser automatically. (Playwright is
deliberately *not* a default dependency — it pulls ~300MB.)

### 2. Add eBay API keys

Comps need them. They're free:

1. Sign up at [developer.ebay.com](https://developer.ebay.com)
2. Create an app, take the **Production** keyset
3. Either put them in `config.json` under `ebay`, or:

```bash
export EBAY_CLIENT_ID=...
export EBAY_CLIENT_SECRET=...
```

Without keys everything still runs — you just get lots with no pricing, and a
banner telling you why.

### 3. Check the buyer's premium

`economics.buyersPremiumPct` defaults to 15%. AuctionNinja sellers set their own,
commonly 15–18%. It's the single biggest input to the spread, so it's worth
confirming against a sale you actually care about.

---

## Why the spread number is smaller than you'd expect

A naive version of this tool would compute `ebay_price − current_bid ≥ 250` and
hand you a list of money-losers. The round trip costs roughly 45%:

| | |
|---|---|
| Buyer's premium | 15% on top of hammer |
| CT sales tax | 6.35% on hammer + premium |
| eBay final value fee | 13.35% of sale |
| eBay per-order fee | $0.40 |
| Shipping | ~$12 assumed |
| Ask → sale haircut | asks discounted to 75% |

Worked example, straight from the test suite:

> Bid $300 on something with $550 eBay comps.
> Naive gross spread: **$250** — looks like a hit.
> Actual net: **$97.27**.

So the app leads with two numbers per lot:

- **Net spread** — what you'd actually clear at the current bid
- **Bid up to** — the highest hammer price that still clears your $250 target

That second number is the one you want at the keyboard when a lot is closing.

### About "sold" comps

eBay's Browse API returns **active listings**, which are asks, not sales.
Real sold-price data lives behind the Marketplace Insights API, which requires a
business-justification application most developers don't get. So active asks are
discounted by `askToSaleRatio` (0.75, deliberately conservative).

If you get Insights access: implement `searchSold()` in `src/comps/ebay.js` with
the same return shape and set `askToSaleRatio` to `1.0`. Nothing else changes.

---

## Why some lots are hidden

Auto-matching "Vintage Sterling Reed & Barton Serving Spoon" to eBay comps is
the most error-prone part of this, and a confident-looking $400 spread built on
comps for the wrong object costs you a drive and a bid. So each match gets a
confidence score from: a recognized maker in the title, comp count, how tightly
the comp prices agree, title overlap, and a penalty for "box lot of assorted"
listings that can't be comped against single items.

Below 45% they're hidden by default — slide the confidence control down to see
them. **Every lot shows the comps it used, with links.** Check them before you
bid; the score is a filter, not a verdict.

---

## Commands

| | |
|---|---|
| `npm start` | web app on :4317 |
| `npm run refresh` | scrape + comp + score, print hits |
| `npm run probe` | diagnose the scraper against the live site |
| `npm run doctor` | check config, credentials, connectivity |
| `npm test` | 19 unit tests |

## Layout

```
src/
  sources/auctionninja.js   4 extraction strategies + shape-matching
  comps/ebay.js             Browse API (OAuth client credentials)
  economics.js              fees, net spread, max-bid inversion
  match.js                  query building + confidence scoring
  pipeline.js               orchestration
  probe.js                  scraper diagnostics
  store.js                  JSON store, bid history
web/                        the UI
```

Data lives in `data/` as JSON — small enough that SQLite would only have made
`npm install` fragile. Lot bids are kept as history, so you can see what's
heating up. Comps are cached 72h; lots ended >30 days are pruned.

## Being a good citizen

Requests are throttled to one per 1.5s per host, detail fetches are capped at 60
per run, and comps are cached hard. Don't crank those down — this is a personal
tool hitting a small company's site.
