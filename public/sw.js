const C = 'outreach-v9';
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/manifest.json', '/outreach-logo.svg', '/icon-192.png', '/icon-512.png'])));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== C).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
