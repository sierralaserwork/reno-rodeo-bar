// service-worker.js — cache-first so the app runs fully offline after first load.
// Bump CACHE whenever you change app files or vendored libs.
const CACHE = 'barcount-v4';
const PRECACHE = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'lib/qrcode.js',
  'lib/jsqr.js',
  'lib/xlsx.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if any file 404s; add individually so a
      // missing optional file can't brick offline support.
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin GETs; fall back to network, then cache the result.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
