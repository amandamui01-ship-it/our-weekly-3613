const CACHE = 'ow-v5';
// Use relative paths so the service worker survives moving the app to a different host or
// repo path. The scope is wherever this sw.js is served from, which is what we want.
const SHELL = [
  './',
  './index.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Let Firebase, Firestore, Storage, and auth requests bypass the cache
  if (
    url.includes('firestore.googleapis') ||
    url.includes('firebase') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('firebasestorage')
  ) return;

  // Cache-first for the app shell (HTML) so it loads instantly offline. Match by comparing
  // resolved URLs against the registration scope so this works at any hosted path.
  const scope = self.registration.scope;
  if (url === scope || url === scope + 'index.html') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        });
        return cached || network;
      })
    );
    return;
  }

  // Network-first for everything else (fonts, assets) — fall back to cache offline
  e.respondWith(
    fetch(e.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
