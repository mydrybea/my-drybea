// MY DRYBEA — real caching service worker.
//
// Strategy (deliberately different per resource type, not one blanket rule):
//   1. App shell (index.html / login.html / manifest.json) -> network-first,
//      falling back to cache.
//      Reason: you are actively updating these. Network-first means people
//      always get your latest version when they have signal, but the app
//      still opens if they're offline or on a bad connection.
//   2. Everything else same-origin (style.css, app.js, login.css, login.js,
//      logo/icons, fonts) plus third-party libs (Chart.js, Supabase JS,
//      Lucide)                              -> cache-first, falling back to
//      network (and quietly refreshing the cache in the background).
//      Reason: near-instant repeat loads and real offline support — this is
//      the actual PWA payoff. Trade-off: right after you deploy, a returning
//      user can run the *previous* build's CSS/JS for one load (the
//      background refresh updates the cache for next time) even though
//      index.html itself updates immediately. Bump CACHE_VERSION below for
//      any change you need everyone on immediately.
//   3. Supabase API reads (GET)              -> network-first, falling back
//      to a cache of that exact request (query string included — different
//      filters are different data, so we never collapse them together).
//      Reason: real offline support for live business data (orders,
//      expenses, stock) — the app can show the last-known data when
//      offline instead of failing outright. It's a stale snapshot in that
//      case, not a live read; the app's own sync indicator already
//      communicates "local data active" for this situation.
//      Supabase writes (POST/PATCH/DELETE) never hit this worker at all —
//      see the GET-only check below — so they always go straight to the
//      network, never cached, never replayed from cache.
//
// ---- IMPORTANT: bump this version string every time you deploy a change ----
// Since none of these filenames are hashed, this version bump is what tells
// returning users' phones "throw away every old cached copy and fetch
// fresh." Forgetting to bump it means users can get stuck on an old cached
// version even though you've updated the live site.
const CACHE_VERSION = 'v4';
const CACHE_NAME = `mydrybea-${CACHE_VERSION}`;

// Files that make up the installable "app shell" — network-first.
const APP_SHELL = [
  './index.html',
  './login.html',
  './manifest.json',
];

// Same-origin static assets — cache-first. Pre-cached at install so the
// very first offline visit already has them.
const STATIC_ASSETS = [
  './logo.jpg',
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

// Any request whose URL includes this is live Supabase business data.
const SUPABASE_HOSTNAME = 'dztuyfiiyxllnvciunjv.supabase.co';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll fails the whole install if even one request fails, so we cache
      // the app shell (must succeed) separately from the static assets and
      // third-party libs (best-effort) — a slow/blocked CDN shouldn't stop
      // the app from installing.
      return cache.addAll(APP_SHELL).then(() =>
        Promise.allSettled(
          [...STATIC_ASSETS, ...STATIC_LIBS].map((url) =>
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

  // Only GET requests are ever cacheable. POST/PUT/PATCH/DELETE (logins,
  // saves, uploads, Supabase writes) must always go straight to the network
  // untouched — they never reach the logic below.
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Rule 3: live Supabase reads — network-first, falling back to a cache of
  // this *exact* request (query string and all) when offline.
  if (url.hostname === SUPABASE_HOSTNAME) {
    event.respondWith(networkFirst(request, { matchExact: true }));
    return;
  }

  // Rule 1: app shell — network-first, falling back to cache when offline.
  const isAppShellRequest =
    request.mode === 'navigate' ||
    APP_SHELL.some((path) => url.pathname.endsWith(path.replace('./', '/')));

  if (isAppShellRequest) {
    event.respondWith(networkFirst(request, { shellFallback: true }));
    return;
  }

  // Rule 2: everything else same-origin, plus the known static libs —
  // cache-first, falling back to network (and updating the cache quietly).
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, { shellFallback = false, matchExact = false } = {}) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    // Supabase reads must match the exact URL (query string included) —
    // ignoring it could serve cached data for a different filter/query.
    const cached = await cache.match(request, { ignoreSearch: !matchExact });
    if (cached) return cached;
    if (shellFallback) {
      // Last resort so a fully-offline first visit doesn't hard-fail.
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
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
