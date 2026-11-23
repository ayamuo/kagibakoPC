// オフライン用 Service Worker（アプリ本体のみをキャッシュ。データファイルは一切扱わない）
const CACHE = 'kagibako-v0.9.3';
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon-32.png',
  'icons/icon-180.png',
  'icons/icon-maskable-512.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/logo.webp',
  'vendor/argon2.umd.min.js',
  'js/app.js', 'js/ui.js', 'js/model.js', 'js/legacy.js', 'js/vault.js', 'js/history.js', 'js/merge.js',
  'js/store.js', 'js/fileio.js', 'js/generator.js', 'js/host.js', 'js/autotype.js', 'js/csv.js', 'js/domain.js', 'js/brands.js', 'js/brandcheck.js', 'js/guide.js', 'js/help.js', 'js/ui-phone.js', 'js/ui-pc.js', 'js/practice.js', 'js/icons.js', 'js/psl-data.js', 'js/health.js', 'js/common-passwords.js', 'js/blowfish.js', 'js/bf-tables.js', 'js/sjis.js', 'js/xmlmini.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// ネットワーク優先（更新をすぐ反映）、オフライン時はキャッシュ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
