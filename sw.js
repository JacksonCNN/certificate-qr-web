// sw.js — the web version's service worker: what lets the app open and
// work with no connection in Safari on an iPhone (or any browser), and
// what updates it. Only in the web version; scripts/build-web.mjs fills
// in BUILD and FILES and writes this next to the pages.
//
// - Installing keeps a copy of every file of the app (FILES) in a cache
//   of its own, so from then on every page, script and the QR reader
//   come from the phone, not the network.
// - The QR dictionaries are the one thing asked of the network first:
//   new ones are published between releases (the tracker does it by
//   itself), and a label made with one can't be read without it. With
//   no connection the copy kept here is used.
// - A newer build is fetched in the background whenever the browser
//   looks for one (each time the app is opened, and when web-app.js
//   asks). It is kept waiting, not switched to under someone's work:
//   web-app.js asks whether to "Update now", the same as the Android
//   app does, and otherwise it takes over the next time the app is
//   opened fresh.

const BUILD = "1.2.8-96c3aacfed8e";
const FILES = [
  "./",
  "app.js",
  "backup.js",
  "converter.html",
  "converter.js",
  "database.html",
  "database.js",
  "device-storage.js",
  "dictionaries/1.txt",
  "dictionaries/10.txt",
  "dictionaries/2.txt",
  "dictionaries/3.txt",
  "dictionaries/4.txt",
  "dictionaries/5.txt",
  "dictionaries/6.txt",
  "dictionaries/7.txt",
  "dictionaries/8.txt",
  "dictionaries/9.txt",
  "dictionaries/index.json",
  "dictionary.js",
  "github-token.js",
  "history.js",
  "home.js",
  "icon-192.png",
  "index.html",
  "interpolate.html",
  "interpolate.js",
  "lablog.html",
  "lablog.js",
  "manifest.webmanifest",
  "photos.js",
  "qr-decode.js",
  "record-sheet.js",
  "scan-worker.js",
  "scanner.js",
  "scans.html",
  "settings.html",
  "settings.js",
  "sharelog.html",
  "sharelog.js",
  "sidebar.js",
  "style.css",
  "theme.js",
  "updater.js",
  "vendor/jsQR.js",
  "vendor/pako_inflate.min.js",
  "vendor/zxing-reader.js",
  "vendor/zxing-wasm-LICENSE.txt",
  "vendor/zxing_reader.wasm",
  "version.js",
  "web-app.js",
  "worksheet-forms.js"
];
const CACHE_PREFIX = 'certqr-web-';
const CACHE = `${CACHE_PREFIX}${BUILD}`;
const NETWORK_FIRST = /\/dictionaries\/[^/]+$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload' so that what's kept is the server's, not a stale copy
    // from the browser's own HTTP cache.
    await cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' })));
    // The very first install has no page running older files, so there
    // is nothing to wait for.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// "Update now" (web-app.js).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Which version is published is always asked of the server.
  if (url.pathname.endsWith('/web-version.json')) return;
  event.respondWith(NETWORK_FIRST.test(url.pathname) ? networkFirst(request) : cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(new Request(request.url), response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
