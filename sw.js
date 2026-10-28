// TriSeason Tracker — Service Worker
const CACHE = 'triseason-v20';
// Adresses relatives au service worker : le site est servi dans un sous-dossier
// (nathansimon-gif.github.io/TriSeason/), un « / » au début viserait la racine.
const ASSETS = [
  './', './index.html', './sport.html', './sessions.html',
  './competitions.html', './nutrition.html', './records.html',
  './profile.html', './forme.html', './login.html', './aide.html',
  './app.js', './theme.js', './style.css', './fit-parser.js', './import.js', './auth-guard.js',
  './vendor/chart.umd.min.js', './manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // 'no-cache' : on revalide auprès du serveur au lieu de reprendre une copie du
  // cache HTTP, pour ne jamais mélanger une page récente avec un ancien app.js.
  const sameOrigin = new URL(e.request.url).origin === location.origin;
  e.respondWith(
    fetch(e.request, sameOrigin ? { cache: 'no-cache' } : undefined).then(res => {
      // Les recherches d'aliments (Open Food Facts) ne sont pas gardées en cache
      if (res.ok && e.request.method === 'GET' && !e.request.url.includes('openfoodfacts.org')) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
