'use strict';
/* Cycling Buddy SG — Singapore PCN cycling companion (PWA) */

const LOOP_COLORS = ['#FFD23F','#F59029','#CF3A22','#F26FC8','#A76BFF','#37BA66','#14A6C2'];
const OTHER = '#8894A0';
const ROUTE_ROAD = '#F79009';   // route on a car way (helmet warning)
const ROUTE_FOOT = '#94A3B8';   // route on a footpath
// CARTO free vector basemaps (no key; © OpenStreetMap © CARTO). Swap for a keyed/self-hosted source in production.
const LIGHT_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const DARK_STYLE  = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const colorExpr = ['match',['get','loop'],
  0,LOOP_COLORS[0],1,LOOP_COLORS[1],2,LOOP_COLORS[2],3,LOOP_COLORS[3],
  4,LOOP_COLORS[4],5,LOOP_COLORS[5],6,LOOP_COLORS[6], OTHER];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const getVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const emptyFC = () => ({type:'FeatureCollection',features:[]});
const D2R = Math.PI/180;
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

// ---------- state ----------
let META=null, CPN_META=null, PCN_FEATURES=[], mapLoaded=false, fitted=false;
const hidden = new Set();
let cpnVisible = true;
let user=null, nearest=null, locActive=false;
// routing
let routeMode=false, graphReady=false, graphLoading=null;
let routeStart=null, routeEnd=null, routeResult=null, mkStart=null, mkEnd=null;
let routeOptions=null, routeSel='max';
let recording=false, track=[], recDist=0, recStart=0, recTimer=null, lastPt=null;

