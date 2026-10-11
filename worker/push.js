// Reminder notifications via Web Push (RFC 8030 / 8291 / 8292), sent from a cron trigger.
// No account needed: a device registers its push subscription with reminder times and time zone,
// and tells the server which slots of today are already filled, so those reminders are skipped.
// The server never sees moods or notes.

const SLOTS = ['morning', 'noon', 'evening'];
const SLOT_TEXT = {
  morning: { title: 'Guten Morgen', body: 'Wie geht es dir heute Morgen? Trag kurz deine Stimmung ein.' },
  noon: { title: 'Kurze Pause', body: 'Wie geht es dir gerade? Ein Tipp genügt.' },
  evening: { title: 'Guten Abend', body: 'Wie war dein Tag? Trag deine Abendstimmung ein.' },
};
const SEND_WINDOW_MIN = 15; // a reminder may still go out this many minutes late (cron delays)
const MAX_SUBSCRIPTIONS = 500;
const STALE_DAYS = 60;       // the app re-registers on every start; rows untouched this long are dropped
const SENDS_PER_RUN = 40;    // free plan: 50 subrequests per cron run; the rest waits for the next minute

// Only real browser push services, so the server can't be used to send requests anywhere else.
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export const PUSH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint TEXT PRIMARY KEY,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     tz TEXT NOT NULL,
     times TEXT NOT NULL,
     done_date TEXT NOT NULL DEFAULT '',
     done_slots TEXT NOT NULL DEFAULT '[]',
     sent TEXT NOT NULL DEFAULT '{}',
     origin TEXT NOT NULL,
     user_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id)`,
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export class PushError extends Error {
  constructor(status, error) { super(error); this.status = status; }
}

/* ---------------- API handlers ---------------- */

export async function pushKey(env) {
  const keys = await vapidKeys(env);
  return { publicKey: keys.publicKey };
}

// `isNew` tells the caller to apply its rate limit; `userId` links the device to a sync account (or null).
export async function subscriptionExists(env, data, testHosts) {
  const endpoint = checkEndpoint(data?.subscription?.endpoint, testHosts);
  return !!(await env.DB.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').bind(endpoint).first());
}

export async function pushSubscribe(env, data, origin, testHosts, userId = null) {
  const sub = data?.subscription;
  const endpoint = checkEndpoint(sub?.endpoint, testHosts);
  const { p256dh, auth } = await checkKeys(sub?.keys);
  const tz = checkTz(data.tz);
  const times = checkTimes(data.times);
  if (!Object.keys(times).length) throw new PushError(400, 'times');
  const now = Date.now();
  const exists = await env.DB.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').bind(endpoint).first();
  if (!exists) {
    await env.DB.prepare('DELETE FROM push_subs WHERE updated_at < ?').bind(now - STALE_DAYS * 86400_000).run();
    const { n } = await env.DB.prepare('SELECT count(*) AS n FROM push_subs').first();
    if (n >= MAX_SUBSCRIPTIONS) {
      // Full: make room by dropping the least recently seen devices, rather than refusing everyone new.
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint IN (SELECT endpoint FROM push_subs ORDER BY updated_at LIMIT ?)')
        .bind(n - MAX_SUBSCRIPTIONS + 1).run();
    }
  }
  await env.DB.prepare(
    `INSERT INTO push_subs (endpoint, p256dh, auth, tz, times, origin, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz,
       times = excluded.times, origin = excluded.origin, user_id = excluded.user_id, updated_at = excluded.updated_at`,
  ).bind(endpoint, p256dh, auth, tz, JSON.stringify(times), origin, userId, now, now).run();
  return { ok: true };
}

// Keys must be a real P-256 point and a 16-byte secret; anything else is refused up front.
async function checkKeys(keys) {
  const p256dh = keys?.p256dh, auth = keys?.auth;
  if (!isB64url(p256dh) || unb64url(p256dh).length !== 65 || !isB64url(auth) || unb64url(auth).length !== 16) {
    throw new PushError(400, 'keys');
  }
  try {
    await crypto.subtle.importKey('raw', unb64url(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new PushError(400, 'keys');
  }
  return { p256dh, auth };
}

// The browser replaced a subscription: move its times and state over to the new one.
export async function pushResubscribe(env, data, testHosts) {
  const oldEndpoint = checkEndpoint(data?.oldEndpoint, testHosts);
  const sub = data?.subscription;
  const endpoint = checkEndpoint(sub?.endpoint, testHosts);
  const { p256dh, auth } = await checkKeys(sub?.keys);
  await env.DB.prepare('UPDATE OR REPLACE push_subs SET endpoint = ?, p256dh = ?, auth = ?, updated_at = ? WHERE endpoint = ?')
    .bind(endpoint, p256dh, auth, Date.now(), oldEndpoint).run();
  return { ok: true };
}

export async function pushUnsubscribe(env, data, testHosts) {
  const endpoint = checkEndpoint(data?.endpoint, testHosts);
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
  return { ok: true };
}

// Which of today's slots already have an entry (only slot names, no moods).
export async function pushDone(env, data, testHosts) {
  const endpoint = checkEndpoint(data?.endpoint, testHosts);
  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new PushError(400, 'date');
  const slots = Array.isArray(data.slots) ? [...new Set(data.slots.filter(s => SLOTS.includes(s)))] : [];
  const row = await env.DB.prepare('SELECT user_id FROM push_subs WHERE endpoint = ?').bind(endpoint).first();
  if (!row) return { ok: true };
  // With sync, a slot filled on one device also silences the reminder on the account's other devices.
  const targets = row.user_id
    ? (await env.DB.prepare('SELECT endpoint, done_date, done_slots FROM push_subs WHERE user_id = ?').bind(row.user_id).all()).results
    : [{ endpoint, done_date: '', done_slots: '[]' }];
  await env.DB.batch(targets.map(t => {
    const merged = t.endpoint === endpoint ? slots
      : [...new Set([...(t.done_date === data.date ? safeJson(t.done_slots, []) : []), ...slots])];
    return env.DB.prepare('UPDATE push_subs SET done_date = ?, done_slots = ? WHERE endpoint = ?').bind(data.date, JSON.stringify(merged), t.endpoint);
  }));
  return { ok: true };
}

export async function pushTest(env, data, testHosts) {
  const endpoint = checkEndpoint(data?.endpoint, testHosts);
  const row = await env.DB.prepare('SELECT * FROM push_subs WHERE endpoint = ?').bind(endpoint).first();
  if (!row) throw new PushError(404, 'unknown');
  const res = await sendPush(env, row, {
    title: 'Motra', body: 'So sehen deine Erinnerungen aus. Alles eingerichtet.', tag: 'motra-test', url: './#heute',
  });
  if (!res.ok) throw new PushError(502, `push_${res.status}`);
  return { ok: true };
}

/* ---------------- cron: send due reminders ---------------- */

export async function runReminders(env, now = new Date()) {
  const { results } = await env.DB.prepare('SELECT * FROM push_subs ORDER BY random()').all();
  let sent = 0, attempts = 0;
  for (const row of results) {
    if (attempts >= SENDS_PER_RUN) break; // the rest stays unmarked and goes out next minute
    const local = localTime(now, row.tz);
    if (!local) continue;
    const times = safeJson(row.times, {});
    const done = row.done_date === local.date ? safeJson(row.done_slots, []) : [];
    const already = safeJson(row.sent, {});
    for (const slot of SLOTS) {
      const t = times[slot];
      if (!t) continue;
      const due = toMinutes(t);
      const late = local.minutes - due;
      if (late < 0 || late >= SEND_WINDOW_MIN) continue;
      if (already[slot] === local.date || done.includes(slot)) continue;
      if (attempts >= SENDS_PER_RUN) break;
      // Mark first, so overlapping cron runs can't send twice.
      const prevSent = row.sent;
      const prevVal = already[slot];
      already[slot] = local.date;
      const marked = JSON.stringify(already);
      const mark = await env.DB.prepare('UPDATE push_subs SET sent = ? WHERE endpoint = ? AND sent = ?')
        .bind(marked, row.endpoint, prevSent).run();
      if (mark.meta.changes !== 1) break;
      row.sent = marked;
      attempts++;
      let res;
      try {
        res = await sendPush(env, row, {
          ...SLOT_TEXT[slot], tag: `motra-${slot}`, url: `./?slot=${slot}&date=${local.date}#heute`,
        });
      } catch (e) {
        // A row that can't be encrypted for (e.g. broken key) must not stop everyone else's reminders.
        console.error('push failed', e);
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(row.endpoint).run();
        break;
      }
      if (res.gone) break; // subscription expired and was removed
      if (res.ok) { sent++; continue; }
      if (res.status === 0 || res.status === 429 || res.status >= 500) {
        // Temporary problem at the push service: undo the mark so a later run in the window retries.
        if (prevVal === undefined) delete already[slot]; else already[slot] = prevVal;
        const undo = await env.DB.prepare('UPDATE push_subs SET sent = ? WHERE endpoint = ? AND sent = ?')
          .bind(prevSent, row.endpoint, marked).run();
        if (undo.meta.changes !== 1) break;
        row.sent = prevSent;
      }
    }
  }
  return sent;
}

