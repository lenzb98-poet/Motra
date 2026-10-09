// Motra sync server (Cloudflare Worker).
// Serves the app's static files and a small API under /api/:
//   login with password + authenticator code (TOTP), sessions in an HttpOnly cookie,
//   and one encrypted data document per user in D1.
//
// Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   ALLOWED_EMAILS  comma-separated addresses that may use sync
//   DATA_KEY        base64 of 32 random bytes, encrypts data and 2FA secrets at rest
//   SETUP_CODE      one-time code needed to set the very first password of an account

const SESSION_DAYS = 90;
const PENDING_MINUTES = 15;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_BODY = 2_000_000;
const COOKIE = 'motra_session';
const TOTP_STEP = 30;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY,
     pw_salt TEXT NOT NULL,
     pw_hash TEXT NOT NULL,
     totp_enc TEXT,
     totp_pending_enc TEXT,
     totp_last_step INTEGER NOT NULL DEFAULT 0,
     recovery TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     stage TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email)`,
  `CREATE TABLE IF NOT EXISTS attempts (
     key TEXT PRIMARY KEY,
     fails INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS documents (
     email TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     payload TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

let schemaReady = null;
const ensureSchema = db => (schemaReady ??= db.batch(SCHEMA.map(sql => db.prepare(sql))).catch(e => { schemaReady = null; throw e; }));

class HttpError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.status = status;
    this.body = { error, ...extra };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json(e.body, e.status);
      console.error(e);
      return json({ error: 'server' }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  const method = request.method;
  const route = `${method} ${url.pathname}`;

  // Same-origin JSON API only: blocks cross-site form posts even without SameSite support.
  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'origin');
    if (request.headers.get('X-Motra') !== '1') throw new HttpError(403, 'header');
  }

  if (!configured(env)) {
    if (route === 'GET /api/status') return json({ configured: false, user: null });
    throw new HttpError(503, 'not_configured');
  }
  await ensureSchema(env.DB);

  switch (route) {
    case 'GET /api/status': {
      const s = await currentSession(request, env);
      return json({ configured: true, user: s ? { email: s.email, stage: s.stage } : null });
    }
    case 'POST /api/start': return start(request, env);
    case 'POST /api/register': return register(request, env);
    case 'POST /api/login': return login(request, env);
    case 'POST /api/2fa/setup': return totpSetup(request, env);
    case 'POST /api/2fa/confirm': return totpConfirm(request, env);
    case 'POST /api/2fa/verify': return totpVerify(request, env);
    case 'GET /api/data': return getData(request, env);
    case 'PUT /api/data': return putData(request, env);
    case 'POST /api/logout': return logout(request, env);
    default: throw new HttpError(404, 'not_found');
  }
}

/* ---------------- account & login ---------------- */

const allowedEmails = env => (env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const configured = env => !!(env.DB && env.DATA_KEY && env.ALLOWED_EMAILS && env.SETUP_CODE);
const normEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const getUser = (env, email) => env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();

// Tells the app whether this address still needs its first password.
// Unknown addresses answer "existing" so the reply doesn't reveal who is allowed.
async function start(request, env) {
  const { email } = await body(request);
  const e = normEmail(email);
  if (!allowedEmails(env).includes(e)) return json({ status: 'existing' });
  const user = await getUser(env, e);
  return json({ status: user ? 'existing' : 'new' });
}

async function register(request, env) {
  const { email, key, setupCode } = await body(request);
  const e = normEmail(email);
  const ip = clientIp(request);
  await checkLock(env, `ip:${ip}`);
  await checkLock(env, `setup:${e}`);
  if (!allowedEmails(env).includes(e) || !isKey(key)) {
    await fail(env, `ip:${ip}`);
    throw new HttpError(400, 'invalid');
  }
  if (await getUser(env, e)) throw new HttpError(409, 'exists');
  if (typeof setupCode !== 'string' || !(await safeEqual(setupCode.trim(), env.SETUP_CODE))) {
    await fail(env, `setup:${e}`);
    await fail(env, `ip:${ip}`);
    throw new HttpError(403, 'setup_code');
  }
  const salt = randomBytes(16);
  const hash = await sha256Hex(concat(salt, hexToBytes(key)));
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO users (email, pw_salt, pw_hash, created_at) VALUES (?, ?, ?, ?)',
  ).bind(e, b64(salt), hash, Date.now()).run();
  if (!res.meta.changes) throw new HttpError(409, 'exists');
  await clear(env, `setup:${e}`);
  return sessionResponse(env, e, 'setup2fa', { next: 'setup2fa' });
}

