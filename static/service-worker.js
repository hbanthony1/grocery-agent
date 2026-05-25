const CACHE = 'grocery-agent-v1';
const SHELL = [
  '/',
  '/static/app.js',
  '/static/style.css',
  '/static/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only cache GET requests; pass API calls straight through
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/prefs') ||
      url.pathname.startsWith('/pantry') ||
      url.pathname.startsWith('/recipes') ||
      url.pathname.startsWith('/generate') ||
      url.pathname.startsWith('/build-cart') ||
      url.pathname.startsWith('/household') ||
      url.pathname.startsWith('/calendar')) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
