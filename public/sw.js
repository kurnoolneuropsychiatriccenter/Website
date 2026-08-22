// Minimal service worker so browsers offer "Install as app".
// We intentionally do NOT cache API responses — the clinic app must always show fresh data.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  // pure passthrough — never cache
  return;
});
