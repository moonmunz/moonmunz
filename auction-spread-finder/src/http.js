import { loadConfig } from './config.js';

const cfg = loadConfig();
const lastHit = new Map();

/** Politeness: never hammer the same host faster than config.http.delayMs. */
async function throttle(url) {
  const host = new URL(url).host;
  const since = Date.now() - (lastHit.get(host) ?? 0);
  if (since < cfg.http.delayMs) {
    await new Promise((r) => setTimeout(r, cfg.http.delayMs - since));
  }
  lastHit.set(host, Date.now());
}

export async function fetchText(url, opts = {}) {
  await throttle(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.http.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': cfg.http.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
      ...opts,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: { Accept: 'application/json', ...opts.headers },
  });
  return JSON.parse(text);
}

/**
 * Optional Playwright rendering, for when a page turns out to be a JS-rendered
 * SPA with no useful HTML in the initial response. Playwright is an optional
 * dependency -- if it isn't installed we say so clearly rather than crashing.
 */
export async function renderPage(url) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    const err = new Error(
      'This page needs a real browser to render, but Playwright is not installed.\n' +
      'Install it with:  npm install playwright && npx playwright install chromium'
    );
    err.code = 'NO_PLAYWRIGHT';
    throw err;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: cfg.http.userAgent });
    await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.http.timeoutMs });
    // Give lazy-loaded lot grids a beat to populate.
    await page.waitForTimeout(2000);
    return await page.content();
  } finally {
    await browser.close();
  }
}
