# Cycling Buddy SG — Singapore Park Connector cycling companion

An installable, **offline-capable** cycling map for Singapore's Park Connector Network (PCN).
Find the nearest connector, plan routes that prefer park connectors, record rides, and see the
whole network — on a real street basemap, no app store, no API key.

**Live:** https://jiaenlin.github.io/cycling-buddy-sg/

## Features
- **Map** — the 7 PCN loops (colour-coded) + LTA cycling paths, on a light/dark street basemap.
- **Locate** — live GPS position and the nearest park connector.
- **Route** — offline turn-by-turn A* routing with a cycling cost profile that prefers
  cycleways/park connectors over roads over footpaths, and **excludes expressways**. Two options
  per trip (*Most cycling* / *Shorter*, ≤30% non-cycling), each drawn **colour-coded by segment**
  (cycling path / road / footpath) with a **helmet notice** when a route uses roads.
- **Record** — trace a ride with live distance/time/speed, export **GPX**.
- **Installable PWA** — Add to Home Screen; a service worker caches the app shell + data for offline use.

## Run locally
Any static server over HTTP works (a service worker + geolocation need `localhost` or HTTPS):
```bash
python -m http.server 8000      # then open http://localhost:8000
```

## Data & attribution
- **Park connectors:** NParks *Park Connector Loop* (data.gov.sg).
- **Cycling paths:** LTA *Cycling Path Network*.
- **Routing graph & basemap:** © OpenStreetMap contributors (ODbL); basemap tiles © CARTO.

The routing graph (`data/graph.json`) is generated from OpenStreetMap — see [`build/`](build/).

## Tech
Vanilla JS, [MapLibre GL JS](https://maplibre.org/) (vendored, no CDN), a hand-rolled A* router
(`router.js`) over a contracted OSM graph. No build step — it's plain static files.
