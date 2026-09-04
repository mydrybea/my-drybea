// MY DRYBEA — real caching service worker.
//
// Strategy (deliberately different per resource type, not one blanket rule):
//   1. App shell (index.html / login.html)  -> network-first, falling back to cache.
//      Reason: you are actively updating this app. Network-first means people
//      always get your latest version when they have signal, but the app still
//      opens if they're offline or on a bad connection.
//   2. Static assets (logo, fonts, Chart.js, Supabase JS, Lucide icons)
//                                            -> cache-first, falling back to network.
//      Reason: these barely ever change, so serving them instantly from cache
//      is a big speed win and saves the user's mobile data.
//   3. Supabase API calls (auth/data)        -> never cached, always network.
//      Reason: this is live business data (orders, expenses, stock). Serving a
//      cached/stale copy would be actively wrong, not just slow.
//
// ---- IMPORTANT: bump this version string every time you deploy a change ----
// Since index.html/login.html don't have hashed filenames, this version bump
// is what tells returning users' phones "throw away the old cached copy and
// fetch the new one." Forgetting to bump it means users can get stuck on an
// old cached version even though you've updated the live site.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `mydrybea-${CACHE_VERSION}`;

// Files that make up the installable "app shell."
// style.css/app.js/login.css/login.js are here (not in the cache-first
// bucket below) because they're app code you edit right alongside
// index.html/login.html, not slow-changing third-party libs — they need
// the same "always try network first" treatment or a deploy could leave
// a user on a fresh index.html paired with a stale, mismatched app.js.
const APP_SHELL = [
  './index.html',
  './login.html',
  './logo.jpg',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './style.css',
  './app.js',
  './login.css',
  './login.js',
];

// Third-party static libraries the app depends on. Cached the same way as
// local static assets — they change rarely and are safe to serve from cache.
const STATIC_LIBS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://unpkg.com/lucide@latest',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Noto+Sans+Sinhala:wght@300;400;500;600;700&family=Playfair+Display:wght@400;500;600;700;800;900&display=swap',
];

// Any request whose URL includes this is live business data — never cache it.
const NEVER_CACHE_HOSTNAME = 'dztuyfiiyxllnvciunjv.supabase.co';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll fails the whole install if even one request fails, so we cache
      // the app shell (must succeed) and the third-party libs (best-effort)
      // separately — a slow/blocked CDN shouldn't stop the app from installing.
      return cache.addAll(APP_SHELL).then(() =>
        Promise.allSettled(
          STATIC_LIBS.map((url) =>
            cache.add(new Request(url, { mode: 'cors' })).catch(() => {})
          )
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith('mydrybea-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Lets the page trigger an immediate update (e.g. from an "Update available"
// button) instead of waiting for all tabs to close. Safe to leave unused.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET requests are ever cacheable. POST/PUT/etc. (logins, saves,
  // uploads) must always go straight to the network untouched.
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Rule 3: live Supabase data — always network, never touch the cache.
  if (url.hostname === NEVER_CACHE_HOSTNAME) {
    event.respondWith(fetch(request));
    return;
  }

  // Rule 1: app shell — network-first, falling back to cache when offline.
  const isAppShellRequest =
    request.mode === 'navigate' ||
    APP_SHELL.some((path) => url.pathname.endsWith(path.replace('./', '/')));

  if (isAppShellRequest) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Rule 2: everything else same-origin, plus the known static libs —
  // cache-first, falling back to network (and updating the cache quietly).
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Last resort so a fully-offline first visit doesn't hard-fail.
    const shellFallback = await cache.match('./index.html');
    if (shellFallback) return shellFallback;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    // Refresh the cache in the background so it doesn't go stale forever,
    // without making the current user wait for that refresh.
    fetch(request)
      .then((fresh) => {
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    throw err;
  }
}
