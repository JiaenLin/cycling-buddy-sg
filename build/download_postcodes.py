#!/usr/bin/env python3
"""Build data/postcodes.bin — an offline Singapore postcode -> coordinate index.

Source: OpenStreetMap `addr:postcode` on nodes/ways/relations in the Singapore bbox, via Overpass
(ODbL, the same lineage as the routing graph and basemap). Coverage is "postcodes OSM knows about"
(buildings, estates and POIs), not the full SLA registry; unknown postcodes fall back gracefully in
the app. Ways/relations use their geometric centre.

Packed format (no header; the bbox below is fixed and mirrored by loadPostcodes() in app.js):
  7 bytes per record, records sorted by postcode:
    [0..2] postcode as uint24 big-endian (6-digit code, 0..999999)
    [3..4] latitude  quantised to uint16 over [S, N]
    [5..6] longitude quantised to uint16 over [W, E]
At uint16 the quantisation step is ~0.5 m (lat) / ~0.9 m (lng) — well inside a building footprint.
"""
import urllib.request, urllib.parse, json, sys, os

UA = 'cycling-buddy-sg/1.0 (offline postcode index build)'
EPS = ['https://overpass-api.de/api/interpreter',
       'https://overpass.kumi.systems/api/interpreter',
       'https://overpass.private.coffee/api/interpreter']
S, W, N, E = 1.15, 103.58, 1.47, 104.10   # Singapore bbox (must match app.js decoder)
QUERY = (f'[out:json][timeout:240];'
         f'(nwr["addr:postcode"]({S},{W},{N},{E}););'
         f'out center tags;')

def fetch():
    for a in range(6):
        ep = EPS[a % len(EPS)]
        try:
            data = urllib.parse.urlencode({'data': QUERY}).encode()
            req = urllib.request.Request(ep, data=data, headers={'User-Agent': UA})
            print(f'  querying {ep} …', flush=True)
            return json.loads(urllib.request.urlopen(req, timeout=280).read())['elements']
        except Exception as ex:
            print(f'  retry {a+1}: {str(ex)[:80]}', flush=True)
    raise RuntimeError('Overpass failed on all endpoints')

def coord_of(el):
    if el['type'] == 'node':
        return el.get('lon'), el.get('lat')
    c = el.get('center')
    return (c['lon'], c['lat']) if c else (None, None)

def main():
    els = fetch()
    print(f'  {len(els)} raw elements', flush=True)
    seen = {}
    for el in els:
        pc = (el.get('tags') or {}).get('addr:postcode', '').strip()
        if not (len(pc) == 6 and pc.isdigit()):
            continue
        lon, lat = coord_of(el)
        if lon is None or not (S <= lat <= N and W <= lon <= E):
            continue
        seen.setdefault(pc, (lon, lat))   # first occurrence wins; stable across rebuilds via sort
    codes = sorted(seen)
    out = bytearray()
    for pc in codes:
        lon, lat = seen[pc]
        n = int(pc)
        latq = min(65535, max(0, round((lat - S) / (N - S) * 65535)))
        lngq = min(65535, max(0, round((lon - W) / (E - W) * 65535)))
        out += bytes(((n >> 16) & 255, (n >> 8) & 255, n & 255,
                      latq >> 8, latq & 255, lngq >> 8, lngq & 255))
    dest = os.path.join(os.path.dirname(__file__), '..', 'data', 'postcodes.bin')
    with open(dest, 'wb') as f:
        f.write(out)
    print(f'DONE {len(codes)} unique postcodes -> data/postcodes.bin ({len(out)} bytes)', flush=True)

if __name__ == '__main__':
    sys.exit(main())
