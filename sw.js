/* Bump VERSION on every deploy — any change to the string triggers the update banner.
   Patch for fixes, minor for features. v1.1 = first-run chooser. v1.2 = key instructions. v1.3 = backup and restore. v1.4 = cross-device sync. v1.5 = generated sync codes. v1.6 = choose what to refresh. v1.7 = shared-connection warning. v1.8 = movers view. v1.9 = fix joining device overwriting the server.
   v1.10 = manual price entry and per-holding price history.
   v1.11 = pending prices survive a reload. */
const VERSION = 'v1.11';
const CACHE = 'portfolios-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL);
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // Never cache the price API — always go to the network.
  if (url.hostname.indexOf('alphavantage.co') !== -1 || url.hostname.indexOf('anthropic.com') !== -1) {
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network first so a fresh deploy is picked up, cache as the offline fallback.
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
