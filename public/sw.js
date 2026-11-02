const C = 'outreach-v5';
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/manifest.json', '/outreach-logo.svg', '/icon-192.png', '/icon-512.png']))));
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
