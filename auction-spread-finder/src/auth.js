import crypto from 'node:crypto';

/**
 * Password gate for hosted deployments.
 *
 * Deliberately minimal: one shared password, set via the APP_PASSWORD env var.
 * There are no user accounts because there is exactly one user. What it must
 * get right is that a public URL should not expose your API keys or let a
 * stranger press Refresh and spend your Apify credit.
 *
 * The session cookie is "<expiry>.<hmac>", signed with a key derived from the
 * password itself. Deriving rather than randomizing means sessions survive a
 * restart (hosts restart often), and changing the password invalidates every
 * existing session for free.
 */

const COOKIE = 'asf_session';
const SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days

export function isEnabled() {
  return Boolean(process.env.APP_PASSWORD);
}

function signingKey() {
  return crypto
    .createHash('sha256')
    .update(`asf-session-v1:${process.env.APP_PASSWORD}`)
    .digest();
}

function sign(expiry) {
  return crypto.createHmac('sha256', signingKey()).update(String(expiry)).digest('hex');
}

export function createSessionCookie() {
  const expiry = Date.now() + SESSION_MS;
  const value = `${expiry}.${sign(expiry)}`;
  const parts = [
    `${COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  // Hosts terminate TLS in front of us, so Secure is right in production but
  // would break plain-HTTP local testing.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function hasValidSession(req) {
  if (!isEnabled()) return true;

  const cookies = parseCookies(req.headers.cookie ?? '');
  const raw = cookies[COOKIE];
  if (!raw) return false;

  const [expiryStr, mac] = raw.split('.');
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now() || !mac) return false;

  return timingSafeEqualHex(mac, sign(expiry));
}

/** Constant-time password check, so the endpoint can't be probed by timing. */
export function checkPassword(candidate) {
  if (!isEnabled()) return true;
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(process.env.APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export const LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Auction Spread Finder</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:#0f1115; color:#e8eaed;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  form { background:#171a21; border:1px solid #2a2f3a; border-radius:12px;
    padding:28px; width:min(340px,90vw); display:grid; gap:14px; }
  h1 { margin:0; font-size:17px; }
  p { margin:0; color:#9aa3b2; font-size:13px; }
  input { padding:10px 12px; border-radius:8px; border:1px solid #2a2f3a;
    background:#0f1115; color:#e8eaed; font-size:15px; }
  button { padding:10px; border-radius:8px; border:0; background:#4ade80;
    color:#04140a; font-weight:600; font-size:15px; cursor:pointer; }
  .err { color:#f87171; font-size:13px; }
</style></head>
<body>
  <form method="POST" action="/login">
    <h1>Auction Spread Finder</h1>
    <p>Enter your password.</p>
    <input type="password" name="password" autofocus required
           autocomplete="current-password" aria-label="Password">
    <button type="submit">Sign in</button>
    __ERROR__
  </form>
</body></html>`;
