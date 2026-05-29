// Bump CACHE on every deploy so the activate handler evicts the old shell. The previous
// "cache-first for HTML" strategy left users stuck on stale code after a deploy until they
// reloaded twice. We now serve HTML network-first so deploys take effect on the next load
// online; cache only kicks in as the offline fallback.
const CACHE = 'ow-v7';
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
    )).then(() => self.clients.claim()).then(() => {
      // Tell every controlled page that a new SW has taken over so it can prompt the user
      // (or auto-reload). Pages listen for the postMessage and can decide what to do.
      return self.clients.matchAll({ type: 'window' }).then(cs =>
        cs.forEach(c => c.postMessage({ type: 'SW_UPDATED', cache: CACHE }))
      );
    })
  );
});

// Cache-write helper that refuses to cache error or opaque responses (Google Fonts proxies,
// transient 5xx, etc.). Without this, a single bad response would get cached and re-served
// until the next deploy.
function safeCachePut(req, res) {
  if (!res || !res.ok || res.status !== 200 || res.type === 'opaque') return;
  caches.open(CACHE).then(c => c.put(req, res));
}

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

  // Network-first for the app shell (HTML). Deploys take effect on the next online load
  // instead of requiring two reloads (the old cache-first-with-revalidate served the OLD
  // HTML and only cached the new one for next time).
  const scope = self.registration.scope;
  if (url === scope || url === scope + 'index.html') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          safeCachePut(e.request, res.clone());
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Network-first for everything else (fonts, assets) — fall back to cache offline. Same
  // safeCachePut guard so we don't cache a transient 5xx forever.
  e.respondWith(
    fetch(e.request)
      .then(response => {
        safeCachePut(e.request, response.clone());
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
