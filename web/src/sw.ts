// Service worker: keeps the golangci-lint assets (about 25 MB per version) in
// the Cache API so that later visits do not download them again.
//
// Files under v/<version>/ can be rebuilt and redeployed under the same path,
// so the page requests them with their content hash ("?v=<sha256 prefix>", see
// assetUrl in engine/client.ts):
//   - with "?v=": cache-first. The URL changes when the content changes, so a
//     cached response is never stale. Older copies of the same file are
//     deleted when a new one is stored.
//   - without "?v=" (pages from before hashed URLs): network-first, with the
//     cache only as an offline fallback.
//   - `cache: 'reload'` requests (the page's retry after a checksum mismatch)
//     always go to the network.
// Everything else (the page, versions.json, ...) is not handled here.

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
interface ServiceWorkerScope {
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  registration: { scope: string };
}

const sw = self as unknown as ServiceWorkerScope;
const CACHE = 'golangci-lint-assets-v1';

const isVersioned = (url: URL) => url.searchParams.has('v');

/** Deletes cached copies of the same file with another hash (or none). */
async function deleteOtherCopies(cache: Cache, url: URL): Promise<void> {
  for (const req of await cache.keys()) {
    const cached = new URL(req.url);
    if (cached.pathname === url.pathname && cached.search !== url.search) await cache.delete(req);
  }
}

async function store(cache: Cache, req: Request, res: Response): Promise<void> {
  await cache.put(req, res);
  await deleteOtherCopies(cache, new URL(req.url));
}

sw.addEventListener('install', (e) => e.waitUntil(sw.skipWaiting()));

sw.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      // Entries stored before hashed URLs cannot be trusted to be current.
      const cache = await caches.open(CACHE);
      for (const req of await cache.keys()) if (!isVersioned(new URL(req.url))) await cache.delete(req);
      await sw.clients.claim();
    })(),
  ),
);

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(sw.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + 'v/')) return;

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isVersioned(url) && req.cache !== 'reload') {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        // Store in the background so that the page can stream the response (progress display).
        if (res.ok && isVersioned(url)) e.waitUntil(store(cache, req, res.clone()));
        return res;
      } catch (err) {
        // Offline: an older copy is better than nothing; the page verifies checksums anyway.
        const fallback = await cache.match(req, { ignoreSearch: true });
        if (fallback) return fallback;
        throw err;
      }
    })(),
  );
});
