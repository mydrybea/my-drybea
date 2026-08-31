// MY DRYBEA — minimal pass-through service worker.
// This just avoids the "Service Worker error" in the console.
// It does not cache anything, so the app always loads fresh from the network.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
