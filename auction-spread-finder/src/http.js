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

/**
 * Strip credentials out of a URL before it can reach a log, an error banner,
 * or a screenshot. Apify passes the API token as a query parameter, so any
 * error message quoting the raw URL would expose it.
 */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const key of ['token', 'apiKey', 'api_key', 'access_token', 'key', 'secret']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    // Not a parseable URL -- scrub anything that looks like a token anyway.
    return String(url).replace(/([?&](?:token|apiKey|api_key|access_token|key|secret)=)[^&\s]+/gi, '$1***');
  }
}

export async function fetchText(url, opts = {}) {
  await throttle(url);
  const ctrl = new AbortController();
  // Most requests are page fetches that should fail fast. Some legitimately
  // take minutes -- an Apify run-sync call starts an Actor and waits for it to
  // finish -- so those pass their own budget rather than being cut off at the
  // default and reported as "operation was aborted".
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? cfg.http.timeoutMs);
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
      // APIs explain rejections in the body -- which field was wrong, what was
      // expected. Discarding it leaves a bare status code that nobody can act
      // on, so read it and put it in the message.
      let detail = '';
      try {
        const body = (await res.text()).slice(0, 400);
        const parsed = safeJson(body);
        const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? body;
        if (message) detail = ` — ${scrubSecrets(String(message)).trim()}`;
      } catch {
        // Body unreadable; the status alone will have to do.
      }

      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${redactUrl(url)}${detail}`);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Error bodies can echo the request; never let a credential through. */
function scrubSecrets(s) {
  return s.replace(/(apify_api_|token=|Bearer )\S+/gi, '$1***');
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
