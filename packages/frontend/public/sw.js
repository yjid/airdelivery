/**
 * Service worker.
 *
 * The previous version was an empty stub: a `fetch` listener that did nothing,
 * a no-op install handler, and a `KEEP_ALIVE` message handler that existed only
 * to look busy. It registered successfully and provided zero value.
 *
 * This one does something worth having, while being careful not to get in the
 * way: it precaches the shell for offline use and serves navigations from the
 * network first so a user never sees a stale page after a deploy. It
 * deliberately does NOT cache the signaling API or any cross-origin request.
 */

const VERSION = 'v2';
const SHELL_CACHE = `airdelivery-shell-${VERSION}`;
const OFFLINE_URL = '/offline';

const SHELL_ASSETS = ['/', OFFLINE_URL, '/manifest.json', '/icons/logo.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // A single missing asset must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the signaling API or anything cross-origin. Caching a
  // signaling response would be actively harmful.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, so a deploy is picked up immediately, falling
  // back to the cached shell and then to the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(
          async () =>
            (await caches.match(request)) ??
            (await caches.match(OFFLINE_URL)) ??
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }),
        ),
    );
    return;
  }

  // Static assets: cache first, since their URLs are content-hashed or
  // versioned.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
