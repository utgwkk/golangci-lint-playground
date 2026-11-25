// Service worker: keeps the golangci-lint assets (about 24 MB per version) in
// the Cache API so that later visits do not download them again. Assets under
// v/<version>/ are immutable, so they are served cache-first. Everything else
// goes to the network as usual.

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

sw.addEventListener('install', (e) => e.waitUntil(sw.skipWaiting()));
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(sw.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + 'v/')) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Store in the background so that the page can stream the response (progress display).
      if (res.ok) e.waitUntil(cache.put(req, res.clone()));
      return res;
    })(),
  );
});
