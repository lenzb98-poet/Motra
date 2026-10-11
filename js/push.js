// Reminder notifications on this device (Web Push). Works without an account:
// the device registers its push subscription and reminder times with the Motra server.
import * as store from './store.js';
import { todayKey } from './util.js';

const KEY = 'motra.push';
export const DEFAULT_TIMES = { morning: '09:00', noon: '13:00', evening: '20:00' };

let conf = { enabled: false, times: { ...DEFAULT_TIMES }, off: [], endpoint: null, pending: false };
try { conf = { ...conf, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* ignore */ }
const saveConf = () => { try { localStorage.setItem(KEY, JSON.stringify(conf)); } catch (e) { /* ignore */ } };

export const settings = () => ({ ...conf, times: { ...conf.times }, off: [...conf.off] });
export const isEnabled = () => conf.enabled;

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// What this device can do: 'ok', 'install' (iOS: needs home screen), 'unsupported', 'denied'.
export function support() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (isIos() && !isStandalone()) return 'install';
  if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

async function call(method, path, data, { keepalive = false } = {}) {
  const res = await fetch(`/api/push/${path}`, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Motra': '1' },
    body: data ? JSON.stringify(data) : undefined,
    cache: 'no-store',
    keepalive, // lets the request finish even if the app is closed right after
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !body) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Is there a reminder server at this address? (The GitHub Pages copy has none.)
// Also fetches the server key ahead of time, so enabling needs no request before the permission prompt.
let serverKey = null;
export async function serverAvailable() {
  try { serverKey = (await call('GET', 'key')).publicKey; return true; } catch (e) { return false; }
}

const activeTimes = () => Object.fromEntries(Object.entries(conf.times).filter(([slot]) => !conf.off.includes(slot)));
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';

function keyBytes(b64url) {
  const b = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0));
}

async function subscription(create) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create) {
    serverKey ??= (await call('GET', 'key')).publicKey;
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(serverKey) });
  }
  return sub;
}

async function register(sub) {
  if (!Object.keys(activeTimes()).length) {
    // All times of day switched off: nothing to remind about, so remove this device on the server.
    await call('POST', 'unsubscribe', { endpoint: sub.endpoint });
    conf.endpoint = sub.endpoint;
    saveConf();
    return;
  }
  await call('POST', 'subscribe', { subscription: sub.toJSON(), times: activeTimes(), tz: timeZone() });
  if (conf.endpoint && conf.endpoint !== sub.endpoint) {
    call('POST', 'unsubscribe', { endpoint: conf.endpoint }).catch(() => {}); // an older subscription of this device
  }
  conf.endpoint = sub.endpoint;
  saveConf();
  await reportToday(sub);
}

// Must be called right in a tap handler, before any other await:
// iOS only shows the permission prompt (and allows subscribing) directly after a user action.
export async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    const err = new Error(permission === 'denied' ? 'denied' : 'dismissed');
    err.code = permission;
    throw err;
  }
  const sub = await subscription(true);
  conf.enabled = true;
  saveConf();
  await register(sub);
}

export async function disable() {
  const known = conf.endpoint;
  conf.enabled = false;
  conf.endpoint = null;
  saveConf();
  let sub = null;
  try { sub = await subscription(false); } catch (e) { /* no service worker */ }
  // Remove it on the server even if the browser already dropped the subscription.
  for (const endpoint of new Set([known, sub?.endpoint].filter(Boolean))) {
    await call('POST', 'unsubscribe', { endpoint }).catch(() => {});
  }
  try { await sub?.unsubscribe(); } catch (e) { /* already gone */ }
}

export async function setTimes(times, off) {
  conf.times = { ...conf.times, ...times };
  conf.off = off;
  saveConf();
  if (!conf.enabled) return;
  const sub = await subscription(true);
  await register(sub);
}

export async function sendTest() {
  const sub = await subscription(false);
  if (!sub) throw new Error('no_subscription');
  await call('POST', 'test', { endpoint: sub.endpoint });
}

// Tells the server which of today's slots are filled, so it skips those reminders.
// A report that couldn't be sent yet (offline, app closed) stays pending and is retried.
let reportTimer = null;
async function reportToday(sub) {
  const endpoint = sub?.endpoint ?? conf.endpoint ?? (await subscription(false))?.endpoint;
  if (!endpoint) return;
  const day = store.dayEntries(todayKey());
  await call('POST', 'done', { endpoint, date: todayKey(), slots: Object.keys(day) }, { keepalive: true });
  conf.pending = false;
  saveConf();
}
const flushReport = () => {
  if (!conf.enabled || !conf.pending) return;
  clearTimeout(reportTimer);
  reportToday().catch(() => { /* stays pending */ });
};
const scheduleReport = () => {
  if (!conf.enabled) return;
  conf.pending = true;
  saveConf();
  clearTimeout(reportTimer);
  reportTimer = setTimeout(flushReport, 800);
};

// On start: keep the registration fresh (subscriptions can be renewed by the browser).
export function start() {
  store.subscribe(scheduleReport);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleReport(); // the day may have changed meanwhile
    else flushReport(); // leaving the app: send now, don't wait for the timer
  });
  window.addEventListener('pagehide', flushReport);
  window.addEventListener('online', flushReport);
  if (!conf.enabled || support() !== 'ok' || Notification.permission !== 'granted') return;
  subscription(true).then(register).catch(() => { /* offline or no server; try next time */ });
}
