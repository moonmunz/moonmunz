#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { refresh, getOpportunities } from '../src/pipeline.js';
import { startServer } from '../src/server.js';
import { probe } from '../src/probe.js';
import { doctor } from '../src/doctor.js';

const [, , cmd = 'serve'] = process.argv;

switch (cmd) {
  case 'serve': {
    startServer();
    break;
  }

  case 'refresh': {
    console.log('Refreshing...\n');
    const summary = await refresh({ onProgress: (m) => console.log(`  ${m}`) });
    console.log('\nDone.');
    console.log(`  sources ok/failed : ${summary.sourcesOk}/${summary.sourcesFailed}`);
    console.log(`  lots found        : ${summary.lotsFound} (${summary.lotsNew} new)`);
    console.log(`  lots priced       : ${summary.lotsPriced}`);
    console.log(`  comp lookups      : ${summary.compLookups} (${summary.compsCached} from cache)`);

    for (const w of summary.warnings) console.log(`\n  WARNING: ${w}`);
    for (const e of summary.errors) console.log(`\n  ERROR: ${e}`);

    const { opportunities, stats } = getOpportunities();
    const cfg = loadConfig();
    console.log(`\n${opportunities.length} lots clear a $${cfg.filters.minSpreadDollars} net spread:\n`);
    for (const lot of opportunities.slice(0, 20)) {
      console.log(`  $${String(lot.valuation.netSpread).padStart(7)}  ${lot.title.slice(0, 55)}`);
      console.log(`            bid $${lot.currentBid} -> est. sale $${lot.valuation.market.estimatedSalePrice}` +
                  `  (confidence ${(lot.confidence.score * 100).toFixed(0)}%)`);
    }
    if (stats.totalPriced === 0) {
      console.log('  (nothing priced yet -- see warnings above)');
    }
    break;
  }

  case 'probe': {
    await probe();
    break;
  }

  case 'doctor': {
    await doctor();
    break;
  }

  default:
    console.log(`
Usage: npm run <command>

  serve     Start the web app (default)        http://localhost:4317
  refresh   Scrape + comp + score, print hits
  probe     Diagnose the AuctionNinja scraper against the live site
  doctor    Check config, credentials, and connectivity
`);
}
