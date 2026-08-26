import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, saveSettings } from './config.js';
import { getOpportunities, refresh } from './pipeline.js';
import {
  isEnabled as authEnabled, hasValidSession, checkPassword,
  createSessionCookie, clearSessionCookie, LOGIN_PAGE,
} from './auth.js';

const WEB_DIR = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let refreshState = { running: false, startedAt: null, log: [], lastSummary: null };

export function startServer() {
  const cfg = loadConfig();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${cfg.server.port}`);

    try {
      // Health checks arrive without a cookie, so this sits before the gate.
      // It deliberately reveals nothing beyond liveness.
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }

      /* ---- auth gate ---- */
      if (url.pathname === '/login' && req.method === 'POST') {
        const body = await readForm(req);
        if (checkPassword(body.password)) {
          res.writeHead(303, { Location: '/', 'Set-Cookie': createSessionCookie() });
          return res.end();
        }
        res.writeHead(401, { 'Content-Type': 'text/html' });
        return res.end(LOGIN_PAGE.replace('__ERROR__', '<div class="err">Wrong password.</div>'));
      }

      if (url.pathname === '/logout') {
        res.writeHead(303, { Location: '/', 'Set-Cookie': clearSessionCookie() });
        return res.end();
      }

      if (!hasValidSession(req)) {
        // APIs get a clean 401; humans get the login form.
        if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Not signed in.' });
        res.writeHead(401, { 'Content-Type': 'text/html' });
        return res.end(LOGIN_PAGE.replace('__ERROR__', ''));
      }

      if (url.pathname === '/api/opportunities') {
        const overrides = {};
        if (url.searchParams.has('minSpread')) overrides.minSpreadDollars = Number(url.searchParams.get('minSpread'));
        if (url.searchParams.has('minConfidence')) overrides.minConfidence = Number(url.searchParams.get('minConfidence'));
        return json(res, 200, getOpportunities(overrides));
      }

      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        if (refreshState.running) return json(res, 409, { error: 'A refresh is already running.' });
        refreshState = { running: true, startedAt: new Date().toISOString(), log: [], lastSummary: null };
        // Fire and forget; the UI polls /api/refresh-status.
        refresh({ onProgress: (msg) => refreshState.log.push(msg) })
          .then((summary) => { refreshState.lastSummary = summary; })
          .catch((err) => { refreshState.log.push(`ERROR: ${err.message}`); })
          .finally(() => { refreshState.running = false; });
        return json(res, 202, { started: true });
      }

      if (url.pathname === '/api/refresh-status') {
        return json(res, 200, refreshState);
      }

      if (url.pathname === '/api/config') {
        // Re-read from disk so a settings save takes effect without a restart.
        const fresh = loadConfig();
        // Never ship secrets to the browser -- only whether they're present.
        const safe = structuredClone(fresh);
        safe.ebay = {
          ...safe.ebay,
          clientId: '',
          clientSecret: '',
          hasCredentials: Boolean(fresh.ebay.clientId && fresh.ebay.clientSecret),
        };
        safe.apify = {
          ...safe.apify,
          token: '',
          hasToken: Boolean(fresh.apify?.token),
        };
        safe.authEnabled = authEnabled();
        return json(res, 200, safe);
      }

      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        saveSettings(body);
        return json(res, 200, { saved: true });
      }

      return serveStatic(url.pathname, res);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });

  const host = cfg.server.host ?? '127.0.0.1';

  // Refuse to be reachable from the network without a password. This app holds
  // your eBay and Apify keys and has a Refresh button that spends real credit,
  // so an open deployment is a genuine hazard, not a nitpick.
  if (host !== '127.0.0.1' && host !== 'localhost' && !authEnabled()) {
    console.error(
      '\n  REFUSING TO START.\n\n' +
      `  The server was told to listen on ${host}, which makes it reachable from\n` +
      '  the network, but APP_PASSWORD is not set. That would expose your API keys.\n\n' +
      '  Set an APP_PASSWORD environment variable, or bind to 127.0.0.1 instead.\n'
    );
    process.exit(1);
  }

  server.listen(cfg.server.port, host, () => {
    console.log(`\n  Auction spread finder is running.`);
    console.log(`  Open this in your browser:  http://localhost:${cfg.server.port}`);
    if (authEnabled()) console.log('  Password protection: ON');
    console.log(`\n  Leave this window open while you use it. Press Ctrl+C to stop.\n`);
  });

  startAutoRefresh(cfg);
  return server;
}

/**
 * Hosted deployments refresh themselves, so the data is already current when
 * you open the page. Off by default (0) for local use, where you press Refresh.
 */
function startAutoRefresh(cfg) {
  const hours = Number(cfg.server.refreshIntervalHours ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) return;

  const run = () => {
    if (refreshState.running) return;
    refreshState = { running: true, startedAt: new Date().toISOString(), log: [], lastSummary: null };
    refresh({ onProgress: (m) => refreshState.log.push(m) })
      .then((s) => { refreshState.lastSummary = s; console.log(`[auto-refresh] ${s.lotsFound} lots, ${s.lotsPriced} priced`); })
      .catch((err) => console.error(`[auto-refresh] failed: ${err.message}`))
      .finally(() => { refreshState.running = false; });
  };

  console.log(`  Auto-refresh: every ${hours}h`);
  setTimeout(run, 10_000).unref?.();          // once shortly after boot
  setInterval(run, hours * 3_600_000).unref?.();
}

/** Parse a urlencoded form body (the login form posts one). */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on('error', reject);
  });
}

/** Read and parse a JSON request body, with a size cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON in request body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = path.join(WEB_DIR, rel);
  // Prevent path traversal out of web/.
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}