// ---------- theme (before map init) ----------
const savedTheme = localStorage.getItem('theme');
document.documentElement.setAttribute('data-theme', savedTheme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'));
function updateThemeMeta(){ /* keep <meta theme-color> honest for the installed app */ }

// ---------- map ----------
const map = new maplibregl.Map({
  container:'map',
  style: isDark()?DARK_STYLE:LIGHT_STYLE,
  center:[103.85,1.36], zoom:10.4, maxZoom:19,
  attributionControl:false, dragRotate:false, pitchWithRotate:false
});
map.addControl(new maplibregl.AttributionControl({compact:true}), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({maxWidth:92, unit:'metric'}), 'bottom-left');
map.touchZoomRotate.disableRotation();

const geo = new maplibregl.GeolocateControl({
  positionOptions:{enableHighAccuracy:true, timeout:15000, maximumAge:2000},
  trackUserLocation:true, showUserHeading:true, showAccuracyCircle:true
});
map.addControl(geo, 'top-right'); // its default button is hidden via CSS; we drive it from our FAB
geo.on('geolocate', onPos);
geo.on('error', e => { setLocActive(false); toast(e && e.code===1 ? 'Location permission denied' : 'Couldn’t get your location'); });
geo.on('trackuserlocationstart', () => setLocActive(true));
geo.on('trackuserlocationend', () => setLocActive(false));

map.on('style.load', addLayers);          // fires on first load and after every setStyle
map.on('load', () => { mapLoaded=true; tryFit(); });

// tap-to-identify — prefer a park connector, fall back to a cycling path (handlers re-apply after a theme switch)
map.on('click', e => {
  if(routeMode){ handleRouteClick([e.lngLat.lng, e.lngLat.lat]); return; }
  const layers=['pcn-line','cpn-line'].filter(id=>map.getLayer(id));
  if(!layers.length) return;
  const hits=map.queryRenderedFeatures(e.point,{layers});
  if(!hits.length) return;
  const f=hits.find(h=>h.layer.id==='pcn-line') || hits[0];
  let html;
  if(f.layer.id==='pcn-line'){
    const li=f.properties.loop, col=(li>=0&&li<7)?LOOP_COLORS[li]:OTHER;
    html=`<b><i class="sw" style="background:${col}"></i>${esc(f.properties.name)}</b>${f.properties.park?`<span class="pk">${esc(f.properties.park)}</span>`:''}`;
  } else {
    html=`<b><i class="sw" style="background:${getVar('--cpn')}"></i>Cycling path</b>${f.properties.area?`<span class="pk">${esc(f.properties.area)}</span>`:''}`;
  }
  new maplibregl.Popup({className:'pcn-popup', closeButton:true, maxWidth:'240px'}).setLngLat(e.lngLat).setHTML(html).addTo(map);
});
['pcn-line','cpn-line'].forEach(id=>{
  map.on('mouseenter', id, () => map.getCanvas().style.cursor='pointer');
  map.on('mouseleave', id, () => map.getCanvas().style.cursor='');
});

function addLayers(){
  const dark = isDark();
  if(!map.getSource('cpn'))     map.addSource('cpn',{type:'geojson',data:'data/cpn.lines.geojson'});
  if(!map.getSource('pcn'))     map.addSource('pcn',{type:'geojson',data:'data/pcn.lines.geojson'});
  if(!map.getSource('nearest')) map.addSource('nearest',{type:'geojson',data:emptyFC()});
  if(!map.getSource('track'))   map.addSource('track',{type:'geojson',data:emptyFC()});

  const casing = dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.92)';
  const cpnColor  = getVar('--cpn') || (dark?'#84958D':'#5E7169');
  const cpnCasing = dark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.75)';
  const wLine = ['interpolate',['linear'],['zoom'], 10,1.4, 13,2.6, 16,5];
  const wCase = ['interpolate',['linear'],['zoom'], 10,3.4, 13,5.2, 16,8];
  const wCpn  = ['interpolate',['linear'],['zoom'], 11,0.8, 14,1.8, 17,3.4];
  const wCpnC = ['interpolate',['linear'],['zoom'], 11,1.8, 14,3.0, 17,5.2];
  const cpnVis = cpnVisible ? 'visible' : 'none';

  // Secondary network: LTA cycling paths — drawn beneath the park connectors so the PCN stays dominant
  if(!map.getLayer('cpn-casing')) map.addLayer({id:'cpn-casing',type:'line',source:'cpn',
    layout:{'line-join':'round','line-cap':'round','visibility':cpnVis}, paint:{'line-color':cpnCasing,'line-width':wCpnC,'line-opacity':0.75}});
  if(!map.getLayer('cpn-line')) map.addLayer({id:'cpn-line',type:'line',source:'cpn',
    layout:{'line-join':'round','line-cap':'round','visibility':cpnVis}, paint:{'line-color':cpnColor,'line-width':wCpn,'line-opacity':0.9}});

  // Primary network: park connectors
  if(!map.getLayer('pcn-casing')) map.addLayer({id:'pcn-casing',type:'line',source:'pcn',filter:loopFilter(),
    layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':casing,'line-width':wCase,'line-opacity':0.9}});
  if(!map.getLayer('pcn-line')) map.addLayer({id:'pcn-line',type:'line',source:'pcn',filter:loopFilter(),
    layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':colorExpr,'line-width':wLine}});
  if(!map.getLayer('near-line')) map.addLayer({id:'near-line',type:'line',source:'nearest',filter:['==','$type','LineString'],
    paint:{'line-color': dark?'#EAF2ED':'#15211B','line-width':2,'line-dasharray':[1,2],'line-opacity':0.7}});
  if(!map.getLayer('near-pt')) map.addLayer({id:'near-pt',type:'circle',source:'nearest',filter:['==','$type','Point'],
    paint:{'circle-radius':5,'circle-color':['get','color'],'circle-stroke-width':2,'circle-stroke-color': dark?'#141D19':'#ffffff'}});
  if(!map.getLayer('track-line')) map.addLayer({id:'track-line',type:'line',source:'track',
    layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':getVar('--rec'),'line-width':5,'line-opacity':0.95}});

  // planned route — on top of everything
  if(!map.getSource('route')) map.addSource('route',{type:'geojson',data:emptyFC()});
  if(!map.getLayer('route-casing')) map.addLayer({id:'route-casing',type:'line',source:'route',
    layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':dark?'#04202e':'#ffffff','line-width':['interpolate',['linear'],['zoom'],11,6,16,12],'line-opacity':0.95}});
  if(!map.getLayer('route-line')) map.addLayer({id:'route-line',type:'line',source:'route',
    layout:{'line-join':'round','line-cap':'round'}, paint:{
      'line-color':['match',['get','kind'], 'road', ROUTE_ROAD, 'foot', ROUTE_FOOT, getVar('--accent')],
      'line-width':['interpolate',['linear'],['zoom'],11,3.5,16,7.5]}});

  refreshNearestSource(); refreshTrackSource(); refreshRouteSource();
}
function refreshRouteSource(){
  const src=map.getSource&&map.getSource('route'); if(!src) return;
  if(routeResult && routeResult.legs && routeResult.legs.length){
    src.setData({type:'FeatureCollection', features: routeResult.legs.filter(l=>l.coords.length>1)
      .map(l=>({type:'Feature',properties:{kind:l.kind},geometry:{type:'LineString',coordinates:l.coords}}))});
  } else if(routeResult && routeResult.coords && routeResult.coords.length>1){
    src.setData({type:'FeatureCollection',features:[{type:'Feature',properties:{kind:'cycling'},geometry:{type:'LineString',coordinates:routeResult.coords}}]});
  } else src.setData(emptyFC());
}

function loopFilter(){ return ['!', ['in', ['get','loop'], ['literal', [...hidden]]]]; }
function applyFilter(){
  if(map.getLayer('pcn-casing')) map.setFilter('pcn-casing', loopFilter());
  if(map.getLayer('pcn-line'))   map.setFilter('pcn-line', loopFilter());
}

// ---------- data ----------
fetch('data/pcn.meta.json').then(r=>r.json()).then(m=>{ META=m; buildLegend(); fillStats(); tryFit(); });
fetch('data/pcn.lines.geojson').then(r=>r.json()).then(g=>{ PCN_FEATURES=g.features; });
fetch('data/cpn.meta.json').then(r=>r.json()).then(m=>{ CPN_META=m; appendCpnRow(); });

function tryFit(){
  if(fitted || !mapLoaded || !META) return;
  fitted=true;
  map.fitBounds(META.bounds, {padding:{top:80,bottom:180,left:40,right:40}, duration:0});
}

// ---------- geolocation & nearest ----------
function setLocActive(b){ locActive=b; $('locBtn').classList.toggle('active', b); }
function onPos(e){
  const c=e.coords;
  user={lat:c.latitude, lng:c.longitude, acc:c.accuracy, speed:c.speed};
  computeNearest(); updateNearUI(); refreshNearestSource();
  if(recording) pushTrack(user, e.timestamp);
}
function computeNearest(){
  if(!user || !PCN_FEATURES.length){ nearest=null; return; }
  const mLat=110540, mLng=111320*Math.cos(user.lat*D2R);
  let best=Infinity, bp=null, bl=-1;
  for(const f of PCN_FEATURES){
    const li=f.properties.loop; if(hidden.has(li)) continue;
    const c=f.geometry.coordinates;
    for(let i=1;i<c.length;i++){
      const ax=(c[i-1][0]-user.lng)*mLng, ay=(c[i-1][1]-user.lat)*mLat;
      const bx=(c[i][0]-user.lng)*mLng,   by=(c[i][1]-user.lat)*mLat;
      const dx=bx-ax, dy=by-ay, l2=dx*dx+dy*dy;
      let t = l2 ? ((-ax)*dx+(-ay)*dy)/l2 : 0; t=Math.max(0,Math.min(1,t));
      const px=ax+t*dx, py=ay+t*dy, d=px*px+py*py;
      if(d<best){ best=d; bl=li; bp=[c[i-1][0]+t*(c[i][0]-c[i-1][0]), c[i-1][1]+t*(c[i][1]-c[i-1][1])]; }
    }
  }
  nearest = bp ? {lng:bp[0], lat:bp[1], dist:Math.sqrt(best), loop:bl} : null;
}
function updateNearUI(){
  if(!nearest){ $('nearDist').textContent='—'; $('nearSub').textContent='Tap ◎ to locate'; updatePeek(); return; }
  const d=nearest.dist;
  $('nearDist').textContent = d<1000 ? Math.round(d)+' m' : (d/1000).toFixed(2)+' km';
  const nm = nearest.loop>=0 ? META.loops[nearest.loop].name : 'a park path';
  const col = nearest.loop>=0 ? LOOP_COLORS[nearest.loop] : OTHER;
  $('nearSub').innerHTML = `on <span class="dk-loop"><i style="background:${col}"></i>${esc(nm)}</span>`;
  updatePeek();
}
function refreshNearestSource(){
  const src = map.getSource && map.getSource('nearest'); if(!src) return;
  if(!user || !nearest){ src.setData(emptyFC()); return; }
  const col = nearest.loop>=0 ? LOOP_COLORS[nearest.loop] : OTHER;
  src.setData({type:'FeatureCollection', features:[
    {type:'Feature', geometry:{type:'LineString', coordinates:[[user.lng,user.lat],[nearest.lng,nearest.lat]]}, properties:{}},
    {type:'Feature', geometry:{type:'Point', coordinates:[nearest.lng,nearest.lat]}, properties:{color:col}}
  ]});
}

// ---------- recording ----------
function haversine(la1,lo1,la2,lo2){
  const R=6371000, dLa=(la2-la1)*D2R, dLo=(lo2-lo1)*D2R;
  const a=Math.sin(dLa/2)**2 + Math.cos(la1*D2R)*Math.cos(la2*D2R)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function fmtTime(s){ s=Math.max(0,Math.floor(s)); const h=Math.floor(s/3600),m=Math.floor(s%3600/60),ss=s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${m}:${String(ss).padStart(2,'0')}`; }
function pushTrack(u, ts){
  const t = ts || Date.now();
  if(lastPt){ const d=haversine(lastPt.lat,lastPt.lng,u.lat,u.lng); if(d>1.5 && d<80) recDist+=d; }
  track.push([u.lng,u.lat]); lastPt={lat:u.lat,lng:u.lng};
  refreshTrackSource(); updateRecUI();
}
function refreshTrackSource(){
  const src = map.getSource && map.getSource('track'); if(!src) return;
  src.setData(track.length>1 ? {type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:track},properties:{}}]} : emptyFC());
}
function updateRecUI(){
  const el=(performance.now()-recStart)/1000;
  $('recTime').textContent=fmtTime(el);
  $('recDist').textContent=(recDist/1000).toFixed(2);
  $('recStat').textContent=(recDist/1000).toFixed(2)+' km';
  $('recAvg').textContent = el>3 ? ((recDist/el)*3.6).toFixed(1) : '0.0';
  $('recCur').textContent = (user && user.speed!=null && user.speed>=0) ? (user.speed*3.6).toFixed(1) : '—';
  updatePeek();
}
function startRec(){
  if(!locActive) geo.trigger();
  recording=true; track=[]; recDist=0; lastPt=null; recStart=performance.now();
  $('recBtn').classList.add('active'); $('recBtn').setAttribute('aria-label','Stop recording');
  show('viewRec'); setDock(false);
  recTimer=setInterval(()=>{ track.length ? updateRecUI() : ($('recTime').textContent=fmtTime((performance.now()-recStart)/1000)); }, 1000);
}
function stopRec(){
  recording=false; clearInterval(recTimer);
  $('recBtn').classList.remove('active'); $('recBtn').setAttribute('aria-label','Record a ride');
  const el=(performance.now()-recStart)/1000;
  $('sumDist').textContent=(recDist/1000).toFixed(2);
  $('sumTime').textContent=fmtTime(el);
  $('sumAvg').textContent = el>3 ? ((recDist/el)*3.6).toFixed(1) : '0.0';
  if(track.length>1) show('viewSum'); else { show('viewNearest'); toast('Ride too short to save'); }
}
function buildGPX(){
  const pts=track.map(p=>`<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"></trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cycling Buddy SG" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>PCN ride ${new Date().toISOString().slice(0,10)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

// ---------- legend ----------
function buildLegend(){
  const body=$('lgBody'); body.innerHTML='';
  META.loops.forEach((lp,i)=>{
    const row=document.createElement('div'); row.className='lrow'; row.dataset.i=i;
    row.innerHTML =
      `<button class="sw" aria-pressed="true" aria-label="Toggle ${esc(lp.name)}"><i style="background:${LOOP_COLORS[i]}"></i></button>`+
      `<button class="meta" aria-label="Frame ${esc(lp.name)}"><span class="name">${esc(lp.name)}</span><span class="km">${lp.km.toFixed(1)} km</span></button>`+
      `<button class="zoom" aria-label="Frame ${esc(lp.name)}"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
    row.querySelector('.sw').addEventListener('click', ()=>toggleLoop(i,row));
    const frame=()=>zoomLoop(i);
    row.querySelector('.meta').addEventListener('click', frame);
    row.querySelector('.zoom').addEventListener('click', frame);
    body.appendChild(row);
  });
  appendCpnRow();
}
function appendCpnRow(){
  if(!CPN_META) return;
  const body=$('lgBody'); if(!body.children.length) return;   // loops not built yet — will be called again from buildLegend
  if(body.querySelector('.lrow-cpn')) return;                 // already added
  const sk=$('sheetCpnKm'); if(sk) sk.textContent=CPN_META.total_km.toFixed(1);
  const sep=document.createElement('div'); sep.className='lg-sep'; body.appendChild(sep);
  const row=document.createElement('div'); row.className='lrow lrow-cpn';
  row.innerHTML =
    `<button class="sw" aria-pressed="true" aria-label="Toggle cycling paths"><i style="background:var(--cpn)"></i></button>`+
    `<button class="meta" aria-label="Frame cycling paths"><span class="name">Cycling paths</span><span class="km">${CPN_META.total_km.toFixed(1)} km · LTA</span></button>`+
    `<button class="zoom" aria-label="Frame cycling paths"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
  row.querySelector('.sw').addEventListener('click', ()=>toggleCpn(row));
  const frame=()=>map.fitBounds(CPN_META.bounds,{padding:{top:80,bottom:180,left:40,right:40}});
  row.querySelector('.meta').addEventListener('click', frame);
  row.querySelector('.zoom').addEventListener('click', frame);
  body.appendChild(row);
}
function toggleCpn(row){
  cpnVisible=!cpnVisible;
  row.classList.toggle('off', !cpnVisible);
  row.querySelector('.sw').setAttribute('aria-pressed', String(cpnVisible));
  setCpnVis();
}
function setCpnVis(){
  const v = cpnVisible ? 'visible' : 'none';
  if(map.getLayer('cpn-line'))   map.setLayoutProperty('cpn-line','visibility',v);
  if(map.getLayer('cpn-casing')) map.setLayoutProperty('cpn-casing','visibility',v);
}
function toggleLoop(i,row){
  hidden.has(i) ? hidden.delete(i) : hidden.add(i);
  row.classList.toggle('off', hidden.has(i));
  row.querySelector('.sw').setAttribute('aria-pressed', String(!hidden.has(i)));
  applyFilter();
  if(user){ computeNearest(); updateNearUI(); refreshNearestSource(); }
}
function zoomLoop(i){
  if(!PCN_FEATURES.length) return;
  const b=new maplibregl.LngLatBounds();
  for(const f of PCN_FEATURES){ if(f.properties.loop!==i) continue; for(const c of f.geometry.coordinates) b.extend(c); }
  if(!b.isEmpty()) map.fitBounds(b, {padding:{top:80,bottom:180,left:40,right:40}, maxZoom:15});
}
function fillStats(){
  $('totalKm').textContent = META.total_km.toFixed(1)+' km';
  $('stKm').textContent = META.total_km.toFixed(0)+' km';
  $('stSeg').textContent = META.seg_count.toLocaleString();
  $('sheetKm').textContent = META.total_km.toFixed(1);
}

// ---------- views / dock ----------
const views={viewNearest:$('viewNearest'),viewRec:$('viewRec'),viewSum:$('viewSum'),viewRoute:$('viewRoute')};
function show(v){ for(const k in views) views[k].hidden = (k!==v); updatePeek(); setDockH(); }
function setDockH(){ document.documentElement.style.setProperty('--dockh', ($('dock').offsetHeight+14)+'px'); }
function setDock(collapsed){ $('dock').classList.toggle('collapsed', collapsed); $('dockHandle').setAttribute('aria-expanded', String(!collapsed)); updatePeek(); setDockH(); }
function updatePeek(){
  let t='Nearby';
  if(!views.viewNearest.hidden) t = nearest ? ('Nearest connector · '+$('nearDist').textContent) : 'Tap ◎ to find the nearest connector';
  else if(!views.viewRoute.hidden) t = routeResult ? ('Route · '+(routeResult.meters/1000).toFixed(1)+' km · '+Math.round(100*routeResult.cyclingPct)+'% cycling') : 'Plan a route';
  else if(!views.viewRec.hidden) t = 'Recording · '+(recDist/1000).toFixed(2)+' km';
  else if(!views.viewSum.hidden) t = 'Ride saved · '+$('sumDist').textContent+' km';
  $('dockPeek').textContent=t;
}

// ---------- theme toggle ----------
const SUN=`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>`;
const MOON=`<svg viewBox="0 0 24 24"><path d="M21 13A8.5 8.5 0 1 1 11 3a6.6 6.6 0 0 0 10 10z"/></svg>`;
function syncThemeIcon(){ $('themeBtn').innerHTML = isDark()?SUN:MOON; }
$('themeBtn').addEventListener('click', ()=>{
  const t = isDark()?'light':'dark';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  syncThemeIcon();
  map.setStyle(t==='dark'?DARK_STYLE:LIGHT_STYLE); // style.load re-adds our layers
});

// ---------- FABs ----------
$('locBtn').addEventListener('click', ()=>geo.trigger());
$('recBtn').addEventListener('click', ()=> recording?stopRec():startRec());
$('stopBtn').addEventListener('click', stopRec);
$('doneBtn').addEventListener('click', ()=>show('viewNearest'));
$('gpxBtn').addEventListener('click', ()=>{
  try{
    const blob=new Blob([buildGPX()],{type:'application/gpx+xml'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='pcn-ride-'+new Date().toISOString().slice(0,10)+'.gpx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    toast('GPX downloaded');
  }catch(err){ toast('Couldn’t export on this device'); }
});

// ---------- routing ----------
function ensureGraph(){
  if(graphReady) return Promise.resolve(true);
  if(graphLoading) return graphLoading;
  toast('Preparing routing…');
  graphLoading = fetch('data/graph.json').then(r=>{ if(!r.ok) throw new Error('nograph'); return r.json(); })
    .then(g=>{ Router.load(g); graphReady=true; return true; })
    .catch(()=>{ toast('Routing data isn’t available yet'); return false; });
  return graphLoading;
}
function enterRoute(){
  if(recording){ toast('Stop recording first'); return; }
  routeMode=true; $('routeBtn').classList.add('active'); map.getCanvas().style.cursor='crosshair';
  show('viewRoute'); resetRoutePanel(); setDock(false); ensureGraph();
}
function exitRoute(){
  routeMode=false; $('routeBtn').classList.remove('active'); map.getCanvas().style.cursor='';
  clearRoutePoints(); routeResult=null; refreshRouteSource(); show('viewNearest');
}
function rtHint(t){ const el=$('rtHint'); el.textContent=t; el.hidden=false; }
function hideOptions(){ $('rtOptions').hidden=true; $('rtDirs').hidden=true; $('rtNotice').hidden=true; $('rtKey').hidden=true; }
function resetRoutePanel(){ hideOptions(); routeOptions=null; rtHint('Tap the map to set your start — or use your location.'); updateRtButtons(); }
function setPoint(which,ll){
  const color = which==='start' ? '#22B573' : (getVar('--rec')||'#e02749');
  const m=new maplibregl.Marker({color}).setLngLat(ll).addTo(map);
  if(which==='start'){ if(mkStart)mkStart.remove(); mkStart=m; routeStart=ll; }
  else { if(mkEnd)mkEnd.remove(); mkEnd=m; routeEnd=ll; }
}
function clearRoutePoints(){ if(mkStart){mkStart.remove();mkStart=null;} if(mkEnd){mkEnd.remove();mkEnd=null;} routeStart=null; routeEnd=null; }
function handleRouteClick(ll){
  if(!routeStart){ setPoint('start',ll); rtHint('Now tap your destination.'); updateRtButtons(); }
  else if(!routeEnd){ setPoint('end',ll); computeRoute(); }
  else { clearRoutePoints(); routeResult=null; routeOptions=null; refreshRouteSource(); hideOptions(); setPoint('start',ll); rtHint('Now tap your destination.'); updateRtButtons(); }
}
function computeRoute(){
  if(!routeStart||!routeEnd) return;
  ensureGraph().then(ok=>{
    if(!ok) return;
    const two=Router.routeTwo(routeStart,routeEnd);
    if(!two){ routeOptions=null; routeResult=null; toast('No route found between those points'); hideOptions(); refreshRouteSource(); updateRtButtons(); return; }
    routeOptions=two; renderOptions(two); selectRouteOption('max', true); setDock(false);
    if(routeResult && routeResult.hasCarWay) toast('Heads up: this route uses roads — wear a helmet (required on Singapore roads).');
  });
}
function fmtMin(m){ m=Math.max(1,Math.round(m)); return m<60 ? m+' min' : Math.floor(m/60)+'h '+(m%60)+'m'; }
function optCard(k,label,r){
  const km=r.meters/1000, dist = km<1 ? Math.round(r.meters)+' m' : km.toFixed(1)+' km';
  return `<button class="rt-opt" data-k="${k}">`+
    `<span class="tag">${label}</span>`+
    `<span class="mid"><span class="big">${dist}</span><span class="sub">${fmtMin(r.meters/(16*1000/60))} · ${Math.round(100*r.pcnMeters/Math.max(1,r.meters))}% park connector</span></span>`+
    `<span class="pct">${Math.round(100*r.cyclingPct)}%<small>cycling</small></span>`+
    `</button>`;
}
function renderOptions(two){
  $('rtHint').hidden=true;
  const box=$('rtOptions'); box.hidden=false;
  const same=Math.abs(two.max.meters-two.balanced.meters)<50 && Math.abs(two.max.cyclingPct-two.balanced.cyclingPct)<0.01;
  box.innerHTML = same ? optCard('max','Best route',two.max)
                       : optCard('max','Most cycling',two.max)+optCard('balanced','Shorter',two.balanced);
  box.querySelectorAll('.rt-opt').forEach(el=>el.addEventListener('click',()=>selectRouteOption(el.dataset.k,false)));
}
function selectRouteOption(k, fit){
  if(!routeOptions) return;
  routeSel=k; routeResult=routeOptions[k]||routeOptions.max;
  $('rtOptions').querySelectorAll('.rt-opt').forEach(el=>el.classList.toggle('sel', el.dataset.k===k));
  refreshRouteSource(); renderDirs(routeResult.directions); updateRtButtons();
  $('rtKey').hidden=false;
  $('rtNotice').hidden = !routeResult.hasCarWay;
  updatePeek();
  if(fit){ const b=new maplibregl.LngLatBounds(); routeResult.coords.forEach(c=>b.extend(c)); map.fitBounds(b,{padding:{top:110,bottom:280,left:50,right:50}}); }
}
const DIR_ICONS={
  start:'<path d="M12 20V6"/><path d="M6 11l6-6 6 6"/>',
  arrive:'<path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11z"/><circle cx="12" cy="10" r="2.2"/>',
  left:'<path d="M15 19V9a3 3 0 0 0-3-3H6"/><path d="M9 3 5 6l4 3"/>',
  right:'<path d="M9 19V9a3 3 0 0 1 3-3h6"/><path d="m15 3 4 3-4 3"/>',
  'slight-left':'<path d="M14 20v-6a4 4 0 0 0-4-4H7"/><path d="M10 6 6 9l4 3"/>',
  'slight-right':'<path d="M10 20v-6a4 4 0 0 1 4-4h3"/><path d="m14 6 4 3-4 3"/>',
  'sharp-left':'<path d="M16 20V11a4 4 0 0 0-4-4H8"/><path d="M10 3 6 7l4 4"/>',
  'sharp-right':'<path d="M8 20V11a4 4 0 0 1 4-4h4"/><path d="m14 3 4 4-4 4"/>'
};
function renderDirs(dirs){
  const box=$('rtDirs'); box.innerHTML='';
  for(const d of dirs){
    const ic=DIR_ICONS[d.type]||DIR_ICONS.start;
    const dist = d.meters>=1000 ? (d.meters/1000).toFixed(1)+' km' : (d.meters?Math.round(d.meters)+' m':'');
    const row=document.createElement('div'); row.className='rt-step';
    row.innerHTML=`<span class="ic"><svg viewBox="0 0 24 24">${ic}</svg></span><span class="tx">${esc(d.text)}</span><span class="ds">${dist}</span>`;
    box.appendChild(row);
  }
  box.hidden=false;
}
function updateRtButtons(){
  $('rtClrBtn').hidden = !(routeStart||routeEnd);
  $('rtRevBtn').hidden = !(routeStart&&routeEnd);
  $('rtGpxBtn').hidden = !routeResult;
}
$('routeBtn').addEventListener('click', ()=> routeMode?exitRoute():enterRoute());
$('routeClose').addEventListener('click', exitRoute);
$('rtLocBtn').addEventListener('click', ()=>{
  if(!user){ geo.trigger(); toast('Getting your location…'); return; }
  setPoint('start',[user.lng,user.lat]);
  if(routeEnd) computeRoute(); else { rtHint('Now tap your destination.'); updateRtButtons(); }
});
$('rtRevBtn').addEventListener('click', ()=>{
  if(!routeStart||!routeEnd) return;
  const a=routeStart, b=routeEnd; clearRoutePoints(); setPoint('start',b); setPoint('end',a); computeRoute();
});
$('rtClrBtn').addEventListener('click', ()=>{ clearRoutePoints(); routeResult=null; routeOptions=null; refreshRouteSource(); hideOptions(); rtHint('Tap the map to set your start.'); updateRtButtons(); });
$('rtGpxBtn').addEventListener('click', ()=>{
  if(!routeResult) return;
  try{
    const pts=routeResult.coords.map(c=>`<trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"></trkpt>`).join('');
    const gpx=`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cycling Buddy SG" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>PCN route ${new Date().toISOString().slice(0,10)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([gpx],{type:'application/gpx+xml'}));
    a.download='pcn-route-'+new Date().toISOString().slice(0,10)+'.gpx';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    toast('Route GPX downloaded');
  }catch(err){ toast('Couldn’t export on this device'); }
});

// ---------- legend collapse ----------
const legend=$('legend'), lgHead=$('lgHead');
function toggleLegend(){ const c=legend.classList.toggle('collapsed'); lgHead.setAttribute('aria-expanded', String(!c)); }
lgHead.addEventListener('click', toggleLegend);
lgHead.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleLegend(); } });

// ---------- modal sheets (about / install) ----------
const scrim=$('scrim');
function openModal(el){ scrim.classList.add('open'); el.classList.add('open'); }
function closeModal(){ scrim.classList.remove('open'); document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open')); }
$('infoBtn').addEventListener('click', ()=>openModal($('sheet')));
$('closeSheet').addEventListener('click', closeModal);
$('closeInstall').addEventListener('click', closeModal);
scrim.addEventListener('click', closeModal);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });

// ---------- toast ----------
let toastT=null; const toastEl=$('toast');
function toast(msg){ toastEl.textContent=msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>toastEl.classList.remove('show'),3200); }

// ---------- install ----------
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone===true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
let deferredPrompt=null;
if(!isStandalone) $('installBtn').hidden=false;   // always offer an install path
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredPrompt=e; $('installBtn').hidden=false; });
$('installBtn').addEventListener('click', async ()=>{
  if(deferredPrompt){ deferredPrompt.prompt(); try{ await deferredPrompt.userChoice; }catch(e){} deferredPrompt=null; return; }
  $('installIos').hidden = !isIOS; $('installOther').hidden = isIOS;   // no native prompt (iOS, or not yet eligible) -> show steps
  openModal($('installSheet'));
});
window.addEventListener('appinstalled', ()=>{ $('installBtn').hidden=true; closeModal(); toast('Installed — find “Cycling Buddy” on your home screen'); });

// ---------- service worker ----------
if('serviceWorker' in navigator){ window.addEventListener('load', ()=> navigator.serviceWorker.register('sw.js').catch(()=>{})); }

// ---------- init ----------
syncThemeIcon();
$('dockHandle').addEventListener('click', ()=> setDock(!$('dock').classList.contains('collapsed')));
if(matchMedia('(max-width:560px)').matches){ legend.classList.add('collapsed'); lgHead.setAttribute('aria-expanded','false'); }
updatePeek();
setDockH();
window.addEventListener('resize', setDockH);
