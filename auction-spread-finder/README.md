# Auction Spread Finder

A web app on your own computer that you open each morning. It scrapes recent
AuctionNinja lots near 06897, prices each one against eBay comps, and shows you
the ones where the **net** spread clears $250.

## Starting it (no terminal needed)

**Mac:** double-click **`Start on Mac.command`**
**Windows:** double-click **`Start on Windows.bat`**

Your browser opens to the app. Leave the little black window open while you use
it; closing it stops the app. That's the whole daily routine — double-click,
then hit **Refresh**.

The first launch takes about a minute (it's installing itself) and will tell you
if you need [Node.js](https://nodejs.org) first — that's a one-time download,
big green LTS button, standard installer.

<details>
<summary>Terminal commands, if you prefer them</summary>

```
npm install
npm start          # http://localhost:4317
npm run refresh    # scrape + price without opening the app
npm run doctor     # check what's working
npm run probe      # diagnose the scraper
npm test           # 19 unit tests
```
</details>

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

All of this lives in the **Settings** button at the top of the app — no files to
edit.

### 1. Point it at the right AuctionNinja pages

Their browse URLs aren't documented and I couldn't observe them, so rather than
guessing a scheme, the app watches **URLs you paste from your browser**. Search
AuctionNinja however you like — by your zip, by radius, by category — copy the
address bar, and paste it into Settings. One per line.

### 2. Add eBay API keys

The app needs these to look up prices. They're free but the signup is a
developer portal, so it's the fiddliest ten minutes of the setup:

1. Sign up at [developer.ebay.com](https://developer.ebay.com)
2. Create an app, then open the **Production** keyset
3. Copy the **App ID** and **Cert ID** into Settings

Without them everything still runs — you just get lots with no pricing, and a
banner saying why.

### 3. Check the buyer's premium

Settings defaults to 15%. AuctionNinja sellers set their own, commonly 15–18%,
and it's the single biggest input to the spread — worth confirming against a
sale you actually care about.

### 4. Confirm the scraper works

Press **Refresh**. If lots appear, you're done.

If you get a banner saying no lots could be extracted, the site's markup doesn't
match what this expects. That needs a developer — see
[Fixing the scraper](#fixing-the-scraper) below.

## Fixing the scraper

This is the one part that may need a developer, so it's worth knowing why.

This app was built in a sandbox that couldn't reach auctionninja.com, so its
markup was never observed directly. The extractor is written to *discover*
structure rather than assume it — the main strategy walks whatever JSON the page
embeds and matches objects by shape (something with a title, a price, and an id)
instead of by field name, so it survives most front-end changes. But if all four
strategies miss, someone has to look.

```bash
npm run probe
```

`probe` fetches each page, tries every strategy, and reports which fired. If
none did, it saves the raw HTML and prints the page's actual class names,
script-tag counts, and whether prices appear in the HTML at all. That's enough
for a developer to either fix a selector in `src/sources/auctionninja.js` (the
only place selectors live) or conclude the page is client-rendered.

If it reports client-side rendering:

```bash
npm install playwright && npx playwright install chromium
```

The scraper then falls back to a real browser automatically. Playwright is
deliberately *not* a default dependency — it pulls ~300MB.

---

## Running it every day

### Why this runs locally and not on Vercel/Netlify/Lambda

Four reasons, the first of which is fatal:

1. **Datacenter IPs get blocked.** Scrapers running from AWS/Vercel ranges are
   flagged constantly; the same request from your laptop's residential IP looks
   like a normal browser. This is exactly what blocked the sandbox this was
   built in. You can't cheaply engineer around it — a VPS has the same problem.
2. **Serverless has execution limits.** A refresh throttles requests at 1.5s and
   can make up to 60 comp lookups. That's minutes, not the 10–60s a function
   gets.
3. **No persistent filesystem.** The store writes JSON to `data/`. Serverless
   disks are ephemeral, so bid history and the comp cache would vanish between
   invocations — you'd need to port the store to a hosted database first.
4. **Playwright.** If AuctionNinja turns out to be client-rendered, you need a
   headless browser, which is painful to fit inside a serverless bundle.

Plus it's a single-user tool holding your eBay API keys. There's no upside to
putting it on the public internet.

### The setup that matches "open it each day"

Leave the server running and refresh the data on a schedule. The server reads
the store fresh on every request, so a background refresh shows up the next time
you load the page — no restart needed.

**macOS / Linux** — `crontab -e`, then (adjust the path):

```cron
# Refresh at 7am daily
0 7 * * * cd /path/to/auction-spread-finder && /usr/bin/env node bin/cli.js refresh >> data/cron.log 2>&1
```

Keep the server up across reboots with [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start "npm start" --name auctions
pm2 save && pm2 startup     # run the command it prints
```

Then bookmark `http://localhost:4317` and open it with your coffee.

**Windows** — Task Scheduler, daily trigger, action `node`, argument
`bin/cli.js refresh`, "start in" set to the project folder.

**Don't want a scheduler?** Just hit **Refresh** in the UI. It runs the same
pipeline and shows progress. The scheduler only buys you fresh data at open.

### Reaching it from your phone

Don't port-forward it. Install [Tailscale](https://tailscale.com) on your laptop
and phone — both land on the same private network and `http://<laptop>:4317`
works from the couch, with the scraping still going out over your home IP.

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
