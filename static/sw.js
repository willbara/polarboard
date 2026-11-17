// Service worker: keeps the app itself available when the server is unreachable.
// Notes are cached separately in IndexedDB by the app. Browsers only allow
// service workers on HTTPS or localhost.

const VERSION = 'pb-0.8.0';
const SHELL = [
  '/', '/static/app.css', '/static/app.js', '/static/boot.js', '/static/markdown.js', '/static/editor.js',
  '/static/icons.js', '/static/settings.js', '/static/offline.js', '/static/rich.js', '/static/spell.js',
  '/static/props.js', '/static/export.js', '/static/diff.js', '/static/print.css',
  '/static/app/core.js', '/static/app/ui.js', '/static/app/prefs.js', '/static/app/sync.js', '/static/app/tree.js', '/static/app/notes.js', '/static/app/tabs.js', '/static/app/writing.js', '/static/app/layout.js', '/static/app/panels.js', '/static/app/spellui.js', '/static/app/suggest.js', '/static/app/daily.js', '/static/app/commands.js', '/static/app/accounts.js', '/static/app/find.js', '/static/app/mobile.js', '/static/app/hover.js', '/static/app/side.js', '/static/app/shell.js',
  '/static/manifest.webmanifest', '/static/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req, key = req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // the app handles data itself
  if (req.mode === 'navigate' && !url.pathname.startsWith('/s/')) {
    e.respondWith(networkFirst(req, '/'));
  } else if (url.pathname.startsWith('/static/vendor/')) {
    e.respondWith(cacheFirst(req)); // versioned libraries never change
  } else if (url.pathname.startsWith('/static/') || url.pathname.startsWith('/vault/')) {
    e.respondWith(networkFirst(req));
  }
});
