// T1-01 service worker: counts the bytes of every GET the page and its workers make,
// and keeps a copy so a second load with the network off can run from this cache.
// Network first (so online runs measure real data use), cache as fallback (offline runs).
const CACHE = 't1-01-v1';
const channel = new BroadcastChannel('t1-01-net');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  // T1-02: Google content is never cached (its terms limit caching); the browser fetches it directly.
  if (/(^|\.)(googleapis|gstatic|google)\.com$/.test(new URL(req.url).hostname)) return;
  // T1-02 audit fix 3: an address carrying the Google key is never cached (cache.put would store the key with the URL).
  if (new URL(req.url).searchParams.has('gkey')) return;
  event.respondWith(handle(req));
});

async function handle(req) {
  const host = new URL(req.url).host;
  try {
    const res = await fetch(req);
    const body = await res.clone().arrayBuffer();
    channel.postMessage({ kind: 'net', host, bytes: body.byteLength, status: res.status });
    if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreVary: true, ignoreSearch: req.mode === 'navigate' });
    if (hit) {
      const body = await hit.clone().arrayBuffer();
      channel.postMessage({ kind: 'cache', host, bytes: body.byteLength, status: hit.status });
      return hit;
    }
    channel.postMessage({ kind: 'failed', host, bytes: 0, status: 0 });
    throw err;
  }
}
