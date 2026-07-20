#!/usr/bin/env python3
"""Build data/mrt.json — an offline MRT/LRT station search index for the route planner.

Cyclists routinely ride *to a station* (park-and-ride, meeting a train), so stations are
a natural destination alongside parks and postcodes. We publish one small file of
[name, lng, lat] triples that the planner loads into its search index.

Two open LTA datasets (via data.gov.sg), both kept in the repo root, are fused:

  1. LTAMRTStationExitGEOJSON.geojson  — current station *exits* (Point). Grouped by
     STATION_NA; a station's coordinate is the centroid of its exits. This is the
     authoritative, up-to-date operational set (refreshed 2025-12).
  2. AmendmenttoMP2014RailStation.geojson — gazetted station *footprints* (Polygon) with
     a plain NAME. Used only to fill gaps: any station name not already covered by an
     exit is added at its polygon centroid. Honours the "use both files" request while
     letting the current exits file win on coordinates.

Output is coordinate triples only — no exit codes, no line codes — so the planner can
resolve a saved "… MRT" reference back to a point without ever storing coordinates
on-device (see the localStorage ref-only design in app.js).
"""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root (two up from build/)
EXITS = os.path.join(ROOT, 'LTAMRTStationExitGEOJSON.geojson')
POLYS = os.path.join(ROOT, 'AmendmenttoMP2014RailStation.geojson')
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mrt.json')

CODE_ONLY = re.compile(r'^[A-Z]{2}\d+([/&][A-Z]{2}\d+)*$')  # e.g. "CC30", "DT4", "NS3/EW24" — unnamed U/C stubs


def titlecase(s):
    return ' '.join(w[:1].upper() + w[1:].lower() if w else w for w in s.split(' '))


def clean_name(raw):
    """'ANG MO KIO MRT STATION' -> 'Ang Mo Kio MRT'; 'BUKIT PANJANG LRT STATION' -> '... LRT'."""
    n = raw.strip()
    kind = 'MRT'
    m = re.search(r'\b(MRT|LRT)\b', n)
    if m:
        kind = m.group(1)
    base = re.sub(r'\s*(MRT|LRT)?\s*STATION\s*$', '', n, flags=re.I).strip()
    base = re.sub(r'\s+', ' ', base)
    return titlecase(base) + ' ' + kind, re.sub(r'[^A-Z0-9]', '', base.upper())


def centroid_of_points(pts):
    return [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]


def poly_centroid(geom):
    rings = geom['coordinates'] if geom['type'] == 'Polygon' else \
        [r for poly in geom['coordinates'] for r in poly] if geom['type'] == 'MultiPolygon' else []
    pts = [c for ring in rings for c in ring]
    return centroid_of_points(pts) if pts else None


def main():
    stations = {}   # key -> {'name', 'lng', 'lat'}

    # 1) exits -> station centroids (authoritative, current)
    exits = json.load(open(EXITS, encoding='utf-8'))
    groups = {}
    for f in exits['features']:
        raw = (f['properties'].get('STATION_NA') or '').strip()
        if not raw or 'STATION' not in raw.upper() or CODE_ONLY.match(raw):
            continue
        groups.setdefault(raw, []).append(f['geometry']['coordinates'])
    for raw, pts in groups.items():
        name, key = clean_name(raw)
        c = centroid_of_points(pts)
        stations[key] = {'name': name, 'lng': c[0], 'lat': c[1]}
    from_exits = len(stations)

    # 2) MP2014 station polygons -> fill gaps only
    polys = json.load(open(POLYS, encoding='utf-8'))
    added = 0
    for f in polys['features']:
        raw = (f['properties'].get('NAME') or '').strip()
        if not raw or CODE_ONLY.match(raw) or not re.search(r'[A-Za-z]', raw):
            continue
        name, key = clean_name(raw)          # NAME has no "MRT STATION" suffix; clean_name appends "MRT"
        if key in stations:
            continue
        c = poly_centroid(f['geometry'])
        if not c:
            continue
        stations[key] = {'name': name, 'lng': c[0], 'lat': c[1]}
        added += 1

    rows = sorted(stations.values(), key=lambda s: s['name'])
    triples = [[s['name'], round(s['lng'], 5), round(s['lat'], 5)] for s in rows]
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(triples, fh, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(OUT)
    print(f'{len(triples)} stations  ({from_exits} from exits + {added} from MP2014 polygons)  ->  {OUT}  ({size:,} bytes)')
    print('sample:', triples[:3], '…', triples[-2:])


if __name__ == '__main__':
    main()
