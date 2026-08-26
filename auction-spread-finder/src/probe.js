import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { ROOT, loadConfig } from './config.js';
import { scrapeSource } from './sources/auctionninja.js';

/**
 * Diagnostic mode. Because AuctionNinja's markup was never observed directly
 * while this was written, the scraper WILL eventually need a nudge. This tells
 * you exactly what the page contained and which strategy got closest, so the
 * fix is a small edit rather than an investigation.
 */
export async function probe() {
  const cfg = loadConfig();
  const outDir = path.join(ROOT, 'data', 'probe');
  fs.mkdirSync(outDir, { recursive: true });

  for (const source of cfg.sources.filter((s) => s.enabled !== false)) {
    console.log(`\n${'='.repeat(70)}\nPROBE: ${source.url}\n${'='.repeat(70)}`);

    const report = await scrapeSource(source);

    if (report.error) {
      console.log(`\n  FETCH FAILED: ${report.error}`);
      console.log('  If this is a 403, the site is blocking non-browser requests.');
      console.log('  Try: npm install playwright && npx playwright install chromium');
      continue;
    }

    const file = path.join(outDir, `${slug(source.url)}.html`);
    fs.writeFileSync(file, report.html);
    console.log(`\n  Saved page HTML (${(report.html.length / 1024).toFixed(0)} KB) to:`);
    console.log(`    ${path.relative(ROOT, file)}`);

    console.log('\n  Strategy results:');
    for (const t of report.strategiesTried) {
      console.log(`    ${t.found > 0 ? 'OK  ' : '--  '} ${t.strategy.padEnd(24)} ${t.found} lots`);
    }
    if (report.renderError) {
      console.log(`\n  Browser render: ${report.renderError}`);
    }

    if (report.lots.length > 0) {
      console.log(`\n  WORKING via "${report.strategy}". Sample:`);
      for (const lot of report.lots.slice(0, 3)) {
        console.log(`    - ${lot.title.slice(0, 60)}`);
        console.log(`      bid=$${lot.currentBid}  url=${(lot.url ?? '(none)').slice(0, 60)}`);
      }
      continue;
    }

    // Nothing worked -- dump the clues needed to fix it.
    console.log('\n  NO LOTS EXTRACTED. Diagnostics:\n');
    const $ = cheerio.load(report.html);

    const scripts = $('script').length;
    const jsonScripts = $('script[type="application/json"], #__NEXT_DATA__').length;
    const ldScripts = $('script[type="application/ld+json"]').length;
    console.log(`    <script> tags: ${scripts} (json: ${jsonScripts}, ld+json: ${ldScripts})`);

    // Most common class names -- the raw material for a new selector set.
    const classCounts = new Map();
    $('[class]').each((_, el) => {
      for (const c of ($(el).attr('class') ?? '').split(/\s+/)) {
        if (c) classCounts.set(c, (classCounts.get(c) ?? 0) + 1);
      }
    });
    const top = [...classCounts.entries()]
      .filter(([c]) => /card|item|lot|auction|product|tile|listing|grid/i.test(c))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    if (top.length > 0) {
      console.log('\n    Promising class names on the page (repeat counts):');
      for (const [c, n] of top) console.log(`      .${c}  x${n}`);
      console.log('\n    -> Add a matching entry to SELECTOR_SETS in');
      console.log('       src/sources/auctionninja.js');
    } else {
      console.log('\n    No lot-like class names found. The page is almost certainly');
      console.log('    rendered client-side. Install Playwright and re-probe:');
      console.log('      npm install playwright && npx playwright install chromium');
    }

    // Does the raw HTML even contain dollar amounts?
    const dollars = (report.html.match(/\$\s?\d[\d,]*/g) ?? []).length;
    console.log(`\n    Dollar amounts in raw HTML: ${dollars}`);
    if (dollars === 0) {
      console.log('    Zero prices in the HTML confirms client-side rendering.');
    }
  }

  console.log('\n');
}

function slug(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 80);
}
