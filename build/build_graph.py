import json, math, os, sys
from collections import defaultdict, Counter
CF=[0.85,0.95,1.90,1.05,1.20,1.35,1.45,1.70,2.30,3.00]
CLS={'cycleway':0,'path':1,'footway':2,'pedestrian':2,'living_street':3,
     'residential':4,'unclassified':4,'road':4,'service':5,'track':6,
     'tertiary':7,'tertiary_link':7,'secondary':8,'secondary_link':8,'primary':9,'primary_link':9}
EXCLUDE={'motorway','trunk','motorway_link','trunk_link','construction','steps',
         'proposed','razed','corridor','elevator','bridleway','raceway'}
GJ='../data/'

def haversine(a,b):
    R=6371000;D=math.pi/180
    dLa=(b[1]-a[1])*D;dLo=(b[0]-a[0])*D
    s=math.sin(dLa/2)**2+math.cos(a[1]*D)*math.cos(b[1]*D)*math.sin(dLo/2)**2
    return 2*R*math.asin(math.sqrt(s))
def rdp(pts,eps):
    if len(pts)<3: return pts
    dmax,idx=0,0; a,b=pts[0],pts[-1]
    dx,dy=b[0]-a[0],b[1]-a[1]; L2=dx*dx+dy*dy
    for i in range(1,len(pts)-1):
        p=pts[i]
        if L2==0: d=math.hypot(p[0]-a[0],p[1]-a[1])
        else:
            t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2)); d=math.hypot(p[0]-(a[0]+t*dx),p[1]-(a[1]+t*dy))
        if d>dmax: dmax,idx=d,i
    if dmax>eps: return rdp(pts[:idx+1],eps)[:-1]+rdp(pts[idx:],eps)
    return [a,b]

def main():
    coord={}; ways=[]
    for fn in ('osm_all.json','osm_roads.json'):
        if not os.path.exists(fn): continue
        osm=json.load(open(fn,encoding='utf-8'))
        for e in osm['elements']:
            if e['type']=='node': coord.setdefault(e['id'],(e['lon'],e['lat']))
            elif e.get('nodes'): ways.append(e)
    print('ways',len(ways),'nodes(raw)',len(coord),flush=True)
    # underlying edges + adjacency (multigraph)
    adj=defaultdict(list); eid=0; deg=Counter()
    for w in ways:
        t=w.get('tags',{}); hw=t.get('highway')
        if hw in EXCLUDE: continue
        cls=CLS.get(hw)
        if cls is None:
            if t.get('bicycle')=='designated': cls=0
            else: continue
        nds=[n for n in w['nodes'] if n in coord]
        for i in range(1,len(nds)):
            a,b=nds[i-1],nds[i]
            if a==b: continue
            adj[a].append((b,cls,eid)); adj[b].append((a,cls,eid)); deg[a]+=1; deg[b]+=1; eid+=1
    junction=set(n for n in adj if deg[n]!=2)
    print('underlying edges',eid,'junctions',len(junction),'(of',len(adj),'nodes)',flush=True)
    # contract chains between junctions
    visited=set(); cedges=[]  # (jA,jB, geom node-ids, cls)
    for j in junction:
        for (nbr,cls,e0) in adj[j]:
            if e0 in visited: continue
            visited.add(e0); geom=[j,nbr]; ccls=[cls]; cur=nbr; came=e0
            while cur not in junction:
                nxt=None
                for (nb,c,e) in adj[cur]:
                    if e!=came and e not in visited: nxt=(nb,c,e); break
                if not nxt: break
                nb,c,e=nxt; visited.add(e); geom.append(nb); ccls.append(c); came=e; cur=nb
            rep=max(ccls,key=lambda k:CF[k])
            cedges.append((j,cur,geom,rep))
    # largest connected component over junction graph
    jadj=defaultdict(list)
    for i,(a,b,g,cls) in enumerate(cedges):
        jadj[a].append(b); jadj[b].append(a)
    seen=set(); best=[]
    for start in junction:
        if start in seen: continue
        comp=[]; st=[start]; seen.add(start)
        while st:
            x=st.pop(); comp.append(x)
            for y in jadj[x]:
                if y not in seen: seen.add(y); st.append(y)
        if len(comp)>len(best): best=comp
    keep=set(best); print('contracted junctions',len(junction),'largest comp %.1f%%'%(100*len(keep)/max(1,len(junction))),flush=True)
    # reindex + PCN grid
    idx={}; nodes=[]
    for n in keep:
        idx[n]=len(nodes); nodes.append([round(coord[n][0],6),round(coord[n][1],6)])
    pcn=json.load(open(GJ+'pcn.lines.geojson',encoding='utf-8'))['features']
    lat0=1.35; mLng=111320*math.cos(lat0*math.pi/180); mLat=110540; CELL=12.0
    grid=defaultdict(list)
    for f in pcn:
        c=f['geometry']['coordinates']
        for i in range(1,len(c)):
            ax,ay=c[i-1][0]*mLng,c[i-1][1]*mLat; bx,by=c[i][0]*mLng,c[i][1]*mLat
            L=math.hypot(bx-ax,by-ay); st=max(1,int(L//CELL)+1)
            for s in range(st+1):
                t=s/st; grid[(int((ax+(bx-ax)*t)//CELL),int((ay+(by-ay)*t)//CELL))].append((ax+(bx-ax)*t,ay+(by-ay)*t))
    def nearpcn(lng,lat):
        x,y=lng*mLng,lat*mLat; cx,cy=int(x//CELL),int(y//CELL)
        for gx in(-1,0,1):
            for gy in(-1,0,1):
                for px,py in grid.get((cx+gx,cy+gy),()):
                    if (px-x)**2+(py-y)**2<=144: return True
        return False
    # emit edges
    edges=[]; pcncnt=0; ptsBefore=ptsAfter=0
    for (a,b,g,cls) in cedges:
        if a not in keep or b not in keep: continue
        pts=[coord[n] for n in g]; ptsBefore+=len(pts)
        pts=rdp([[round(p[0],5),round(p[1],5)] for p in pts], 3e-5); ptsAfter+=len(pts)
        # PCN preference ONLY for path-like edges (cycleway/path/footway/track) — a park
        # connector is never a car road, so roads near a PCN must not be flagged.
        p=0
        if cls in (0,1,2,6):
            for q in (pts[0],pts[len(pts)//2],pts[-1]):
                if nearpcn(q[0],q[1]): p=1;break
        if p: pcncnt+=1
        interior=[]
        for q in pts[1:-1]: interior+= [q[0],q[1]]
        edges.append([idx[a],idx[b],cls,p,interior])
    s=json.dumps({'nodes':nodes,'edges':edges},separators=(',',':'))
    open(GJ+'graph.json','w',encoding='utf-8').write(s)
    print('FINAL nodes',len(nodes),'edges',len(edges),'pcn-edges',pcncnt,flush=True)
    print('geom points',ptsBefore,'->',ptsAfter,'  bytes',len(s),'(%.2f MB)'%(len(s)/1048576),flush=True)

if __name__=='__main__': main()
