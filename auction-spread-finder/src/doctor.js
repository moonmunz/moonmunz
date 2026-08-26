import { loadConfig } from './config.js';
import { Store } from './store.js';
import { fetchText } from './http.js';
import { searchActive } from './comps/ebay.js';

/** Preflight check: is this thing actually able to do its job right now? */
export async function doctor() {
  const cfg = loadConfig();
  const checks = [];

  /* Node version */
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node version',
    ok: major >= 18,
    detail: `v${process.versions.node}${major >= 18 ? '' : ' -- needs v18+ for built-in fetch'}`,
  });

  /* Sources reachable */
  for (const source of cfg.sources.filter((s) => s.enabled !== false)) {
    try {
      const html = await fetchText(source.url);
      const dollars = (html.match(/\$\s?\d[\d,]*/g) ?? []).length;
      checks.push({
        name: `Source: ${source.name}`,
        ok: true,
        detail: `reachable, ${(html.length / 1024).toFixed(0)} KB, ${dollars} prices in raw HTML` +
                (dollars === 0 ? ' (likely client-rendered -- Playwright may be needed)' : ''),
      });
    } catch (err) {
      checks.push({ name: `Source: ${source.name}`, ok: false, detail: err.message });
    }
  }

  /* eBay credentials */
  if (!cfg.ebay.clientId || !cfg.ebay.clientSecret) {
    checks.push({
      name: 'eBay API',
      ok: false,
      detail: 'no credentials -- comps disabled. Get free keys at developer.ebay.com',
    });
  } else {
    try {
      const comps = await searchActive('sterling silver candlestick', cfg, { limit: 5 });
      checks.push({ name: 'eBay API', ok: true, detail: `working (test query returned ${comps.length} comps)` });
    } catch (err) {
      checks.push({ name: 'eBay API', ok: false, detail: err.message });
    }
  }

  /* Playwright */
  try {
    await import('playwright');
    checks.push({ name: 'Playwright', ok: true, detail: 'installed (client-rendered pages supported)' });
  } catch {
    checks.push({
      name: 'Playwright',
      ok: null,
      detail: 'not installed -- only needed if AuctionNinja renders client-side',
    });
  }

  /* Stored data */
  const store = new Store();
  const lots = store.allLots();
  const priced = lots.filter((l) => l.valuation).length;
  checks.push({
    name: 'Local data',
    ok: true,
    detail: `${lots.length} lots tracked, ${priced} priced, last run ${store.lastRun()?.at ?? 'never'}`,
  });

  console.log('\nAuction spread finder -- system check\n');
  for (const c of checks) {
    const mark = c.ok === true ? ' OK ' : c.ok === false ? 'FAIL' : ' -- ';
    console.log(`  [${mark}] ${c.name.padEnd(22)} ${c.detail}`);
  }
  console.log('');

  const failures = checks.filter((c) => c.ok === false);
  if (failures.length > 0) {
    console.log(`${failures.length} problem(s) to fix before this produces results.\n`);
  }
}
