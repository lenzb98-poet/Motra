// Offline support: serve the app from cache, refresh the cache in the background.
const CACHE = 'motra-v19';
const ASSETS = [
  './',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js',
  'js/store.js',
  'js/charts.js',
  'js/util.js',
  'js/sync.js',
  'js/push.js',
  'js/vendor/qrcode.js',
  'fonts/bricolage-grotesque.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // Sync API answers must always come fresh from the server.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Pages are always served from './': Cloudflare redirects /index.html to /, and a cached
  // redirect can't be used to answer a navigation.
  const key = req.mode === 'navigate' ? './' : req;
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then(res => {
          if (res.ok && !res.redirected) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network;
    }),
  );
});

/* ---------------- reminders ---------------- */

self.addEventListener('push', event => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(msg.title || 'Motra', {
    body: msg.body || 'Zeit für einen kurzen Eintrag.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: msg.tag || 'motra',
    data: { url: msg.url || './#heute' },
  }));
});

// Tapping a reminder opens Motra at the right time of day (or focuses it if already open).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#heute', self.registration.scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(w => new URL(w.url).origin === target.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'motra-open', slot: target.searchParams.get('slot'), date: target.searchParams.get('date') });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser renewed the subscription: register the new one with the same settings.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const { publicKey } = await (await fetch('/api/push/key')).json();
      const b = publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const key = Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const old = event.oldSubscription;
      if (old) {
        await fetch('/api/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Motra': '1' },
          body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: sub.toJSON() }),
        });
      }
    } catch (e) { /* the app re-registers on next start */ }
  })());
});
