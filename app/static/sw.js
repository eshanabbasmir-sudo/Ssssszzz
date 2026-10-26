/* Minimal service worker: makes the panel installable without ever caching
   API responses or terminal sockets. Network-first, shell-only fallback. */
const CACHE = 'prime-terminal-shell-v1';
const SHELL = ['/', '/static/css/app.css', '/static/vendor/xterm.css', '/static/js/app.js', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    return; // always go to the network for dynamic data
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && (url.pathname.startsWith('/static/') || url.pathname === '/' || url.pathname.endsWith('.svg'))) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
