# Building the routing graph

`data/graph.json` is generated from OpenStreetMap. To regenerate it (e.g. to refresh from newer
OSM data), run these from inside this `build/` folder with Python 3:

```bash
# 1. Download the bikeable network from OpenStreetMap (tiled + resumable via Overpass API)
python download_paths.py     # cycleway/path/footway/pedestrian/living_street/track  -> osm_all.json
python download_roads.py     # residential/tertiary/secondary/primary (+links), no expressway/service -> osm_roads.json

# 2. Build the contracted, routable graph (writes ../data/graph.json)
python build_graph.py
```

## How it works
- **Why OSM, not the PCN/CPN data:** the NParks/LTA GeoJSONs are *display* data — their segments
  don't share endpoints at junctions, so they only connect ~4–30% and can't be routed. OSM ways
  share node ids at intersections, so they build into a properly connected graph.
- **download_*.py** query Overpass per tile (retrying on 429/504) and merge nodes + ways.
- **build_graph.py**
  - Builds an undirected graph at OSM-node granularity, then **contracts** degree-2 shape nodes
    into edges that carry their geometry (junction nodes only remain).
  - Keeps the **largest connected component** (~77%; the rest is Johor in the bbox + islands + fragments).
  - Flags **park-connector edges** by spatial match to `../data/pcn.lines.geojson` — but only for
    *path-type* edges (cycleway/path/footway/track), never roads (a PCN is never a car road).
  - Simplifies edge geometry (RDP ~3 m) and writes `nodes` + `edges` (`[a,b,cls,pcn,interior]`).

## Cost model (in `router.js`, not here)
`CLASS_FACTOR` per metre — cycleway 0.85, path 0.95, living-st 1.05, residential 1.20, service 1.35,
track 1.45, tertiary 1.70, **footway 1.90**, secondary 2.30, primary 3.00; park-connector edges ×0.60.
Expressways (motorway/trunk) are excluded from the graph entirely. Tune there and reload — no rebuild needed.

> `osm_all.json` / `osm_roads.json` are large intermediates and are git-ignored.
