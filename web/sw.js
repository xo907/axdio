/* Axdio's service worker: the player opens at once and without a connection.

   Pages come from the network as before, with what's kept here as the fallback when there's no connection or it takes
   too long. The scripts and stylesheets they name are kept at their version (a new version has a new address), fonts
   and icons too. The library and songs saved for offline are already kept by the player itself (core.js), so with the
   page they're all there offline. Everything else (the API, streams, covers) goes to the network as before. */
const SHELL = 'axdio-shell-v1';
const PAGES = new Set(['/', '/offline', '/history', '/artists', '/albums', '/liked', '/playlist', '/profile', '/settings',
  '/messages', '/friends', '/user', '/mobile', '/mobile.html']);
const WAIT_MS = 1500;   // a slow network: show the kept page after this long

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('axdio-shell-') && k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' && (PAGES.has(url.pathname) || url.pathname.startsWith('/x/'))) e.respondWith(page(req, url));
  else if (url.pathname.startsWith('/web/') && url.searchParams.has('v')) e.respondWith(versioned(req, url));
  else if (url.pathname.startsWith('/web/fonts/') || url.pathname === '/manifest.json' || url.pathname === '/favicon.ico') e.respondWith(kept(req));
});

// Every page of the player is the same app: one copy is kept (per kind: the phone page or the desktop one).
const pageKey = url => new Request(new URL(url.pathname === '/mobile' || url.pathname === '/mobile.html' ? '/__axdio_mobile' : '/__axdio_app', self.location.origin));

async function page(req, url) {
  const cache = await caches.open(SHELL);
  const key = pageKey(url);
  const fresh = fetch(req).then(async res => {
    if (res.ok && (res.headers.get('Content-Type') || '').includes('text/html')) await cache.put(key, res.clone());
    return res;
  });
  const keptCopy = await cache.match(key);
  if (!keptCopy) return fresh;                                   // the first visit: only the network has it
  // The network's answer when it comes in time (a page the server sends, maintenance included), else the kept copy.
  const late = new Promise(res => setTimeout(() => res(null), WAIT_MS));
  const res = await Promise.race([fresh.catch(() => null), late]);   // null: no connection, or too slow
  return res || keptCopy;
}

// A script or stylesheet at its version never changes: from here once kept; older versions of it are let go.
async function versioned(req, url) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    for (const k of await cache.keys()) {
      const u = new URL(k.url);
      if (u.pathname === url.pathname && u.search !== url.search) await cache.delete(k);
    }
  }
  return res;
}

// Fonts and icons: from the network, with the kept copy when there's none.
async function kept(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}
