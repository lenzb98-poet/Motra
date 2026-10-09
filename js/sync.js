// Optional sync with the Motra server (same origin, /api). Data always lives on the device first;
// sync uploads it and merges in changes from other devices.
import * as store from './store.js';

const KEY = 'motra.sync';
const INTERVAL = 2 * 60_000;
const DEBOUNCE = 1500;

let conf = { enabled: false, email: null, version: 0, lastSync: null };
try { conf = { ...conf, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* ignore */ }
const saveConf = () => { try { localStorage.setItem(KEY, JSON.stringify(conf)); } catch (e) { /* ignore */ } };

// status: off | idle | syncing | offline | error | loggedout
let status = conf.enabled ? 'idle' : 'off';
let lastError = null;
let running = null;
let again = false;
let timer = null;
const listeners = new Set();

export const onChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => fn());
const setStatus = (s, err = null) => { status = s; lastError = err; emit(); };

export const info = () => ({ ...conf, status, lastError });
export const isEnabled = () => conf.enabled;

/* ---------------- API ---------------- */

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

export async function api(method, path, data) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: data !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Motra': '1' } : {},
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, { error: 'offline' });
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, body);
  if (!body) throw new ApiError(res.status, { error: 'unavailable' });
  return body;
}

// Is a sync server reachable at this address? (The GitHub Pages copy has none.)
export async function serverStatus() {
  try {
    return await api('GET', 'status');
  } catch (e) {
    return { available: false, offline: e.status === 0 };
  }
}

// The password never leaves the device: a slow, salted hash of it is sent instead.
export async function loginKey(email, password) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`motra-login:${email.trim().toLowerCase()}`), iterations: 600_000 },
    base, 256,
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- enabling / disabling ---------------- */

export function enable(email) {
  conf = { enabled: true, email, version: 0, lastSync: null };
  saveConf();
  setStatus('idle');
  return syncNow();
}

// Stops syncing on this device. Data stays here; with `server` the session is ended too.
export async function disable({ server = true } = {}) {
  if (server) { try { await api('POST', 'logout'); } catch (e) { /* offline is fine */ } }
  conf = { enabled: false, email: null, version: 0, lastSync: null };
  saveConf();
  setStatus('off');
}

/* ---------------- syncing ---------------- */

export function syncNow() {
  if (!conf.enabled) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    do {
      again = false;
      await runOnce();
    } while (again && conf.enabled && status === 'idle');
  })().finally(() => { running = null; });
  return running;
}

async function runOnce() {
  setStatus('syncing');
  try {
    let remote = await api('GET', 'data');
    for (let attempt = 0; attempt < 4; attempt++) {
      if (remote.data) store.mergeRemote(remote.data);
      const local = store.syncPayload();
      if (remote.data && JSON.stringify(store.canonicalOf(remote.data)) === JSON.stringify(local)) {
        conf.version = remote.version;
        break;
      }
      try {
        const res = await api('PUT', 'data', { baseVersion: remote.version, data: local });
        conf.version = res.version;
        break;
      } catch (e) {
        if (e.status !== 409) throw e;
        remote = { version: e.body.version, data: e.body.data }; // someone else saved first: merge and retry
      }
    }
    conf.lastSync = new Date().toISOString();
    saveConf();
    setStatus('idle');
  } catch (e) {
    if (!conf.enabled) return;
    if (e.status === 401 || (e.status === 403 && e.body?.error === 'stage')) setStatus('loggedout');
    else if (e.status === 0) setStatus('offline');
    else setStatus('error', e.message);
  }
}

function schedule(delay = DEBOUNCE) {
  if (!conf.enabled || status === 'loggedout') return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export function start() {
  store.subscribe(({ remote } = {}) => { if (!remote) schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); });
  window.addEventListener('online', () => schedule(0));
  setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, INTERVAL);
  if (conf.enabled) schedule(0);
}
