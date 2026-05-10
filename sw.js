/* Service worker.
 *
 * Two caches:
 *   shell-vN  — local files (HTML/CSS/JS/manifest), pre-cached at install.
 *   cdn-vN    — third-party ESM modules (zxing-wasm, bwip-js) and the
 *               WASM binary they fetch lazily. Stale-while-revalidate.
 *
 * Strategy:
 *   - Same-origin GET → cache-first, network fallback.
 *   - esm.sh / unpkg.com / cdn.jsdelivr.net GET → stale-while-revalidate.
 *   - Everything else → network passthrough (camera APIs are not
 *     fetches; this never touches them).
 */

const VERSION = "v1";
const SHELL_CACHE = `dm-scanner-shell-${VERSION}`;
const CDN_CACHE   = `dm-scanner-cdn-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./worker.js",
  "./manifest.json",
];

const CDN_HOSTS = new Set([
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, CDN_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  if (CDN_HOSTS.has(url.host)) {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }
  // Other origins (none expected): just passthrough.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: false });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Last-resort fallback: serve the shell index when offline and
    // a navigation request misses cache (e.g. deep-link).
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? Response.error();
}

// Manual cache-bust hook from the page.
self.addEventListener("message", (event) => {
  if (event.data?.type === "skipWaiting") self.skipWaiting();
});
