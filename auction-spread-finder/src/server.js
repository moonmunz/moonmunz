import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, saveSettings } from './config.js';
import { getOpportunities, refresh } from './pipeline.js';

const WEB_DIR = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let refreshState = { running: false, startedAt: null, log: [], lastSummary: null };

export function startServer() {
  const cfg = loadConfig();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${cfg.server.port}`);

    try {
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
  server.listen(cfg.server.port, host, () => {
    console.log(`\n  Auction spread finder is running.`);
    console.log(`  Open this in your browser:  http://localhost:${cfg.server.port}`);
    console.log(`\n  Leave this window open while you use it. Press Ctrl+C to stop.\n`);
  });
  return server;
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
