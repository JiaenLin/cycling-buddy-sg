# Deploying Loop to HTTPS

The app needs **HTTPS** for phone GPS, install (Add to Home Screen), and the service
worker. `localhost` works for desktop testing; a phone needs a real HTTPS URL. Everything
in this folder is static — no build step — so hosting is just "serve these files."

## Fastest, no account — Netlify Drop (~60 seconds)
1. Go to **https://app.netlify.com/drop**
2. Drag the **`pwa`** folder onto the page.
3. You get an HTTPS URL like `https://loop-pcn-xxxx.netlify.app`.
4. Open it on your phone → **Locate** now uses real GPS; browser menu → **Add to Home Screen** to install.

(Creating a free Netlify account lets you keep the URL and re-deploy; without one it's still live, just unmanaged.)

## GitHub Pages (durable, free)
1. Create a repo, e.g. `loop-pcn`.
2. Put the **contents of `pwa/`** at the repo root (so `index.html` is at the top level).
3. Push, then repo **Settings → Pages → Build from branch → `main` / root**.
4. Live at `https://<user>.github.io/loop-pcn/` in ~1 minute.

## Cloudflare Pages
Dashboard → Workers & Pages → Create → Pages → **Upload assets** → drag the `pwa` folder. Instant HTTPS + CDN.

## Temporary tunnel (dev testing, no deploy)
With the local server running (`python -m http.server 8000 --directory pwa`), in another terminal:
```
npx localtunnel --port 8000
```
It prints an `https://…loca.lt` URL. First visit shows an interstitial asking for a
"tunnel password" — that's your public IP, shown at `https://loca.lt/mytunnelpassword`.
The tunnel dies when you stop the command; use it only for quick phone checks.

## Before real/public traffic
- **Basemap:** this prototype uses CARTO's free tiles. For sustained/public use, switch
  `LIGHT_STYLE` / `DARK_STYLE` in `app.js` to a keyed provider (MapTiler, Stadia) or a
  self-hosted OpenFreeMap/planet tileset. One line each.
- MapLibre is pinned in `vendor/` — no CDN dependency.
- The service worker (`sw.js`) precaches the app shell + your PCN/CPN data and runtime-caches
  basemap tiles, so once loaded the app works offline in the areas you've viewed.