/* ---------------- Web Push sending ---------------- */

export async function sendPush(env, row, message) {
  const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(message)), unb64url(row.p256dh), unb64url(row.auth));
  const url = new URL(row.endpoint);
  const keys = await vapidKeys(env);
  const jwt = await vapidJwt(keys, url.origin, row.origin);
  let res;
  try {
    res = await fetch(row.endpoint, {
      method: 'POST',
      headers: {
        TTL: '3600',
        Urgency: 'normal',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0 };
  }
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(row.endpoint).run();
    return { ok: false, gone: true, status: res.status };
  }
  return { ok: res.ok, status: res.status };
}

// RFC 8291 message encryption, "aes128gcm" content coding, single record.
export async function encryptPayload(plaintext, uaPublic, authSecret) {
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last record, no padding
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

// RFC 8292 VAPID: a short ES256-signed JWT per push service origin.
async function vapidJwt(keys, audience, origin) {
  const header = b64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(utf8(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: origin })));
  const data = utf8(`${header}.${claims}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data));
  return `${header}.${claims}.${b64url(sig)}`;
}

// The server's VAPID key pair: generated on first use and kept in D1.
let cachedKeys = null;
async function vapidKeys(env) {
  if (cachedKeys) return cachedKeys;
  let row = await env.DB.prepare("SELECT value FROM config WHERE key = 'vapid'").first();
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    await env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(jwk)).run();
    row = await env.DB.prepare("SELECT value FROM config WHERE key = 'vapid'").first(); // whoever won the race
  }
  const jwk = JSON.parse(row.value);
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicRaw = concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y));
  cachedKeys = { privateKey, publicKey: b64url(publicRaw) };
  return cachedKeys;
}

/* ---------------- validation & helpers ---------------- */

function checkEndpoint(value, testHosts = []) {
  let url;
  try { url = new URL(value); } catch { throw new PushError(400, 'endpoint'); }
  const okHost = PUSH_HOSTS.some(re => re.test(url.hostname)) || testHosts.includes(url.host);
  if (!okHost || (url.protocol !== 'https:' && !testHosts.includes(url.host)) || value.length > 1024) {
    throw new PushError(400, 'endpoint');
  }
  return url.href;
}

function checkTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64) throw new PushError(400, 'tz');
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new PushError(400, 'tz'); }
  return tz;
}

function checkTimes(times) {
  const out = {};
  if (times && typeof times === 'object') {
    for (const slot of SLOTS) {
      const t = times[slot];
      if (t == null || t === false || t === '') continue;
      if (typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new PushError(400, 'times');
      out[slot] = t;
    }
  }
  return out;
}

// Local date and minute of the day in a time zone.
export function localTime(date, tz) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    return null;
  }
}

const toMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const safeJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const utf8 = s => new TextEncoder().encode(s);
const isB64url = s => typeof s === 'string' && s.length < 200 && /^[A-Za-z0-9_-]+=*$/.test(s);
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64url(text) {
  const b = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0));
}
