import urllib.request, urllib.parse, json, time, os
UA='loop-pcn-app/1.0 (cycling map)'
EPS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.private.coffee/api/interpreter']
S,W,N,E=1.15,103.58,1.47,104.10
COLS,ROWS=5,4
def q(s,w,n,e):
    return f'[out:json][timeout:100];(way["highway"~"^(cycleway|path|footway|pedestrian|living_street|track)$"]({s},{w},{n},{e});way["bicycle"="designated"]({s},{w},{n},{e}););(._;>;);out body qt;'
def fetch(query):
    for a in range(6):
        ep=EPS[a%len(EPS)]
        try:
            data=urllib.parse.urlencode({'data':query}).encode()
            req=urllib.request.Request(ep,data=data,headers={'User-Agent':UA})
            return json.loads(urllib.request.urlopen(req,timeout=150).read())['elements']
        except Exception as ex:
            print(f'   retry {a+1}: {str(ex)[:50]}',flush=True); time.sleep(3+a*3)
    raise RuntimeError('tile failed')

coord={}; ways={}; done=set()
if os.path.exists('osm_all.json'):
    d=json.load(open('osm_all.json'))
    for el in d['elements']:
        if el['type']=='node': coord[el['id']]=(el['lon'],el['lat'])
        else: ways[el['id']]=el
if os.path.exists('done_tiles.json'): done=set(tuple(x) for x in json.load(open('done_tiles.json')))
print(f'resume: {len(ways)} ways {len(coord)} nodes, {len(done)} tiles done',flush=True)

dl=(E-W)/COLS; dh=(N-S)/ROWS; total=COLS*ROWS; i=0
for r in range(ROWS):
    for c in range(COLS):
        i+=1
        if (r,c) in done: continue
        s=S+dh*r; n=S+dh*(r+1); w=W+dl*c; e=W+dl*(c+1)
        els=fetch(q(s,w,n,e)); nn=ww=0
        for el in els:
            if el['type']=='node':
                if el['id'] not in coord: coord[el['id']]=(el['lon'],el['lat']); nn+=1
            elif el['type']=='way':
                if el['id'] not in ways: ways[el['id']]=el; ww+=1
        done.add((r,c))
        json.dump({'elements':[{'type':'node','id':k,'lon':v[0],'lat':v[1]} for k,v in coord.items()]+list(ways.values())},open('osm_all.json','w'))
        json.dump([list(x) for x in done],open('done_tiles.json','w'))
        print(f'tile {i}/{total} [{s:.2f},{w:.2f},{n:.2f},{e:.2f}] +{ww}w +{nn}n  tot {len(ways)}w/{len(coord)}n',flush=True)
        time.sleep(1)
print(f'DONE ways {len(ways)} nodes {len(coord)}',flush=True)