async function login(request, env) {
  const { email, key } = await body(request);
  const e = normEmail(email);
  const ip = clientIp(request);
  await checkLock(env, `ip:${ip}`);
  await checkLock(env, `pw:${e}`);
  const user = allowedEmails(env).includes(e) ? await getUser(env, e) : null;
  const ok = user && isKey(key) && (await safeEqual(await sha256Hex(concat(unb64(user.pw_salt), hexToBytes(key))), user.pw_hash));
  if (!ok) {
    await fail(env, `pw:${e}`);
    await fail(env, `ip:${ip}`);
    throw new HttpError(401, 'credentials');
  }
  await clear(env, `pw:${e}`);
  if (user.totp_enc) return sessionResponse(env, e, 'pending2fa', { next: 'totp' });
  return sessionResponse(env, e, 'setup2fa', { next: 'setup2fa' });
}

async function totpSetup(request, env) {
  const s = await requireSession(request, env, 'setup2fa');
  const secret = randomBytes(20);
  await env.DB.prepare('UPDATE users SET totp_pending_enc = ? WHERE email = ?')
    .bind(await encrypt(env, base32(secret)), s.email).run();
  const secretText = base32(secret);
  const label = encodeURIComponent(`Motra:${s.email}`);
  const uri = `otpauth://totp/${label}?secret=${secretText}&issuer=Motra&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
  return json({ secret: secretText, uri });
}

async function totpConfirm(request, env) {
  const s = await requireSession(request, env, 'setup2fa');
  const { code } = await body(request);
  await checkLock(env, `totp:${s.email}`);
  const user = await getUser(env, s.email);
  if (!user?.totp_pending_enc) throw new HttpError(400, 'no_setup');
  const secret = await decrypt(env, user.totp_pending_enc);
  const step = await verifyTotp(secret, code, 0);
  if (step == null) {
    await fail(env, `totp:${s.email}`);
    throw new HttpError(401, 'code');
  }
  await clear(env, `totp:${s.email}`);
  const codes = Array.from({ length: 8 }, recoveryCode);
  const hashes = await Promise.all(codes.map(c => sha256Hex(normRecovery(c))));
  await env.DB.prepare(
    'UPDATE users SET totp_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = ?, recovery = ? WHERE email = ?',
  ).bind(step, JSON.stringify(hashes), s.email).run();
  await dropSession(env, s.tokenHash);
  return sessionResponse(env, s.email, 'full', { recoveryCodes: codes });
}

async function totpVerify(request, env) {
  const s = await requireSession(request, env, 'pending2fa');
  const { code } = await body(request);
  await checkLock(env, `totp:${s.email}`);
  const user = await getUser(env, s.email);
  if (!user?.totp_enc) throw new HttpError(400, 'no_2fa');

  let ok = false;
  const digits = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (/^\d{6}$/.test(digits)) {
    const step = await verifyTotp(await decrypt(env, user.totp_enc), digits, user.totp_last_step);
    if (step != null) {
      // Only accept a step newer than the last one used, so a seen code can't be replayed.
      const res = await env.DB.prepare('UPDATE users SET totp_last_step = ? WHERE email = ? AND totp_last_step < ?')
        .bind(step, s.email, step).run();
      ok = res.meta.changes === 1;
    }
  } else if (typeof code === 'string' && code.trim()) {
    const hash = await sha256Hex(normRecovery(code));
    const list = JSON.parse(user.recovery || '[]');
    if (list.includes(hash)) {
      const rest = JSON.stringify(list.filter(h => h !== hash));
      const res = await env.DB.prepare('UPDATE users SET recovery = ? WHERE email = ? AND recovery = ?')
        .bind(rest, s.email, user.recovery).run();
      ok = res.meta.changes === 1;
    }
  }
  if (!ok) {
    await fail(env, `totp:${s.email}`);
    throw new HttpError(401, 'code');
  }
  await clear(env, `totp:${s.email}`);
  await dropSession(env, s.tokenHash);
  return sessionResponse(env, s.email, 'full', { ok: true });
}

async function logout(request, env) {
  const s = await currentSession(request, env, { touch: false });
  if (s) await dropSession(env, s.tokenHash);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
}

/* ---------------- data ---------------- */

async function getData(request, env) {
  const s = await requireSession(request, env, 'full');
  const row = await env.DB.prepare('SELECT version, payload FROM documents WHERE email = ?').bind(s.email).first();
  if (!row) return json({ version: 0, data: null });
  return json({ version: row.version, data: JSON.parse(await decrypt(env, row.payload)) });
}

async function putData(request, env) {
  const s = await requireSession(request, env, 'full');
  const { baseVersion, data } = await body(request);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new HttpError(400, 'version');
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries) || !Array.isArray(data.meds)) {
    throw new HttpError(400, 'data');
  }
  const payload = await encrypt(env, JSON.stringify(data));
  const now = Date.now();
  let res;
  if (baseVersion === 0) {
    res = await env.DB.prepare('INSERT OR IGNORE INTO documents (email, version, payload, updated_at) VALUES (?, 1, ?, ?)')
      .bind(s.email, payload, now).run();
  } else {
    res = await env.DB.prepare('UPDATE documents SET version = version + 1, payload = ?, updated_at = ? WHERE email = ? AND version = ?')
      .bind(payload, now, s.email, baseVersion).run();
  }
  if (!res.meta.changes) {
    // Another device saved in between: hand back the newer state so the app can merge and retry.
    const row = await env.DB.prepare('SELECT version, payload FROM documents WHERE email = ?').bind(s.email).first();
    return json({ error: 'conflict', version: row?.version ?? 0, data: row ? JSON.parse(await decrypt(env, row.payload)) : null }, 409);
  }
  return json({ version: baseVersion + 1 });
}

/* ---------------- sessions ---------------- */

async function sessionResponse(env, email, stage, payload) {
  const token = b64url(randomBytes(32));
  const now = Date.now();
  const ttl = stage === 'full' ? SESSION_DAYS * 86400_000 : PENDING_MINUTES * 60_000;
  await env.DB.prepare('INSERT INTO sessions (token_hash, email, stage, created_at, last_used, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), email, stage, now, now, now + ttl).run();
  // Occasional cleanup of expired sessions.
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return json({ stage, ...payload }, 200, { 'Set-Cookie': cookie(token, Math.round(ttl / 1000)) });
}

async function currentSession(request, env, { touch = true } = {}) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT email, stage, last_used, expires_at FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || !allowedEmails(env).includes(row.email)) {
    await dropSession(env, tokenHash);
    return null;
  }
  // Sliding expiry for full sessions, written at most once a day.
  if (touch && row.stage === 'full' && now - row.last_used > 86400_000) {
    await env.DB.prepare('UPDATE sessions SET last_used = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, now + SESSION_DAYS * 86400_000, tokenHash).run();
  }
  return { email: row.email, stage: row.stage, tokenHash };
}

async function requireSession(request, env, stage) {
  const s = await currentSession(request, env);
  if (!s) throw new HttpError(401, 'session');
  if (s.stage !== stage) throw new HttpError(403, 'stage', { stage: s.stage });
  return s;
}

const dropSession = (env, tokenHash) => env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}

/* ---------------- brute-force protection ---------------- */

async function checkLock(env, key) {
  const row = await env.DB.prepare('SELECT locked_until FROM attempts WHERE key = ?').bind(key).first();
  if (row && row.locked_until > Date.now()) {
    throw new HttpError(429, 'locked', { retryAfter: Math.ceil((row.locked_until - Date.now()) / 1000) });
  }
}

async function fail(env, key) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO attempts (key, fails, locked_until) VALUES (?, 1, 0)
     ON CONFLICT(key) DO UPDATE SET fails = CASE WHEN locked_until > 0 AND locked_until <= ? THEN 1 ELSE fails + 1 END,
                                    locked_until = CASE WHEN locked_until > 0 AND locked_until <= ? THEN 0 ELSE locked_until END`,
  ).bind(key, now, now).run();
  await env.DB.prepare('UPDATE attempts SET locked_until = ?, fails = 0 WHERE key = ? AND fails >= ?')
    .bind(now + LOCK_MINUTES * 60_000, key, MAX_FAILS).run();
}

