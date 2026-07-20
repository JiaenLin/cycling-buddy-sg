/* Cycling Buddy SG PWA service worker — offline app shell + runtime basemap tile cache
   © 2026 Lin Jiaen · All rights reserved */
const VERSION = 'cbsg-v25';
const SHELL = VERSION + '-shell';
const TILES = VERSION + '-tiles';
const TILE_MAX = 800; // cap runtime tile cache entries

const SHELL_ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'router.js', 'manifest.webmanifest',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/goatcounter-count.js',
  'data/pcn.lines.geojson', 'data/pcn.meta.json',
  'data/cpn.lines.geojson', 'data/cpn.meta.json',
  'data/rail.lines.geojson', 'data/rail.meta.json',
  'data/parks.polys.geojson', 'data/parks.meta.json',
  'data/racks.points.geojson', 'data/racks.meta.json',
  'data/closures.geojson', 'data/closures.meta.json',
  'data/wx.zones.geojson',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-192-maskable.png', 'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // Precache and then WAIT (no auto-skipWaiting): the page shows an "update" pill and the user
  // chooses when to switch, so a new version never reloads someone mid-ride.
  // {cache:'reload'} forces each asset from the network, not the HTTP cache — otherwise a version
  // bump can precache stale files and ship a half-updated app.
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(
    SHELL_ASSETS.map(u => new Request(u, {cache: 'reload'}))
  )));
});

// The page posts this when the user taps "refresh" on the update pill.
self.addEventListener('message', e => { if(e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

async function trimCache(name, max){
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if(keys.length <= max) return;
  for(let i=0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Analytics beacon (GoatCounter) -> never cache; let the pixel/beacon hit the network directly
  // so counts always register and the tile cache stays clean. (gc.zgo.at kept for older clients.)
  if(url.hostname === 'gc.zgo.at' || url.hostname.endsWith('.goatcounter.com')) return;

  // App navigations -> serve cached shell (offline-first for the page itself)
  if(req.mode === 'navigate'){
    e.respondWith(caches.match('index.html').then(r => r || fetch(req)));
    return;
  }

  // Live weather (NEA 2-hr forecast) -> network-first, fall back to last cached response offline
  if(url.hostname === 'api-open.data.gov.sg'){
    e.respondWith(
      fetch(req).then(res => {
        if(res && res.ok){ const copy = res.clone(); caches.open(TILES).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin static assets -> cache-first
  if(sameOrigin){
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Cross-origin (basemap tiles/glyphs/sprites) -> stale-while-revalidate
  e.respondWith(
    caches.open(TILES).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => {
        if(res && (res.ok || res.type === 'opaque')){ cache.put(req, res.clone()); trimCache(TILES, TILE_MAX); }
        return res;
      }).catch(() => null);
      return hit || net || fetch(req);
    })
  );
});
