/* LearnGuage service worker - precache everything for full offline use. */
const CACHE = 'learnguage-v7';

const ASSETS = [
  './',
  'index.html',
  'session.html',
  'manifest.json',
  'css/style.css',
  'js/engine.js',
  'js/sound.js',
  'js/app.js',
  'js/home.js',
  'js/register-sw.js',
  'data/seed_progress.json',
  'data/words/italian_set_1.json',
  'data/words/italian_set_2.json',
  'data/words/italian_set_3.json',
  'data/words/italian_set_4.json',
  'data/words/italian_set_5.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first: serve from cache, fall back to network (and cache new GETs).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => {
        // offline navigation fallback
        if (req.mode === 'navigate') return caches.match('index.html');
      });
    })
  );
});