const clear = (env, key) => env.DB.prepare('DELETE FROM attempts WHERE key = ?').bind(key).run();
const clientIp = request => request.headers.get('CF-Connecting-IP') || 'local';

/* ---------------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------------- */

async function verifyTotp(secretBase32, code, lastStep) {
  const digits = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(digits)) return null;
  const key = await crypto.subtle.importKey('raw', unbase32(secretBase32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000 / TOTP_STEP);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    if ((await hotp(key, step)) === digits) return step;
  }
  return null;
}

async function hotp(key, counter) {
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

function recoveryCode() {
  const s = base32(randomBytes(5)).toLowerCase(); // 8 characters
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
const normRecovery = c => c.toLowerCase().replace(/[^a-z2-7]/g, '');

/* ---------------- encryption at rest (AES-GCM) ---------------- */

let dataKey = null;
async function getDataKey(env) {
  if (!dataKey) {
    const raw = unb64(env.DATA_KEY.trim());
    if (raw.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64 encoded');
    dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  return dataKey;
}

async function encrypt(env, text) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getDataKey(env), new TextEncoder().encode(text));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function decrypt(env, stored) {
  const [v, iv, ct] = stored.split('.');
  if (v !== 'v1') throw new Error('unknown payload format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await getDataKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

/* ---------------- helpers ---------------- */

async function body(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'too_large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large');
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object') throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'json');
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const isKey = k => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const hexToBytes = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const b64url = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

// Compares two strings without leaking where they differ.
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]).then(xs => xs.map(x => new TextEncoder().encode(x)));
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(ha, hb) : ha.every((v, i) => v === hb[i]);
}

// Exported for tests.
export const _test = { hotp, base32, unbase32, verifyTotp };
