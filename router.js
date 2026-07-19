/* © 2026 Lin Jiaen · All rights reserved
   Cycling Buddy SG — offline bike router over an OpenStreetMap-derived graph.
   Built at design time from OSM (ways share node ids at junctions, so it's properly
   connected), degree-2 nodes contracted, and bundled as data/graph.json. Runs A* with a
   cycling cost profile that prefers park connectors. Works in the browser (window.Router)
   and Node (module.exports) for headless verification.

   graph.json:
     { nodes: [[lng,lat], ...],                          // junction/endpoint nodes
       edges: [[a, b, cls, pcn, [ix,iy,ix,iy,...]], ...]} // a,b node ids; cls 0..9; pcn 0|1;
                                                          // trailing interior shape points (5dp), may be []
*/
(function(global){
  'use strict';
  const D2R=Math.PI/180, R=6371000;
  // highway class -> cost multiplier per metre (lower = preferred for cycling).
  // Dedicated cycling infra is cheap; footways (road-side sidewalks) are a last-resort connector.
  // cost multiplier per metre (lower = preferred). Order: cycling paths < quiet roads < footways < big roads.
  // Expressways (motorway/trunk) are excluded from the graph entirely.
  const CLASS_FACTOR=[0.85,0.95,1.90,1.05,1.20,1.35,1.45,1.70,2.30,3.00];
  //                  0cyc 1path 2foot 3live 4res  5serv 6trk 7ter 8sec 9pri
  const PCN_BONUS=0.60;   // park-connector edges are strongly preferred
  const H_FACTOR=0.50;    // <= min cost factor (cycleway 0.85 * PCN_BONUS 0.60 = 0.51) => admissible A*
  const MAX_SNAP=250;     // metres: a tap beyond this from any node has no nearby routable path

  let NODES=[], ADJ=[], loaded=false;

  function haversine(a,b){
    const dLa=(b[1]-a[1])*D2R, dLo=(b[0]-a[0])*D2R;
    const s=Math.sin(dLa/2)**2+Math.cos(a[1]*D2R)*Math.cos(b[1]*D2R)*Math.sin(dLo/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function bearing(a,b){
    const y=Math.sin((b[0]-a[0])*D2R)*Math.cos(b[1]*D2R);
    const x=Math.cos(a[1]*D2R)*Math.sin(b[1]*D2R)-Math.sin(a[1]*D2R)*Math.cos(b[1]*D2R)*Math.cos((b[0]-a[0])*D2R);
    return (Math.atan2(y,x)/D2R+360)%360;
  }
  function Heap(){ this.a=[]; }
  Heap.prototype.push=function(k,p){ const a=this.a; a.push({k,p}); let i=a.length-1;
    while(i>0){ const par=(i-1)>>1; if(a[par].p<=a[i].p) break; const t=a[par]; a[par]=a[i]; a[i]=t; i=par; } };
  Heap.prototype.pop=function(){ const a=this.a; if(!a.length) return null; const top=a[0], last=a.pop();
    if(a.length){ a[0]=last; let i=0; for(;;){ let l=2*i+1,r=l+1,s=i;
      if(l<a.length&&a[l].p<a[s].p)s=l; if(r<a.length&&a[r].p<a[s].p)s=r; if(s===i)break; const t=a[s];a[s]=a[i];a[i]=t;i=s; } }
    return top.k; };
  Object.defineProperty(Heap.prototype,'size',{get(){return this.a.length;}});

  function load(graph){
    NODES=graph.nodes;
    ADJ=new Array(NODES.length); for(let i=0;i<NODES.length;i++) ADJ[i]=[];
    for(const e of graph.edges){
      const a=e[0], b=e[1], cls=e[2]|0, pcn=e[3]?1:0, gi=e[4]||[];
      if(a===b) continue;
      const fwd=[NODES[a]]; for(let k=0;k<gi.length;k+=2) fwd.push([gi[k],gi[k+1]]); fwd.push(NODES[b]);
      let len=0; for(let k=1;k<fwd.length;k++) len+=haversine(fwd[k-1],fwd[k]);
      const w=(CLASS_FACTOR[cls]!=null?CLASS_FACTOR[cls]:1.4)*(pcn?PCN_BONUS:1);
      ADJ[a].push({to:b,len,w,pcn,cls,geom:fwd});
      ADJ[b].push({to:a,len,w,pcn,cls,geom:fwd.slice().reverse()});
    }
    loaded=true;
    return {nodes:NODES.length, edges:graph.edges.length};
  }

  function nearestNode(ll){
    let best=Infinity,bi=-1;
    for(let i=0;i<NODES.length;i++){ const c=NODES[i]; const dx=c[0]-ll[0], dy=c[1]-ll[1]; const d=dx*dx+dy*dy;
      if(d<best){ best=d; bi=i; } }
    return bi<0?null:{i:bi, co:NODES[bi], dist:haversine(ll,NODES[bi])};
  }

  // "cycling path" = cycleway/path/track or a flagged park connector; roads(3,4,5,7,8,9)=car way; 2=footway
  const isCyclingEdge = e => (e.cls===0 || e.cls===1 || e.cls===6 || e.pcn===1);
  const kindOf = (cls,pcn) => (cls===0||cls===1||cls===6||pcn) ? 'cycling' : (cls===2 ? 'foot' : 'road');

  function route(start,end,opts){
    if(!loaded) return null;
    const ncm=(opts&&opts.ncm)||1;   // extra penalty on non-cycling edges (footways/roads)
    const s=nearestNode(start), t=nearestNode(end);
    if(!s||!t) return null;
    if(s.dist>MAX_SNAP || t.dist>MAX_SNAP) return null;   // tap has no nearby routable path (offshore/out-of-coverage)
    if(s.i===t.i) return {coords:[NODES[s.i].slice()], legs:[], meters:0, pcnMeters:0, cyclingMeters:0, roadMeters:0, footMeters:0, cyclingPct:0, hasCarWay:false, directions:[], snapStart:s, snapEnd:t, ok:true};
    const goal=NODES[t.i], N=NODES.length;
    const g=new Float64Array(N).fill(Infinity);
    const cameFrom=new Int32Array(N).fill(-1);
    const cameGeom=new Array(N);
    const cameLen=new Float64Array(N);
    const cameuPcn=new Uint8Array(N);
    const cameCls=new Int8Array(N).fill(-1);
    const closed=new Uint8Array(N);
    const open=new Heap();
    g[s.i]=0; open.push(s.i, H_FACTOR*haversine(s.co,goal));
    let found=false;
    while(open.size){
      const cur=open.pop();
      if(cur===t.i){ found=true; break; }
      if(closed[cur]) continue; closed[cur]=1;
      const gc=g[cur], list=ADJ[cur];
      for(let k=0;k<list.length;k++){
        const e=list[k]; const ng=gc + e.len*e.w*(isCyclingEdge(e)?1:ncm);
        if(ng<g[e.to]){ g[e.to]=ng; cameFrom[e.to]=cur; cameGeom[e.to]=e.geom; cameLen[e.to]=e.len; cameuPcn[e.to]=e.pcn; cameCls[e.to]=e.cls;
          open.push(e.to, ng + H_FACTOR*haversine(NODES[e.to],goal)); }
      }
    }
    if(!found) return null;
    const edgesRev=[]; let n=t.i, meters=0, pcnMeters=0, cyclingMeters=0, roadMeters=0, footMeters=0;
    while(n!==s.i){
      const cls=cameCls[n], pcn=cameuPcn[n], L=cameLen[n], kind=kindOf(cls,pcn);
      edgesRev.push({geom:cameGeom[n], kind});
      meters+=L; if(pcn)pcnMeters+=L;
      if(kind==='cycling')cyclingMeters+=L; else if(kind==='road')roadMeters+=L; else footMeters+=L;
      const p=cameFrom[n]; if(p<0) break; n=p;
    }
    edgesRev.reverse();
    const coords=[], legs=[];
    for(let i=0;i<edgesRev.length;i++){
      const seg=edgesRev[i].geom, kind=edgesRev[i].kind;
      for(let k=(i?1:0);k<seg.length;k++) coords.push(seg[k].slice());
      if(legs.length && legs[legs.length-1].kind===kind){ const cur=legs[legs.length-1].coords; for(let k=1;k<seg.length;k++) cur.push(seg[k].slice()); }
      else legs.push({kind, coords:seg.map(c=>c.slice())});
    }
    const cyclingPct = meters?cyclingMeters/meters:0;
    return {coords, legs, meters, pcnMeters, cyclingMeters, roadMeters, footMeters, cyclingPct, hasCarWay:roadMeters>0,
            directions:directionsFrom(coords), snapStart:s, snapEnd:t, ok:true};
  }

  // Two options: (1) maximum cycling-path %, (2) shortest route with <=30% non-cycling.
  function routeTwo(start,end){
    const mults=[0.5,1,2,3.5,6,10]; const cands=[];
    for(const m of mults){ const r=route(start,end,{ncm:m}); if(r&&r.meters>0){ r.cyclingPct=r.cyclingMeters/r.meters; cands.push(r); } }
    if(!cands.length){ const r0=route(start,end); if(r0) r0.cyclingPct=r0.meters?r0.cyclingMeters/r0.meters:0; return r0?{max:r0,balanced:r0}:null; }
    let mx=cands[0];
    for(const c of cands){ if(c.cyclingPct>mx.cyclingPct+1e-4 || (Math.abs(c.cyclingPct-mx.cyclingPct)<=1e-4 && c.meters<mx.meters)) mx=c; }
    let bal=null;
    for(const c of cands){ if(c.cyclingPct>=0.70 && (!bal || c.meters<bal.meters)) bal=c; }
    if(!bal) bal=mx;
    return {max:mx, balanced:bal};
  }

  const COMPASS=['N','NE','E','SE','S','SW','W','NW'];
  const compass=b=>COMPASS[Math.round(((b%360)+360)%360/45)%8];
  const norm=a=>((a+180)%360+360)%360-180;
  const turnText=t=>{ const s=t<0?'left':'right',m=Math.abs(t); return m<45?('Bear '+s):(m<120?('Turn '+s):('Sharp '+s)); };
  const turnType=t=>{ const s=t<0?'left':'right',m=Math.abs(t); return (m<45?'slight-':m<120?'':'sharp-')+s; };

  function directionsFrom(coords){
    if(coords.length<2) return [];
    const dirs=[{type:'start', text:'Head '+compass(bearing(coords[0],coords[1])), meters:0}];
    let leg=0, cur=bearing(coords[0],coords[1]);
    for(let i=1;i<coords.length-1;i++){
      leg+=haversine(coords[i-1],coords[i]);
      const b2=bearing(coords[i],coords[i+1]); const turn=norm(b2-cur);
      if(Math.abs(turn)>=32 && leg>15){ dirs[dirs.length-1].meters=leg; dirs.push({type:turnType(turn),text:turnText(turn),meters:0}); leg=0; }
      cur=b2;
    }
    leg+=haversine(coords[coords.length-2],coords[coords.length-1]);
    dirs[dirs.length-1].meters=leg;
    dirs.push({type:'arrive', text:'Arrive at destination', meters:0});
    return dirs;
  }

  const Router={ load, route, routeTwo, nearestNode, MAX_SNAP, get loaded(){return loaded;}, get size(){return NODES.length;} };
  if(typeof module!=='undefined' && module.exports) module.exports=Router; else global.Router=Router;
})(typeof self!=='undefined'?self:this);
