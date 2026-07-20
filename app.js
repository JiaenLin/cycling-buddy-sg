'use strict';
/* Cycling Buddy SG — Singapore PCN cycling companion (PWA)
   © 2026 Lin Jiaen · All rights reserved · https://github.com/JiaenLin/cycling-buddy-sg */

const LOOP_COLORS = ['#FFD23F','#F59029','#CF3A22','#F26FC8','#A76BFF','#37BA66','#14A6C2'];
const OTHER = '#8894A0';
const ROUTE_ROAD = '#F79009';   // route on a car way (helmet warning)
const ROUTE_FOOT = '#94A3B8';   // route on a footpath
// OpenFreeMap vector basemaps — free for production use, no API key, no usage limits (© OpenStreetMap)
const LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const DARK_STYLE  = 'https://tiles.openfreemap.org/styles/dark';

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
let META=null, CPN_META=null, RAIL_META=null, PCN_FEATURES=[], mapLoaded=false, fitted=false;
let PARKS_META=null, RACKS_META=null, RACK_FEATURES=[], nearRack=null, CLOSURES_META=null, POI=[];
const hidden = new Set();
let cpnVisible = true, railVisible = true, parksVisible = true, racksVisible = true, closuresVisible = true;
let user=null, nearest=null, locActive=false;
// routing
let routeMode=false, graphReady=false, graphLoading=null;
let routeStart=null, routeEnd=null, routeResult=null, mkStart=null, mkEnd=null;
let routeOptions=null, routeSel='best', routeEndName=null, altsOpen=false;
let recording=false, track=[], recDist=0, recStart=0, recStartEpoch=0, recTimer=null, lastPt=null;
let pendingUpdateWorker=null, renderPendingUpdate=null;
// compass / heading-follow ("face direction") mode
let headingMode=false, deviceHeading=null, deviceHeadingTs=0, camRAF=null, navStage=0; // navStage: 0 off · 1 facing (zoom-in) · 2 overview (zoom-out + route arrows)
const camTarget={center:null, bearing:null};
// weather (NEA 2-hour forecast)
let WX=null, wxLoading=null, wxVisible=false, ZONES=null;

// ---------- theme (before map init) ----------
const savedTheme = localStorage.getItem('theme');
document.documentElement.setAttribute('data-theme', savedTheme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'));
function updateThemeMeta(){ /* keep <meta theme-color> honest for the installed app */ }

// ---------- map ----------
const map = new maplibregl.Map({
  container:'map',
  style: isDark()?DARK_STYLE:LIGHT_STYLE,
  center:[103.85,1.36], zoom:10.4, maxZoom:19,
  attributionControl:false,
  dragRotate:true, pitchWithRotate:false, touchPitch:false, maxPitch:0  // rotatable, but kept top-down (no tilt)
});
map.addControl(new maplibregl.AttributionControl({compact:true}), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({maxWidth:92, unit:'metric'}), 'bottom-left');
map.touchZoomRotate.enableRotation();  // two-finger twist rotates the map

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
map.on('load', () => { mapLoaded=true; tryFit(); resumeRec(); });

// tap-to-identify — prefer a park connector, fall back to a cycling path (handlers re-apply after a theme switch)
function onMapClick(e){
  // While planning, a tap sets a point only while one is still needed; once both ends
  // exist the tap falls through to feature inspection, so a stray tap never wipes the route.
  if(routeMode && (!routeStart || !routeEnd)){ handleRouteClick([e.lngLat.lng, e.lngLat.lat]); return; }
  // a closure alert outranks everything — it's the most important thing to surface if tapped
  const closeLayers=['closed-marker','risk-glow'].filter(id=>map.getLayer(id));
  const closeHit = closeLayers.length ? map.queryRenderedFeatures(e.point,{layers:closeLayers})[0] : null;
  if(closeHit){ showClosurePopup(e); return; }
  // a rack is a small, deliberate target — it outranks whatever line or park sits under it
  const rackHit = map.getLayer('racks-pt') ? map.queryRenderedFeatures(e.point,{layers:['racks-pt']})[0] : null;
  if(rackHit){ showRackPopup(e, rackHit); return; }
  // cycling lines take priority so they stay tappable while the rain overlay is on
  const lineLayers=['pcn-line','rail-open','rail-closed','cpn-line'].filter(id=>map.getLayer(id));
  const hits = lineLayers.length ? map.queryRenderedFeatures(e.point,{layers:lineLayers}) : [];
  const isRail=id=>id==='rail-open'||id==='rail-closed';
  if(!hits.length){
    if(wxVisible){ showWxPopup(e); return; }   // rain map is on → that tap means "forecast here"
    // otherwise fall through to the park underneath, if any
    const parkHit = map.getLayer('parks-fill') ? map.queryRenderedFeatures(e.point,{layers:['parks-fill']})[0] : null;
    if(parkHit) showParkPopup(e, parkHit);
    return;
  }
  const f=hits.find(h=>h.layer.id==='pcn-line') || hits.find(h=>isRail(h.layer.id)) || hits[0];
  let html;
  if(f.layer.id==='pcn-line'){
    const li=f.properties.loop, col=(li>=0&&li<7)?LOOP_COLORS[li]:OTHER;
    html=`<b><i class="sw" style="background:${col}"></i>${esc(f.properties.name)}</b>${f.properties.park?`<span class="pk">${esc(f.properties.park)}</span>`:''}`;
  } else if(isRail(f.layer.id)){
    const closed=f.properties.status==='closed';
    html=`<b><i class="sw" style="background:var(--rail)"></i>Rail Corridor</b><span class="pk">${closed?'Closed for improvement works · reopening 2027':'Open · former KTM railway trail'}</span>`;
  } else {
    html=`<b><i class="sw" style="background:${getVar('--cpn')}"></i>Cycling path</b>${f.properties.area?`<span class="pk">${esc(f.properties.area)}</span>`:''}`;
  }
  new maplibregl.Popup({className:'pcn-popup', closeButton:true, maxWidth:'240px'}).setLngLat(e.lngLat).setHTML(html).addTo(map);
}
map.on('click', onMapClick);
function showClosurePopup(e){
  const c = (CLOSURES_META && CLOSURES_META.active && CLOSURES_META.active[0]) || {};
  const title = c.title || 'Cycling diversion';
  const note = c.note || 'This area is closed to cyclists — follow on-site signage.';
  const link = c.url ? `<a class="pk-link" href="${esc(c.url)}" target="_blank" rel="noopener">Official diversion map ↗</a>`
                     : (c.src ? `<span class="pk" style="opacity:.75">Source: ${esc(c.src)}</span>` : '');
  const html=`<b><i class="sw" style="background:var(--closed)"></i>${esc(title)}</b><span class="pk">${esc(note)}</span>${link}`;
  new maplibregl.Popup({className:'pcn-popup', closeButton:true, maxWidth:'250px'}).setLngLat(e.lngLat).setHTML(html).addTo(map);
}
['pcn-line','cpn-line','rail-open','rail-closed','racks-pt','parks-fill','closed-marker','risk-glow'].forEach(id=>{
  map.on('mouseenter', id, () => map.getCanvas().style.cursor='pointer');
  map.on('mouseleave', id, () => map.getCanvas().style.cursor='');
});
function showRackPopup(e, f){
  const n=Number(f.properties.n)||0, sh=Number(f.properties.sh)===1, t=String(f.properties.t||'');
  const bits=[ n? `${n} space${n===1?'':'s'}` : 'Bicycle rack', sh?'sheltered':'open-air' ];
  if(t && t!=='Single') bits.push(t.toLowerCase()==='yellow-box' ? 'yellow box' : t.toLowerCase()+'-tier');
  const html=`<b><i class="sw sw-rack">P</i>Bike parking</b><span class="pk">${esc(bits.join(' · '))}</span>`;
  new maplibregl.Popup({className:'pcn-popup', closeButton:true, maxWidth:'240px'}).setLngLat(e.lngLat).setHTML(html).addTo(map);
}
function showParkPopup(e, f){
  const p=f.properties, reserve=p.kind==='reserve';
  const ha=Number(p.ha)||0;
  const size = ha>=100 ? (ha/100).toFixed(1)+' km²' : ha.toFixed(1)+' ha';
  const sub = (reserve?'Nature reserve':'Park') + ' · ' + size;
  const html=`<b><i class="sw" style="background:var(--park)"></i>${esc(p.name)}</b><span class="pk">${esc(sub)}</span>`;
  new maplibregl.Popup({className:'pcn-popup', closeButton:true, maxWidth:'240px'}).setLngLat(e.lngLat).setHTML(html).addTo(map);
}

function addLayers(){
  const dark = isDark();

  // Parks & nature reserves — added first so they sit at the bottom: an area wash under every
  // line. Reserves get the same hue at a heavier opacity (more green = wilder), which keeps the
  // loop line colours the only thing competing on hue.
  if(!map.getSource('parks')) map.addSource('parks',{type:'geojson',data:'data/parks.polys.geojson'});
  const parkCol = getVar('--park') || (dark?'#3FA96B':'#2E8B57');
  const parkVis = parksVisible ? 'visible' : 'none';
  if(!map.getLayer('parks-fill')) map.addLayer({id:'parks-fill',type:'fill',source:'parks',
    layout:{visibility:parkVis},
    paint:{'fill-color':parkCol,'fill-opacity':['match',['get','kind'],'reserve',dark?0.22:0.20, dark?0.14:0.13],'fill-antialias':true}});
  if(!map.getLayer('parks-line')) map.addLayer({id:'parks-line',type:'line',source:'parks',
    layout:{visibility:parkVis,'line-join':'round'},
    paint:{'line-color':parkCol,'line-width':['interpolate',['linear'],['zoom'],11,0.5,15,1.1],'line-opacity':0.42}});

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

  // Rail Corridor: the former KTM railway (heritage trail) — a distinct dashed "sleeper" line, above CPN, below the park connectors
  const railColor = getVar('--rail') || (dark ? '#DDD2C0' : '#4A3226');
  const wRail  = ['interpolate',['linear'],['zoom'], 10,1.6, 13,2.8, 16,5.2];
  const wRailC = ['interpolate',['linear'],['zoom'], 10,3.4, 13,5.0, 16,7.6];
  const railVis = railVisible ? 'visible' : 'none';
  if(!map.getSource('rail')) map.addSource('rail',{type:'geojson',data:'data/rail.lines.geojson'});
  if(!map.getLayer('rail-casing')) map.addLayer({id:'rail-casing',type:'line',source:'rail',
    layout:{'line-join':'round','line-cap':'round','visibility':railVis}, paint:{'line-color':casing,'line-width':wRailC,'line-opacity':0.9}});
  if(!map.getLayer('rail-open')) map.addLayer({id:'rail-open',type:'line',source:'rail',filter:['==',['get','status'],'open'],
    layout:{'line-join':'round','line-cap':'butt','visibility':railVis}, paint:{'line-color':railColor,'line-width':wRail,'line-dasharray':[2.4,1.2]}});
  if(!map.getLayer('rail-closed')) map.addLayer({id:'rail-closed',type:'line',source:'rail',filter:['==',['get','status'],'closed'],
    layout:{'line-join':'round','line-cap':'butt','visibility':railVis}, paint:{'line-color':railColor,'line-width':wRail,'line-dasharray':[1,2.2],'line-opacity':0.55}});

  // Primary network: park connectors
  if(!map.getLayer('pcn-casing')) map.addLayer({id:'pcn-casing',type:'line',source:'pcn',filter:loopFilter(),
    layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':casing,'line-width':wCase,'line-opacity':0.9}});
  if(!map.getLayer('pcn-line')) map.addLayer({id:'pcn-line',type:'line',source:'pcn',filter:loopFilter(),
    layout:{'line-join':'round','line-cap':'round'}, paint:{'line-color':colorExpr,'line-width':wLine}});

  // Cycling closures / diversions. We DON'T reroute or trace the schematic official detour (that
  // was wrong twice). Instead we flag the affected stretch of the existing loop: a red "diversion
  // risk" GLOW under the pink (so the loop stays crisp, haloed red) + a 🚳 marker; tap → the
  // official map. Real PCN geometry, clipped to the affected area (see build/build_closures.js).
  if(!map.getSource('closures')) map.addSource('closures',{type:'geojson',data:'data/closures.geojson'});
  const closedGlow = getVar('--closed') || (dark?'#F87171':'#DC2626');
  const closuresVis = closuresVisible ? 'visible' : 'none';
  // A translucent red highlight over the affected pink stretch (drawn on top → the pink glows red).
  // Deliberately no line-blur / no extreme width: kept to normal line params like every other layer.
  if(!map.getLayer('risk-glow')) map.addLayer({id:'risk-glow',type:'line',source:'closures',filter:['==',['get','kind'],'risk'],
    layout:{'line-join':'round','line-cap':'round','visibility':closuresVis},
    paint:{'line-color':closedGlow,
      'line-width':['interpolate',['linear'],['zoom'],11,5,14,10,17,16],
      'line-opacity':0.45}});

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
  // direction arrowheads along the route, shown in navigation overview (nav stage 2)
  if(!map.hasImage('nav-arrow')){
    const s=20, cv=document.createElement('canvas'); cv.width=cv.height=s; const cx=cv.getContext('2d');
    cx.fillStyle=dark?'#eaf2ef':'#04202e'; cx.beginPath(); cx.moveTo(s*0.30,s*0.16); cx.lineTo(s*0.84,s*0.5); cx.lineTo(s*0.30,s*0.84); cx.closePath(); cx.fill();
    try{ map.addImage('nav-arrow', cx.getImageData(0,0,s,s), {pixelRatio:2}); }catch(_){}
  }
  if(!map.getLayer('route-arrows')) map.addLayer({id:'route-arrows',type:'symbol',source:'route',
    layout:{'symbol-placement':'line','symbol-spacing':64,'icon-image':'nav-arrow','icon-size':0.85,
      'icon-rotation-alignment':'map','icon-allow-overlap':true,'icon-ignore-placement':true,'visibility':'none'}});

  // Weather overlay (NEA 2-hour forecast) — rain ZONES: slate→violet fills over wet areas + weather icons; dry areas stay clean
  wxEnsureIcons();
  if(!map.getSource('wx'))       map.addSource('wx',{type:'geojson',data:emptyFC()});
  if(!map.getSource('wx-icons')) map.addSource('wx-icons',{type:'geojson',data:emptyFC()});
  const wxVisInit = wxVisible ? 'visible' : 'none';
  const wxWet = ['match',['get','sev'],['rain','heavy','storm'],true,false];
  const rainCol = dark
    ? ['match',['get','sev'],'storm','#A85FD0','heavy','#7C82BE','rain','#8B98A8','#8B98A8']
    : ['match',['get','sev'],'storm','#8B3FB0','heavy','#565C86','rain','#6E7C8C','#6E7C8C'];
  // fills sit beneath the network lines so loops/PCN/rail stay dominant; dry cells render at 0 opacity
  const belowLines = map.getLayer('cpn-casing') ? 'cpn-casing' : undefined;
  if(!map.getLayer('wx-zone-fill')) map.addLayer({id:'wx-zone-fill',type:'fill',source:'wx',
    layout:{visibility:wxVisInit},
    paint:{'fill-color':rainCol,'fill-opacity':['match',['get','sev'],'storm',0.40,'heavy',0.34,'rain',0.28, 0],'fill-antialias':true}}, belowLines);
  if(!map.getLayer('wx-zone-line')) map.addLayer({id:'wx-zone-line',type:'line',source:'wx',filter:wxWet,
    layout:{visibility:wxVisInit,'line-join':'round'},
    paint:{'line-color':rainCol,'line-width':1.2,'line-opacity':0.5}}, belowLines);
  if(!map.getLayer('wx-zone-icon')) map.addLayer({id:'wx-zone-icon',type:'symbol',source:'wx-icons',
    layout:{visibility:wxVisInit,
      'icon-image':['match',['get','sev'],'storm','wx-ic-storm','heavy','wx-ic-heavy','wx-ic-rain'],
      'icon-size':['interpolate',['linear'],['zoom'],10,0.5,13,0.9],
      'icon-allow-overlap':true,'icon-ignore-placement':true}});

  // Bike parking (LTA racks) — points on top, and only from z13.5: they're an amenity you look
  // for once you're nearly there, not island-wide furniture.
  rackEnsureIcons();
  if(!map.getSource('racks')) map.addSource('racks',{type:'geojson',data:'data/racks.points.geojson'});
  if(!map.getLayer('racks-pt')) map.addLayer({id:'racks-pt',type:'symbol',source:'racks',
    minzoom:13.5,
    layout:{visibility: racksVisible?'visible':'none',
      'icon-image':['case',['==',['get','sh'],1], rackIconId(true), rackIconId(false)],
      'icon-size':['interpolate',['linear'],['zoom'],13.5,0.42,16,0.62,18,0.72],
      'icon-allow-overlap':false,'icon-padding':1}});

  // Closure marker (🚳) — always visible (no min-zoom) so the diversion is spotted island-wide.
  closureEnsureIcon();
  if(!map.getLayer('closed-marker')) map.addLayer({id:'closed-marker',type:'symbol',source:'closures',filter:['==',['get','kind'],'marker'],
    layout:{visibility: closuresVisible?'visible':'none',
      'icon-image':'closed-ic',
      'icon-size':['interpolate',['linear'],['zoom'],10,0.4,14,0.65,17,0.8],
      'icon-allow-overlap':true,'icon-ignore-placement':true}});

  refreshNearestSource(); refreshTrackSource(); refreshRouteSource(); refreshWxSource();
}
// Soft caution marker — an amber rounded warning triangle with a white "!", drawn to canvas
// (offline-safe). Gentler than a red "no cycling" prohibition; the closure detail is in the popup.
function closureEnsureIcon(){
  if(map.hasImage('closed-ic')) return;
  const dpr=3, size=38;
  const amber='#F59E0B';
  const cv=document.createElement('canvas'); cv.width=cv.height=size*dpr;
  const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
  const cx=size/2, cy=size/2, R=13;
  const tp=[cx, cy-R+2], br=[cx+R-1, cy+R-4], bl=[cx-R+1, cy+R-4];
  ctx.shadowColor='rgba(0,0,0,0.3)'; ctx.shadowBlur=4; ctx.shadowOffsetY=1.5;
  ctx.beginPath(); ctx.moveTo(tp[0],tp[1]); ctx.lineTo(br[0],br[1]); ctx.lineTo(bl[0],bl[1]); ctx.closePath();
  ctx.lineJoin='round'; ctx.lineWidth=4.5; ctx.strokeStyle=amber; ctx.stroke();   // round-join = soft corners
  ctx.fillStyle=amber; ctx.fill();
  ctx.shadowColor='transparent';
  // white exclamation
  ctx.fillStyle='#ffffff';
  ctx.fillRect(cx-1.1, cy-4.5, 2.2, 6.2);
  ctx.beginPath(); ctx.arc(cx, cy+4.4, 1.4, 0, Math.PI*2); ctx.fill();
  try{ map.addImage('closed-ic', ctx.getImageData(0,0,size*dpr,size*dpr), {pixelRatio:dpr}); }catch(e){}
}
// Rack markers are drawn to canvas rather than using map glyphs: no font fetch, so they stay
// crisp and keep working offline. Ids carry the theme because setStyle drops added images.
function rackIconId(sheltered){ return 'rack-'+(sheltered?'sh':'op')+'-'+(isDark()?'d':'l'); }
function rackEnsureIcons(){
  const dpr=3, size=26, r=8.5;
  const fill=getVar('--rack-fill') || (isDark()?'#E2E8F0':'#1F2937');
  const glyph=getVar('--rack-glyph') || (isDark()?'#0E1613':'#FFFFFF');
  for(const sheltered of [true,false]){
    const id=rackIconId(sheltered); if(map.hasImage(id)) continue;
    const cv=document.createElement('canvas'); cv.width=cv.height=size*dpr;
    const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
    const cx=size/2, cy=size/2;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    // sheltered = solid (it has a roof); open-air = hollow ring
    ctx.fillStyle = sheltered ? fill : glyph; ctx.fill();
    ctx.lineWidth=2; ctx.strokeStyle=fill; ctx.stroke();
    ctx.fillStyle = sheltered ? glyph : fill;
    ctx.font='bold 12px "Segoe UI",system-ui,-apple-system,sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('P', cx, cy+0.5);
    try{ map.addImage(id, ctx.getImageData(0,0,size*dpr,size*dpr), {pixelRatio:dpr}); }catch(e){}
  }
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
fetch('data/rail.meta.json').then(r=>r.json()).then(m=>{ RAIL_META=m; appendRailRow(); });
fetch('data/wx.zones.geojson').then(r=>r.json()).then(z=>{ ZONES=z; refreshWxSource(); }).catch(()=>{});
fetch('data/parks.meta.json').then(r=>r.json()).then(m=>{ PARKS_META=m; appendParksRow(); }).catch(()=>{});
// Offline POI index for route search-by-name: named parks & reserves with a rough centroid.
function polyCentroid(geom){
  const rings = geom.type==='Polygon' ? geom.coordinates : geom.type==='MultiPolygon' ? geom.coordinates.flat() : [];
  let sx=0, sy=0, n=0; for(const ring of rings) for(const c of ring){ sx+=c[0]; sy+=c[1]; n++; }
  return n ? [sx/n, sy/n] : null;
}
fetch('data/parks.polys.geojson').then(r=>r.json()).then(g=>{
  POI = g.features.map(f=>{ const c=f.properties&&f.properties.name ? polyCentroid(f.geometry) : null; return c ? {name:f.properties.name, lng:c[0], lat:c[1]} : null; }).filter(Boolean);
}).catch(()=>{});
// Offline SG postcode index (OSM addr:postcode, ODbL) — lazy: fetched + runtime-cached on first
// route-planner open, decoded from the 7-byte packed format built by build/download_postcodes.py.
let POSTCODES=null, pcLoading=null;
function loadPostcodes(){
  if(pcLoading) return pcLoading;
  pcLoading=fetch('data/postcodes.bin').then(r=>r.arrayBuffer()).then(buf=>{
    const b=new Uint8Array(buf), m=new Map(), S=1.15, N=1.47, W=103.58, E=104.10;
    for(let i=0;i+7<=b.length;i+=7)
      m.set(String((b[i]<<16)|(b[i+1]<<8)|b[i+2]).padStart(6,'0'),
        [W+((b[i+5]<<8)|b[i+6])/65535*(E-W), S+((b[i+3]<<8)|b[i+4])/65535*(N-S)]);
    POSTCODES=m;
  }).catch(()=>{ POSTCODES=new Map(); });
  return pcLoading;
}
fetch('data/racks.meta.json').then(r=>r.json()).then(m=>{ RACKS_META=m; appendRacksRow(); }).catch(()=>{});
fetch('data/racks.points.geojson').then(r=>r.json()).then(g=>{ RACK_FEATURES=g.features; computeNearestRack(); updateRackUI(); }).catch(()=>{});
fetch('data/closures.meta.json').then(r=>r.json()).then(m=>{ CLOSURES_META=m; appendClosuresRow(); }).catch(()=>{});

function tryFit(){
  if(fitted || !mapLoaded || !META) return;
  fitted=true;
  map.fitBounds(META.bounds, {padding:{top:80,bottom:180,left:40,right:40}, duration:0});
}

// ---------- geolocation & nearest ----------
function setLocActive(b){ locActive=b; $('locBtn').classList.toggle('active', b); updateUserArrow(); }
function onPos(e){
  const c=e.coords;
  const hd = (c.heading!=null && !isNaN(c.heading)) ? c.heading : null; // GPS course-over-ground
  user={lat:c.latitude, lng:c.longitude, acc:c.accuracy, speed:c.speed, heading:hd};
  updateUserArrow();
  computeNearest(); updateNearUI(); refreshNearestSource();
  computeNearestRack(); updateRackUI();
  loadWeather(); updateWxUI();   // forecast for the area you're now in (throttled fetch)
  if(recording) pushTrack(user, e.timestamp);
  if(headingMode){ camTarget.center=[user.lng,user.lat]; const b=currentHeading(); if(b!=null) camTarget.bearing=b; }
  if(navActive) liveGuidance();
}
// Heading arrowhead on the blue user dot — rotationAlignment:'map' keeps it on the true bearing.
let userArrowEl=null, userArrow=null;
function ensureUserArrow(){
  if(userArrow) return;
  userArrowEl=document.createElement('div');
  userArrowEl.className='user-arrow'; userArrowEl.style.display='none';
  userArrowEl.setAttribute('aria-hidden','true');
  userArrowEl.innerHTML='<svg viewBox="0 0 36 36" width="36" height="36" fill="none"><path class="ua-cone" d="M18 3.5 L26.8 19 A11 11 0 0 1 9.2 19 Z"/><path class="ua-head" d="M18 3.5 L23.2 13.6 L18 11.3 L12.8 13.6 Z"/></svg>';
  userArrow=new maplibregl.Marker({element:userArrowEl, rotationAlignment:'map', pitchAlignment:'map', anchor:'center'}).setLngLat([103.8198,1.3521]).addTo(map);
}
function updateUserArrow(){
  ensureUserArrow();
  const h=(user && locActive)?currentHeading():null;
  if(h==null){ userArrowEl.style.display='none'; return; }
  userArrowEl.style.display=''; userArrow.setLngLat([user.lng,user.lat]).setRotation(h);
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
// Where can I actually leave the bike? The natural sibling of "nearest park connector".
function computeNearestRack(){
  if(!user || !RACK_FEATURES.length || !racksVisible){ nearRack=null; return; }
  const mLat=110540, mLng=111320*Math.cos(user.lat*D2R);
  let best=Infinity, bf=null;
  for(const f of RACK_FEATURES){
    const c=f.geometry.coordinates;
    const dx=(c[0]-user.lng)*mLng, dy=(c[1]-user.lat)*mLat;
    const d=dx*dx+dy*dy;
    if(d<best){ best=d; bf=f; }
  }
  nearRack = bf ? {dist:Math.sqrt(best), n:Number(bf.properties.n)||0, sh:Number(bf.properties.sh)===1,
                   lng:bf.geometry.coordinates[0], lat:bf.geometry.coordinates[1]} : null;
}
function updateRackUI(){
  const row=$('rackRow'); if(!row) return;
  // only worth surfacing when it's actually reachable — beyond ~2 km it's noise
  if(!nearRack || nearRack.dist>2000){ row.hidden=true; return; }
  row.hidden=false;
  const d=nearRack.dist;
  $('rackMain').textContent = (d<1000 ? Math.round(d)+' m' : (d/1000).toFixed(2)+' km') + ' away';
  const bits=[ nearRack.n? `${nearRack.n} spaces` : 'Bicycle rack', nearRack.sh?'sheltered':'open-air' ];
  $('rackSub').textContent = bits.join(' · ');
}
$('rackRow') && $('rackRow').addEventListener('click', ()=>{
  if(!nearRack) return;
  map.easeTo({center:[nearRack.lng,nearRack.lat], zoom:Math.max(map.getZoom(),16), duration:600});
});
function refreshNearestSource(){
  const src = map.getSource && map.getSource('nearest'); if(!src) return;
  if(!user || !nearest){ src.setData(emptyFC()); return; }
  const col = nearest.loop>=0 ? LOOP_COLORS[nearest.loop] : OTHER;
  src.setData({type:'FeatureCollection', features:[
    {type:'Feature', geometry:{type:'LineString', coordinates:[[user.lng,user.lat],[nearest.lng,nearest.lat]]}, properties:{}},
    {type:'Feature', geometry:{type:'Point', coordinates:[nearest.lng,nearest.lat]}, properties:{color:col}}
  ]});
}

// ---------- weather (NEA 2-hour forecast · data.gov.sg, CORS-open, no key) ----------
const WX_URL='https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast';
const WX_TTL=10*60*1000;   // refetch at most every 10 min
const WX_ADVICE={
  storm:'Thundery showers forecast — lightning risk, best not to cycle.',
  heavy:'Heavy rain forecast — poor visibility, consider waiting it out.',
  rain:'Showers likely in the next 2 hours — pack a poncho.',
  haze:'Hazy — check the PSI before a long ride.'
};
function wxInfo(f){
  const s=String(f||'');
  if(/thundery/i.test(s))               return {emoji:'⛈️', sev:'storm'};
  if(/heavy\s+(rain|shower)/i.test(s))  return {emoji:'🌧️', sev:'heavy'};
  if(/(rain|shower)/i.test(s))          return {emoji:'🌦️', sev:'rain'};
  if(/(fog|mist)/i.test(s))             return {emoji:'🌫️', sev:'mist'};
  if(/haz/i.test(s))                    return {emoji:'🌫️', sev:'haze'};
  if(/windy/i.test(s))                  return {emoji:'🌬️', sev:'wind'};
  if(/partly\s+cloudy/i.test(s))        return {emoji:'⛅', sev:'cloud'};
  if(/cloudy/i.test(s))                 return {emoji:'☁️', sev:'cloud'};
  if(/night/i.test(s))                  return {emoji:'🌙', sev:'clear'};
  return {emoji:'☀️', sev:'clear'};     // Fair / Fair and Warm / Fair (Day)
}
// last snapshot for instant/offline display
try{ const s=JSON.parse(localStorage.getItem('wx')||'null'); if(s && s.areas && s.areas.length) WX=s; }catch(e){}
function wxIsStale(){ return !WX || !navigator.onLine || (Date.now()-(WX.at||0))>35*60*1000; }
function wxEndLabel(){ if(WX && WX.validText){ const p=WX.validText.split(/\s+to\s+/i); if(p[1]) return p[1].trim(); } return ''; }
function loadWeather(force){
  if(!force && WX && (Date.now()-(WX.at||0))<WX_TTL) return Promise.resolve(WX);
  if(wxLoading) return wxLoading;
  wxLoading = fetch(WX_URL,{headers:{Accept:'application/json'}})
    .then(r=>{ if(!r.ok) throw new Error('http'); return r.json(); })
    .then(j=>{
      if(!j || j.code!==0 || !j.data) throw new Error('bad');
      const meta={}; (j.data.area_metadata||[]).forEach(a=>{ const L=a.label_location||{}; if(L.latitude!=null) meta[a.name]={lat:L.latitude,lng:L.longitude}; });
      const it=(j.data.items||[])[0]||{};
      const areas=(it.forecasts||[]).map(f=>{ const m=meta[f.area]||{}; return {area:f.area, forecast:f.forecast, lat:m.lat, lng:m.lng}; }).filter(a=>a.lat!=null);
      if(areas.length){ WX={areas, validText:(it.valid_period||{}).text||'', at:Date.now()}; try{ localStorage.setItem('wx', JSON.stringify(WX)); }catch(e){} }
      wxLoading=null; onWeather(); return WX;
    })
    .catch(()=>{ wxLoading=null; onWeather(); return WX; });  // keep last snapshot on failure
  return wxLoading;
}
function nearestForecast(lat,lng){
  if(!WX||!WX.areas.length) return null;
  const mLat=110540, mLng=111320*Math.cos(lat*D2R); let best=Infinity,b=null;
  for(const a of WX.areas){ const dx=(a.lng-lng)*mLng, dy=(a.lat-lat)*mLat, d=dx*dx+dy*dy; if(d<best){best=d;b=a;} }
  return b;
}
function wxModal(){   // islandwide summary — safety-forward: most severe condition that covers >=25% of areas, else the most common
  if(!WX||!WX.areas.length) return null;
  const c={}; for(const a of WX.areas) c[a.forecast]=(c[a.forecast]||0)+1;
  const n=WX.areas.length, rank=f=>({storm:4,heavy:3,rain:2,haze:1}[wxInfo(f).sev]||0);
  let cand=null;
  for(const k in c){ if(c[k]>=n*0.25 && (!cand || rank(k)>rank(cand) || (rank(k)===rank(cand)&&c[k]>c[cand]))) cand=k; }
  if(cand) return cand;
  let k=null,m=-1; for(const x in c){ if(c[x]>m){m=c[x];k=x;} } return k;
}
function onWeather(){ updateWxUI(); refreshWxSource(); updateRouteWx(); if(wxVisible) wxCapUpdate(); }
function updateWxUI(){
  const row=$('wxRow'), adv=$('wxAdv');
  if(!WX||!WX.areas.length){ row.hidden=true; adv.hidden=true; updatePeek(); return; }
  const cond = user ? nearestForecast(user.lat,user.lng).forecast : wxModal();
  const place = user ? nearestForecast(user.lat,user.lng).area : 'Islandwide';
  const info=wxInfo(cond), end=wxEndLabel();
  $('wxIc').textContent=info.emoji; $('wxMain').textContent=cond;
  $('wxSub').textContent = place + (end?(' · until '+end):'') + (wxIsStale()?' · offline':'');
  row.dataset.sev=info.sev; row.hidden=false;
  const msg=WX_ADVICE[info.sev];
  if(msg){ adv.textContent=msg; adv.dataset.sev=info.sev; adv.hidden=false; }
  else if(info.sev==='clear'||info.sev==='cloud'||info.sev==='wind'){ adv.textContent='Clear right now — good to ride.'; adv.dataset.sev='safe'; adv.hidden=false; }
  else adv.hidden=true;
  updatePeek();
}
function routeWeather(coords){   // scan the whole path, not just the destination
  if(!WX||!WX.areas.length||!coords||coords.length<2) return null;
  const rank=s=>({storm:4,heavy:3,rain:2,haze:1}[s]||0);
  const STEP=700; let acc=0; const samples=[coords[0]];
  for(let i=1;i<coords.length;i++){
    acc += haversine(coords[i-1][1],coords[i-1][0],coords[i][1],coords[i][0]);
    if(acc>=STEP){ samples.push(coords[i]); acc=0; }
  }
  const last=coords[coords.length-1];
  if(samples[samples.length-1]!==last) samples.push(last);
  let worst=null, wr=-1, wet=0, anyDry=false;
  for(const p of samples){
    const a=nearestForecast(p[1],p[0]); if(!a) continue;
    const info=wxInfo(a.forecast), r=rank(info.sev);
    if(r>=2) wet++; else anyDry=true;
    if(r>wr){ wr=r; worst={area:a.area, forecast:a.forecast, sev:info.sev, emoji:info.emoji}; }
  }
  return {worst, wet, anyDry, pervasive:(wet/samples.length)>0.6, n:samples.length};
}
function updateRouteWx(){
  const el=$('rtWx'); if(!el) return;
  const coords = routeResult && routeResult.coords;
  if(views.viewRoute.hidden || !coords || !WX || !WX.areas.length){ el.hidden=true; return; }
  const rw=routeWeather(coords); if(!rw||!rw.worst){ el.hidden=true; return; }
  const w=rw.worst;
  let txt, sev=w.sev, emoji=w.emoji;
  if(w.sev==='storm'||w.sev==='heavy'||w.sev==='rain'){
    txt = (rw.pervasive ? (w.forecast+' along your route') : (w.forecast+' near '+w.area));
    if(!rw.pervasive && rw.anyDry) txt += ' · drier elsewhere';
    txt += ' · next 2h';
  } else {
    txt = 'Clear along your route — good to go'; sev='safe'; emoji='☀️';
  }
  el.innerHTML=`<span class="wx-ic">${emoji}</span><span>${esc(txt)}</span>`;
  el.dataset.sev=sev; el.hidden=false;
}
const WX_ICONS=[['rain','🌦️'],['heavy','🌧️'],['storm','⛈️']];
function wxEnsureIcons(){   // render weather emoji to canvas → map images (no asset files, offline-safe)
  const dpr=2, size=46;
  for(const [sev,emoji] of WX_ICONS){
    const id='wx-ic-'+sev; if(map.hasImage(id)) continue;
    const cv=document.createElement('canvas'); cv.width=cv.height=size*dpr;
    const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
    ctx.font='30px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(emoji, size/2, size/2+1);
    try{ map.addImage(id, ctx.getImageData(0,0,size*dpr,size*dpr), {pixelRatio:dpr}); }catch(e){}
  }
}
function refreshWxSource(){
  const src=map.getSource&&map.getSource('wx'); const isrc=map.getSource&&map.getSource('wx-icons');
  if(!src) return;
  if(!ZONES||!ZONES.features||!WX||!WX.areas.length){ src.setData(emptyFC()); if(isrc) isrc.setData(emptyFC()); return; }
  const byArea={}; for(const a of WX.areas) byArea[a.area]=a.forecast;
  const zones=[], icons=[];
  for(const z of ZONES.features){
    const fc=byArea[z.properties.area]||'';
    const i=wxInfo(fc), wet=(i.sev==='rain'||i.sev==='heavy'||i.sev==='storm');
    zones.push({type:'Feature', properties:{area:z.properties.area, forecast:fc, sev:i.sev, emoji:i.emoji}, geometry:z.geometry});
    if(wet) icons.push({type:'Feature', properties:{sev:i.sev}, geometry:{type:'Point', coordinates:[z.properties.cx, z.properties.cy]}});
  }
  src.setData({type:'FeatureCollection', features:zones});
  if(isrc) isrc.setData({type:'FeatureCollection', features:icons});
}
function showWxPopup(e){
  let area, forecast, i;
  const zh = map.getLayer('wx-zone-fill') ? map.queryRenderedFeatures(e.point,{layers:['wx-zone-fill']})[0] : null;
  if(zh){ area=zh.properties.area; forecast=zh.properties.forecast; i=wxInfo(forecast); }
  else { const n=nearestForecast(e.lngLat.lat, e.lngLat.lng); if(!n) return; area=n.area; forecast=n.forecast; i=wxInfo(forecast); }
  const end=wxEndLabel(), wet=(i.sev==='rain'||i.sev==='heavy'||i.sev==='storm');
  const html = wet
    ? `<b>${i.emoji} ${esc(area)}</b><span class="pk">${esc(forecast)}${end?(' · until '+end):' · next 2h'}</span>`
    : `<b>☀️ ${esc(area)}</b><span class="pk">Clear · good to ride${end?(' · until '+end):''}</span>`;
  new maplibregl.Popup({className:'pcn-popup', closeButton:true, maxWidth:'240px'}).setLngLat(e.lngLat).setHTML(html).addTo(map);
}
function wxCapUpdate(){ const t=$('wxCapTime'); if(t) t.textContent = wxEndLabel() ? ('until '+wxEndLabel()) : ''; }
function setWxVis(){
  const v = wxVisible ? 'visible' : 'none';
  ['wx-zone-fill','wx-zone-line','wx-zone-icon'].forEach(id=>{ if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',v); });
  const cap=$('wxCaption'); if(cap) cap.hidden = !wxVisible;
  const btn=$('wxBtn'); if(btn){ btn.classList.toggle('active', wxVisible); btn.setAttribute('aria-pressed', String(wxVisible)); }
  if(wxVisible) wxCapUpdate();
}
function setWxOverlay(on){ wxVisible=on; setWxVis(); if(on) loadWeather(); }
$('wxBtn').addEventListener('click', ()=>{
  setWxOverlay(!wxVisible);
  if(!wxVisible){ toast('Rain zones off'); return; }
  if(!WX){ toast('Rain zones on — loading forecast…'); return; }
  const wet = WX.areas.some(a=>['rain','heavy','storm'].includes(wxInfo(a.forecast).sev));
  toast(wet ? 'Rain zones on — coloured areas have showers; clear elsewhere' : 'Rain zones on — no showers on the island right now');
});
$('wxRefresh').addEventListener('click', ()=>{
  const b=$('wxRefresh'); b.classList.add('spin');
  loadWeather(true).finally(()=>setTimeout(()=>b.classList.remove('spin'),600));
});
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && navigator.onLine && (!WX||(Date.now()-(WX.at||0))>WX_TTL)) loadWeather(); });

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
  refreshTrackSource(); updateRecUI(); persistRec();
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
  recording=true; track=[]; recDist=0; lastPt=null; recStart=performance.now(); recStartEpoch=Date.now();
  const update=$('updatePill'); if(update && !update.hidden){ update.classList.remove('show'); update.hidden=true; }
  $('recBtn').classList.add('active'); $('recBtn').setAttribute('aria-label','Stop recording');
  show('viewRec'); setDock(false);
  recTimer=setInterval(()=>{ track.length ? updateRecUI() : ($('recTime').textContent=fmtTime((performance.now()-recStart)/1000)); }, 1000);
}
function stopRec(){
  recording=false; clearInterval(recTimer); try{ localStorage.removeItem('rec'); }catch(e){}
  $('recBtn').classList.remove('active'); $('recBtn').setAttribute('aria-label','Record a ride');
  const el=(performance.now()-recStart)/1000;
  $('sumDist').textContent=(recDist/1000).toFixed(2);
  $('sumTime').textContent=fmtTime(el);
  $('sumAvg').textContent = el>3 ? ((recDist/el)*3.6).toFixed(1) : '0.0';
  if(track.length>1){ show('viewSum'); ping('ride-saved'); } else { show('viewNearest'); toast('Ride too short to save'); }
  if(renderPendingUpdate) renderPendingUpdate();
}
function buildGPX(){
  const pts=track.map(p=>`<trkpt lat="${p[1].toFixed(6)}" lon="${p[0].toFixed(6)}"></trkpt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Cycling Buddy SG" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>PCN ride ${new Date().toISOString().slice(0,10)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}
// Crash-safe recording: persist the live track so a reload / mobile tab-eviction never loses a ride.
function persistRec(){ if(!recording) return; try{ localStorage.setItem('rec', JSON.stringify({v:1, track, recDist, recStartEpoch})); }catch(e){} }
function resumeRec(){
  let s; try{ s=JSON.parse(localStorage.getItem('rec')||'null'); }catch(e){ s=null; }
  if(!s || !Array.isArray(s.track) || s.track.length<2 || (Date.now()-(s.recStartEpoch||0))>864e5){ try{ localStorage.removeItem('rec'); }catch(e){} return; }
  recording=true; track=s.track; recDist=s.recDist||0; recStartEpoch=s.recStartEpoch||Date.now();
  recStart=performance.now()-Math.max(0, Date.now()-recStartEpoch);   // keep elapsed continuous across the reload
  const last=track[track.length-1]; lastPt={lng:last[0], lat:last[1]};
  $('recBtn').classList.add('active'); $('recBtn').setAttribute('aria-label','Stop recording');
  show('viewRec'); setDock(false); refreshTrackSource(); updateRecUI();
  recTimer=setInterval(()=>{ track.length ? updateRecUI() : ($('recTime').textContent=fmtTime((performance.now()-recStart)/1000)); persistRec(); }, 1000);
  if(!locActive) geo.trigger();
  toast('Recovered your ride after a reload');
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
  appendRailRow();
  appendCpnRow();
  appendParksRow();
  appendRacksRow();
  appendClosuresRow();
}
function appendParksRow(){
  if(!PARKS_META) return;
  const body=$('lgBody'); if(!body.children.length) return;   // loops not built yet — called again from buildLegend
  if(body.querySelector('.lrow-parks')) return;
  ensureExtrasSep();
  const sp=$('sheetParks'); if(sp) sp.textContent=PARKS_META.count;
  const sa=$('sheetParkKm2'); if(sa) sa.textContent=PARKS_META.total_km2.toFixed(1);
  const row=document.createElement('div'); row.className='lrow lrow-parks';
  row.innerHTML =
    `<button class="sw" aria-pressed="true" aria-label="Toggle parks and nature reserves"><i style="background:var(--park)"></i></button>`+
    `<button class="meta" aria-label="Frame parks"><span class="name">Parks &amp; reserves</span><span class="km">${PARKS_META.total_km2.toFixed(1)} km²</span></button>`+
    `<button class="zoom" aria-label="Frame parks"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
  row.querySelector('.sw').addEventListener('click', ()=>toggleParks(row));
  const frame=()=>map.fitBounds(PARKS_META.bounds,{padding:{top:80,bottom:180,left:40,right:40}});
  row.querySelector('.meta').addEventListener('click', frame);
  row.querySelector('.zoom').addEventListener('click', frame);
  insertExtra(row, 'parks');
}
function toggleParks(row){
  parksVisible=!parksVisible;
  row.classList.toggle('off', !parksVisible);
  row.querySelector('.sw').setAttribute('aria-pressed', String(parksVisible));
  setParksVis();
}
function setParksVis(){
  const v = parksVisible ? 'visible' : 'none';
  ['parks-fill','parks-line'].forEach(id=>{ if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',v); });
}
function appendRacksRow(){
  if(!RACKS_META) return;
  const body=$('lgBody'); if(!body.children.length) return;
  if(body.querySelector('.lrow-racks')) return;
  ensureExtrasSep();
  const sr=$('sheetRacks'); if(sr) sr.textContent=RACKS_META.count;
  const ss=$('sheetSpaces'); if(ss) ss.textContent=RACKS_META.spaces.toLocaleString();
  const row=document.createElement('div'); row.className='lrow lrow-racks';
  row.innerHTML =
    `<button class="sw" aria-pressed="true" aria-label="Toggle bike parking"><i class="sw-rack">P</i></button>`+
    `<button class="meta" aria-label="Frame bike parking"><span class="name">Bike parking</span><span class="km">${RACKS_META.spaces.toLocaleString()} spaces</span></button>`+
    `<button class="zoom" aria-label="Frame bike parking"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
  row.querySelector('.sw').addEventListener('click', ()=>toggleRacks(row));
  const frame=()=>map.fitBounds(RACKS_META.bounds,{padding:{top:80,bottom:180,left:40,right:40}});
  row.querySelector('.meta').addEventListener('click', frame);
  row.querySelector('.zoom').addEventListener('click', frame);
  insertExtra(row, 'racks');
}
function toggleRacks(row){
  racksVisible=!racksVisible;
  row.classList.toggle('off', !racksVisible);
  row.querySelector('.sw').setAttribute('aria-pressed', String(racksVisible));
  if(map.getLayer('racks-pt')) map.setLayoutProperty('racks-pt','visibility', racksVisible?'visible':'none');
  computeNearestRack(); updateRackUI();
}
function appendClosuresRow(){
  if(!CLOSURES_META) return;
  const body=$('lgBody'); if(!body.children.length) return;
  if(body.querySelector('.lrow-closures')) return;
  ensureExtrasSep();
  const sc=$('sheetClosure'); if(sc) sc.textContent = (CLOSURES_META.active&&CLOSURES_META.active[0]) ? CLOSURES_META.active[0].name : '';
  const row=document.createElement('div'); row.className='lrow lrow-closures';
  row.innerHTML =
    `<button class="sw" aria-pressed="true" aria-label="Toggle cycling diversions"><i style="background:var(--closed)"></i></button>`+
    `<button class="meta" aria-label="Frame cycling diversions"><span class="name">Diversions</span><span class="km">Bay South</span></button>`+
    `<button class="zoom" aria-label="Frame cycling diversions"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
  row.querySelector('.sw').addEventListener('click', ()=>toggleClosures(row));
  const m=CLOSURES_META.marker;
  const frame=()=>{ if(m) map.easeTo({center:m, zoom:15.2, duration:650}); };
  row.querySelector('.meta').addEventListener('click', frame);
  row.querySelector('.zoom').addEventListener('click', frame);
  insertExtra(row, 'closures');
}
function toggleClosures(row){
  closuresVisible=!closuresVisible;
  row.classList.toggle('off', !closuresVisible);
  row.querySelector('.sw').setAttribute('aria-pressed', String(closuresVisible));
  const v = closuresVisible ? 'visible' : 'none';
  ['closed-marker','risk-glow'].forEach(id=>{ if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',v); });
}
function ensureExtrasSep(){
  const body=$('lgBody'); if(!body || !body.children.length) return;
  if(!body.querySelector('.lg-sep-x')){ const s=document.createElement('div'); s.className='lg-sep lg-sep-x'; body.appendChild(s); }
}
// Each extra layer arrives on its own fetch, so order by rank rather than arrival:
// Rail Corridor · cycling paths · parks · bike parking · diversions.
const EXTRA_RANK = {rail:1, cpn:2, parks:3, racks:4, closures:5};
function insertExtra(row, key){
  const body=$('lgBody'); const rank=EXTRA_RANK[key];
  row.dataset.rank=rank;
  const after=[...body.querySelectorAll('.lrow[data-rank]')].find(r=>Number(r.dataset.rank)>rank);
  if(after) body.insertBefore(row, after); else body.appendChild(row);
}
function appendRailRow(){
  if(!RAIL_META) return;
  const body=$('lgBody'); if(!body.children.length) return;   // loops not built yet — called again from buildLegend
  if(body.querySelector('.lrow-rail')) return;                // already added
  ensureExtrasSep();
  const sk=$('sheetRailKm'); if(sk) sk.textContent=RAIL_META.total_km.toFixed(1);
  const row=document.createElement('div'); row.className='lrow lrow-rail';
  // just the distance — the 6.7 km closure is carried by the dashed style, the tap popup and the
  // About sheet, and a second fact here wraps the 188px phone panel onto two lines
  row.innerHTML =
    `<button class="sw" aria-pressed="true" aria-label="Toggle Rail Corridor"><i style="background:var(--rail)"></i></button>`+
    `<button class="meta" aria-label="Frame Rail Corridor"><span class="name">Rail Corridor</span><span class="km">${RAIL_META.total_km.toFixed(1)} km</span></button>`+
    `<button class="zoom" aria-label="Frame Rail Corridor"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
  row.querySelector('.sw').addEventListener('click', ()=>toggleRail(row));
  const frame=()=>map.fitBounds(RAIL_META.bounds,{padding:{top:80,bottom:180,left:40,right:40}});
  row.querySelector('.meta').addEventListener('click', frame);
  row.querySelector('.zoom').addEventListener('click', frame);
  insertExtra(row, 'rail');
}
function toggleRail(row){
  railVisible=!railVisible;
  row.classList.toggle('off', !railVisible);
  row.querySelector('.sw').setAttribute('aria-pressed', String(railVisible));
  setRailVis();
}
function setRailVis(){
  const v = railVisible ? 'visible' : 'none';
  ['rail-casing','rail-open','rail-closed'].forEach(id=>{ if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',v); });
}
function appendCpnRow(){
  if(!CPN_META) return;
  const body=$('lgBody'); if(!body.children.length) return;   // loops not built yet — will be called again from buildLegend
  if(body.querySelector('.lrow-cpn')) return;                 // already added
  const sk=$('sheetCpnKm'); if(sk) sk.textContent=CPN_META.total_km.toFixed(1);
  ensureExtrasSep();
  const row=document.createElement('div'); row.className='lrow lrow-cpn';
  row.innerHTML =
    `<button class="sw" aria-pressed="true" aria-label="Toggle cycling paths"><i style="background:var(--cpn)"></i></button>`+
    `<button class="meta" aria-label="Frame cycling paths"><span class="name">Cycling paths</span><span class="km">${CPN_META.total_km.toFixed(1)} km</span></button>`+
    `<button class="zoom" aria-label="Frame cycling paths"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/></svg></button>`;
  row.querySelector('.sw').addEventListener('click', ()=>toggleCpn(row));
  const frame=()=>map.fitBounds(CPN_META.bounds,{padding:{top:80,bottom:180,left:40,right:40}});
  row.querySelector('.meta').addEventListener('click', frame);
  row.querySelector('.zoom').addEventListener('click', frame);
  insertExtra(row, 'cpn');
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
  // no total in the legend header: the panel lists paths/parks/parking too, so a PCN-only
  // figure there would read as the total. The dock stat below carries it, labelled.
  $('stKm').textContent = META.total_km.toFixed(0)+' km';
  $('stSeg').textContent = META.seg_count.toLocaleString();
  $('sheetKm').textContent = META.total_km.toFixed(1);
}

// ---------- views / dock ----------
const views={viewNearest:$('viewNearest'),viewRec:$('viewRec'),viewSum:$('viewSum'),viewRoute:$('viewRoute')};
function show(v){ for(const k in views) views[k].hidden = (k!==v); updatePeek(); setDockH(); }
function setDockH(){ document.documentElement.style.setProperty('--dockh', ($('dock').offsetHeight+14)+'px'); }
function setDock(collapsed){ $('dock').classList.toggle('collapsed', collapsed); $('dockHandle').setAttribute('aria-expanded', String(!collapsed)); updatePeek(); setDockH(); }
function wxPeekIcon(){
  if(!WX || !WX.areas.length) return '';
  const cond = user ? nearestForecast(user.lat,user.lng).forecast : wxModal();
  const i = wxInfo(cond);
  return ['storm','heavy','rain'].includes(i.sev) ? (i.emoji+' ') : '';
}
function updatePeek(){
  let t='Nearby';
  if(!views.viewNearest.hidden) t = wxPeekIcon() + (nearest ? ('Nearest connector · '+$('nearDist').textContent) : 'Tap ◎ to find the nearest connector');
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
  // diff:false forces a full style reload. OpenFreeMap's light/dark styles share one layer
  // structure, so a diffed setStyle succeeds silently — which strips our overlays without ever
  // firing style.load to re-add them.
  map.setStyle(t==='dark'?DARK_STYLE:LIGHT_STYLE, {diff:false}); // style.load re-adds our layers
});

// ---------- FABs ----------
$('locBtn').addEventListener('click', ()=>{ geo.trigger(); requestOrientation().then(ok=>{ if(ok) startOrientation(); }); });  // compass on locate → the heading arrow shows even when standing still
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
    ping('gpx-export');
  }catch(err){ toast('Couldn’t export on this device'); }
});

// ---------- compass / heading-follow ("face direction") ----------
function normBearing(b){ b=((b%360)+360)%360; return b>180 ? b-360 : b; }
function screenAngle(){
  const a = (screen.orientation && typeof screen.orientation.angle==='number') ? screen.orientation.angle : (window.orientation||0);
  return a || 0;
}
// tilt-compensated compass heading from absolute device orientation (Android)
function compassFromOrientation(alpha,beta,gamma){
  const _x=(beta||0)*D2R, _y=(gamma||0)*D2R, _z=(alpha||0)*D2R;
  const cX=Math.cos(_x),cY=Math.cos(_y),cZ=Math.cos(_z);
  const sX=Math.sin(_x),sY=Math.sin(_y),sZ=Math.sin(_z);
  const Vx=-cZ*sY - sZ*sX*cY, Vy=-sZ*sY + cZ*sX*cY;
  let h=Math.atan2(Vx,Vy); if(h<0) h+=2*Math.PI;
  return h/D2R;
}
function onOrient(e){
  let h=null;
  if(typeof e.webkitCompassHeading==='number' && !isNaN(e.webkitCompassHeading)){
    h=e.webkitCompassHeading;                                   // iOS: already compass, CW from north
  } else if((e.type==='deviceorientationabsolute' || e.absolute===true) && typeof e.alpha==='number'){
    h=(compassFromOrientation(e.alpha,e.beta,e.gamma) + screenAngle()) % 360; // Android absolute
  }
  if(h==null || isNaN(h)) return;
  deviceHeading=(h+360)%360; deviceHeadingTs=performance.now();
  if(headingMode) camTarget.bearing=deviceHeading;
  updateUserArrow();
}
function requestOrientation(){
  try{
    const D=window.DeviceOrientationEvent;
    if(D && typeof D.requestPermission==='function') return D.requestPermission().then(r=>r==='granted').catch(()=>false);
  }catch(e){}
  return Promise.resolve(true);
}
function startOrientation(){ window.addEventListener('deviceorientationabsolute',onOrient,true); window.addEventListener('deviceorientation',onOrient,true); }
function stopOrientation(){ window.removeEventListener('deviceorientationabsolute',onOrient,true); window.removeEventListener('deviceorientation',onOrient,true); deviceHeading=null; updateUserArrow(); }
function currentHeading(){
  const now=performance.now();
  if(deviceHeading!=null && (now-deviceHeadingTs)<2500) return deviceHeading;       // live compass
  if(user && user.heading!=null && user.speed!=null && user.speed>0.6) return user.heading; // GPS course when moving
  return null;
}
function updateCompassIcon(){ const n=$('compassNeedle'); if(n) n.style.transform='rotate('+(-map.getBearing())+'deg)'; }
function setNavArrows(show){ if(map.getLayer && map.getLayer('route-arrows')) map.setLayoutProperty('route-arrows','visibility',(show && routeResult)?'visible':'none'); }
function camLoop(){
  if(!headingMode){ camRAF=null; return; }
  const c=map.getCenter(), curB=map.getBearing(), curZ=map.getZoom();
  let nb=curB, nc=[c.lng,c.lat], nz=curZ;
  if(camTarget.bearing!=null){ let d=camTarget.bearing-curB; while(d>180)d-=360; while(d<-180)d+=360; nb=curB+d*0.16; }
  if(camTarget.center){ nc=[c.lng+(camTarget.center[0]-c.lng)*0.22, c.lat+(camTarget.center[1]-c.lat)*0.22]; }
  if(camTarget.zoom!=null){ nz=curZ+(camTarget.zoom-curZ)*0.16; if(Math.abs(camTarget.zoom-nz)<0.01){ nz=camTarget.zoom; camTarget.zoom=null; } } // hand zoom back to the user once we've zoomed in
  map.jumpTo({center:nc, bearing:nb, zoom:nz});
  updateCompassIcon();
  camRAF=requestAnimationFrame(camLoop);
}
function enterHeading(){
  headingMode=true; navStage=1;
  const btn=$('headingBtn'); btn.classList.add('active'); btn.setAttribute('aria-pressed','true');
  map.touchZoomRotate.disableRotation();               // two-finger = zoom only while following; avoids fighting the compass
  if(!locActive) geo.trigger();                          // ensure GPS + the user dot/heading beam
  requestOrientation().then(ok=>{ if(ok) startOrientation(); else toast('Motion access off — following GPS heading'); });
  const b=currentHeading();
  camTarget.center = user ? [user.lng,user.lat] : map.getCenter().toArray();
  camTarget.bearing = (b!=null ? b : map.getBearing());
  camTarget.zoom = Math.max(map.getZoom(), 16.4);
  if(!camRAF) camRAF=requestAnimationFrame(camLoop);
  toast(user ? 'Compass on — the map turns to the way you face' : 'Compass on — finding your location…');
}
function exitHeading(reset){
  if(!headingMode) return;
  headingMode=false;
  const btn=$('headingBtn'); btn.classList.remove('active'); btn.setAttribute('aria-pressed','false');
  stopOrientation();
  map.touchZoomRotate.enableRotation();
  if(camRAF){ cancelAnimationFrame(camRAF); camRAF=null; }
  camTarget.center=camTarget.bearing=camTarget.zoom=null;
  if(reset!==false) map.easeTo({bearing:0, pitch:0, duration:500});
  navStage=0; setNavArrows(false);
  updateCompassIcon();
}
$('headingBtn').addEventListener('click', ()=>{
  if(navStage===1){ navStage=2; camTarget.zoom=14.2; setNavArrows(true); toast('Overview — arrows show the way ahead'); return; } // 2nd tap: zoom out + route arrows
  if(navStage===2){ exitHeading(true); return; }                                                                // 3rd tap: off (resets navStage)
  if(Math.abs(normBearing(map.getBearing()))>2){ map.easeTo({bearing:0, pitch:0, duration:500}); return; }      // straighten a hand-rotated map first
  enterHeading();                                                                                               // 1st tap: face direction + zoom in
});
map.on('rotate', updateCompassIcon);
map.on('dragstart',   e=>{ if(headingMode && e.originalEvent) exitHeading(false); }); // a manual pan drops out of follow
map.on('rotatestart', e=>{ if(headingMode && e.originalEvent) exitHeading(false); });

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
  exitHeading(false);
  routeMode=true; $('routeBtn').classList.add('active'); map.getCanvas().style.cursor='crosshair';
  show('viewRoute'); setDock(false); ensureGraph(); loadPostcodes(); loadWeather(); updateGpsStatus();
  if(routeOptions){ renderRoutes(routeOptions); selectRoute(routeSel,false); }
  else { if(!routeStart && user){ setPoint('start',[user.lng,user.lat]); setFromLabel('Current location'); } resetRoutePanel(); }
}
function exitRoute(){
  routeMode=false; $('routeBtn').classList.remove('active'); map.getCanvas().style.cursor=''; closeMenu();
  // "Off" means a clean map: leaving the planner clears the plan and its markers — unless you're
  // actively navigating, when the route stays so you can keep riding it.
  if(!navActive){ clearRoutePoints(); routeResult=null; routeOptions=null; refreshRouteSource(); }
  show('viewNearest');
}
function rtHint(t){ const el=$('rtHint'); el.textContent=t||''; el.hidden=!t; setDockH(); }
function setFromLabel(t){ const el=$('rtFromVal'); if(el) el.textContent=t; }
function updateGpsStatus(){ const el=$('rtGps'); if(el) el.hidden=!(user && locActive); }
function updateMapHint(){
  const h=$('rtMapHint'); if(!h) return;
  if(!routeMode || routeResult){ h.hidden=true; return; }
  h.textContent = !routeStart ? '◎ Tap the map to set your start, or use Current location'
                              : '◎ Search above, or tap the map to drop your destination';
  h.hidden=false;
}
function hideOptions(){ for(const id of ['rtOptions','rtDirs','rtNotice','rtWx','rtActionBar','rtMenu']){ const e=$(id); if(e)e.hidden=true; } $('rtMoreBtn').setAttribute('aria-expanded','false'); setDockH(); }
function resetRoutePanel(){ hideOptions(); routeOptions=null; routeEndName=null; renderChips(); updateMapHint(); rtHint(''); updateRtControls(); }
function setPoint(which,ll){
  const color = which==='start' ? '#22B573' : (getVar('--rec')||'#e02749');
  const m=new maplibregl.Marker({color, draggable:true}).setLngLat(ll).addTo(map);
  m.getElement().setAttribute('role','img');
  m.getElement().setAttribute('aria-label', which==='start' ? 'Route start marker — drag to move' : 'Route destination marker — drag to move');
  m.on('dragend', ()=>{ const p=m.getLngLat(); onEndpointDragged(which,[p.lng,p.lat]); });
  if(which==='start'){ if(mkStart)mkStart.remove(); mkStart=m; routeStart=ll; }
  else { if(mkEnd)mkEnd.remove(); mkEnd=m; routeEnd=ll; }
}
function onEndpointDragged(which,ll){
  if(which==='start'){ routeStart=ll; setFromLabel('Dropped pin'); } else { routeEnd=ll; routeEndName='Dropped pin'; }
  updateRtControls();
  if(routeStart && routeEnd) computeRoute();   // both ends set → recompute in place
}
function clearRoutePoints(){ if(mkStart){mkStart.remove();mkStart=null;} if(mkEnd){mkEnd.remove();mkEnd=null;} routeStart=null; routeEnd=null; }
function handleRouteClick(ll){
  if(!routeStart){ setPoint('start',ll); setFromLabel('Dropped pin'); updateMapHint(); updateRtControls(); }
  else if(!routeEnd){ routeEndName='Dropped pin'; setPoint('end',ll); computeRoute(); }
}
function computeRoute(){
  if(!routeStart||!routeEnd) return;
  ensureGraph().then(ok=>{
    if(!ok) return;
    const list=Router.routeThree(routeStart,routeEnd);
    if(!list){
      routeOptions=null; routeResult=null;
      const sN=Router.nearestNode(routeStart), eN=Router.nearestNode(routeEnd);
      const tooFar = !sN || !eN || sN.dist>Router.MAX_SNAP || eN.dist>Router.MAX_SNAP;
      toast(tooFar ? 'No cycling path near there — tap closer to a route' : 'No route found between those points');
      hideOptions(); refreshRouteSource(); updateRtControls(); return;
    }
    routeOptions=list; renderRoutes(list); selectRoute('best', true); setDock(false); ping('route-planned');
    if(routeEndName) addRecent({name:routeEndName, lng:routeEnd[0], lat:routeEnd[1]});
    if(routeResult && routeResult.hasCarWay) toast('Heads up: this route uses roads — wear a helmet (required on Singapore roads).');
  });
}
function fmtMin(m){ m=Math.max(1,Math.round(m)); return m<60 ? m+' min' : Math.floor(m/60)+'h '+(m%60)+'m'; }
function fmtDist(m){ return m<1000 ? Math.round(m)+' m' : (m/1000).toFixed(1)+' km'; }
function segBar(r){ const t=Math.max(1,r.meters); return {ded:100*r.cyclingMeters/t, low:100*(r.footMeters+r.quietRoadMeters)/t, oth:100*r.busyRoadMeters/t}; }
function barHTML(r){ const s=segBar(r); return `<div class="rt-bar"><span style="width:${s.ded}%;background:var(--seg-ded)"></span><span style="width:${s.low}%;background:var(--seg-low)"></span><span style="width:${s.oth}%;background:var(--seg-oth)"></span></div>`; }
function optByKey(k){ return (routeOptions||[]).find(o=>o.key===k); }
function exposureHTML(r){
  if(r.roadMeters<20) return '';
  const txt = r.busyRoadMeters>=20 ? fmtDist(r.busyRoadMeters)+' on through-roads' : fmtDist(r.roadMeters)+' on quiet roads';
  return `<div class="rt-expo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>${txt}</div>`;
}
function altCardHTML(a){
  const r=a.route;
  return `<button class="rt-alt" data-k="${a.key}"><div class="rt-alt-top"><span class="rt-alt-label">${esc(a.label)}</span><span class="rt-alt-figs">${fmtDist(r.meters)} · ${fmtMin(r.meters/(16*1000/60))}</span></div>${barHTML(r)}<div class="rt-alt-note">${Math.round(r.cyclingPct*100)}% dedicated paths</div></button>`;
}
function renderRoutes(list){
  $('rtHint').hidden=true; $('rtMapHint').hidden=true; $('rtChips').hidden=true;
  const box=$('rtOptions'); box.hidden=false;
  const best=list[0], r=best.route, s=segBar(r), alts=list.slice(1);
  let html=`<div class="rt-rec" data-k="${best.key}">`+
    `<div class="rt-rec-eyebrow"><svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 8.9 8 11 4.6-2.1 8-6 8-11V5l-8-3z"/></svg>Recommended · ${esc(best.label)}</div>`+
    `<div class="rt-metrics"><span class="big">${fmtDist(r.meters)}</span><span class="t">· ${fmtMin(r.meters/(16*1000/60))} ride</span><span class="pct">${Math.round(r.cyclingPct*100)}% paths</span></div>`+
    barHTML(r)+
    `<div class="rt-legend"><span><i style="background:var(--seg-ded)"></i>${Math.round(s.ded)}% paths</span><span><i style="background:var(--seg-low)"></i>${Math.round(s.low)}% quiet</span><span><i style="background:var(--seg-oth)"></i>${Math.round(s.oth)}% roads</span></div>`+
    exposureHTML(r)+`</div>`;
  if(alts.length){
    html+=`<button class="rt-alt-toggle" aria-expanded="${altsOpen}" aria-controls="rtAltList"><span>View ${alts.length} alternative${alts.length>1?'s':''} — ${alts.map(a=>esc(a.label)).join(' · ')}</span><svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>`+
      `<div id="rtAltList" class="rt-alt-list"${altsOpen?'':' hidden'}>${alts.map(altCardHTML).join('')}</div>`;
  }
  box.innerHTML=html;
  box.querySelector('.rt-rec').addEventListener('click',()=>selectRoute(best.key,false));
  const tgl=box.querySelector('.rt-alt-toggle');
  if(tgl) tgl.addEventListener('click',()=>{ altsOpen=!altsOpen; const l=box.querySelector('.rt-alt-list'); if(l) l.hidden=!altsOpen; tgl.setAttribute('aria-expanded',String(altsOpen)); setDockH(); });
  box.querySelectorAll('.rt-alt').forEach(el=>el.addEventListener('click',()=>selectRoute(el.dataset.k,false)));
}
function selectRoute(k, fit){
  const o=optByKey(k)||(routeOptions&&routeOptions[0]); if(!o) return;
  routeSel=o.key; routeResult=o.route;
  const box=$('rtOptions'), rec=box.querySelector('.rt-rec');
  if(rec) rec.classList.toggle('sel', rec.dataset.k===o.key);
  box.querySelectorAll('.rt-alt').forEach(el=>el.classList.toggle('sel', el.dataset.k===o.key));
  refreshRouteSource(); renderDirs(routeResult.directions);
  $('rtNotice').hidden = !routeResult.hasCarWay;
  updateRouteWx(); updateRtControls(); updatePeek();
  if(fit){ const b=new maplibregl.LngLatBounds(); routeResult.coords.forEach(c=>b.extend(c)); map.fitBounds(b,{padding:{top:110,bottom:300,left:50,right:50}}); }
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
function updateRtControls(){
  $('rtActionBar').hidden = !routeResult;
  $('rtClrBtn').hidden = !(routeStart||routeEnd);
  $('rtSwapBtn').hidden = !(routeStart&&routeEnd);
  if(!routeResult) closeMenu();
  setDockH();   // control set changed → keep FABs/peek synced
}
function closeMenu(){ const m=$('rtMenu'); if(m) m.hidden=true; const b=$('rtMoreBtn'); if(b) b.setAttribute('aria-expanded','false'); }
// Recent + Saved destinations — on-device only (localStorage), no accounts, no sync.
function lsGet(k){ try{ return JSON.parse(localStorage.getItem(k)||'[]'); }catch(_){ return []; } }
function lsSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){} }
function addRecent(p){ if(!p||!p.name) return; const r=lsGet('cbsg.recent').filter(x=>x.name!==p.name); r.unshift({name:p.name,lng:p.lng,lat:p.lat}); lsSet('cbsg.recent', r.slice(0,6)); }
function savePlace(p){ if(!p||!p.name) return; const s=lsGet('cbsg.saved').filter(x=>x.name!==p.name); s.unshift({name:p.name,lng:p.lng,lat:p.lat}); lsSet('cbsg.saved', s.slice(0,12)); }
function renderChips(){
  const box=$('rtChips'); if(!box) return;
  const saved=lsGet('cbsg.saved'), recent=lsGet('cbsg.recent');
  const items=[...saved.map(p=>Object.assign({kind:'saved'},p)), ...recent.filter(r=>!saved.some(s=>s.name===r.name)).map(p=>Object.assign({kind:'recent'},p))].slice(0,6);
  if(!items.length || routeEnd){ box.hidden=true; box.innerHTML=''; return; }
  box._items=items;
  box.innerHTML=items.map((p,i)=>`<button class="rt-chip" data-i="${i}"><span class="ic" aria-hidden="true">${p.kind==='saved'?'★':'↻'}</span><span class="t">${esc(p.name)}</span></button>`).join('');
  box.hidden=false;
}
function pickDestination(p){
  const box=$('rtResults'); box.hidden=true; box.innerHTML=''; $('rtSearch').value=''; routeEndName=p.name;
  if(!routeStart && user){ setPoint('start',[user.lng,user.lat]); setFromLabel('Current location'); }
  setPoint('end',[p.lng,p.lat]);
  if(routeStart) computeRoute();
  else { renderChips(); rtHint('Now set your start — Current location, or tap the map.'); updateMapHint(); updateRtControls(); }
}
// ---------- live turn-by-turn navigation ----------
let navActive=false, offRouteCount=0;
function bearingDeg(a,b){ const y=Math.sin((b[0]-a[0])*D2R)*Math.cos(b[1]*D2R); const x=Math.cos(a[1]*D2R)*Math.sin(b[1]*D2R)-Math.sin(a[1]*D2R)*Math.cos(b[1]*D2R)*Math.cos((b[0]-a[0])*D2R); return (Math.atan2(y,x)/D2R+360)%360; }
function projectOnRoute(ll, coords){
  const kx=Math.cos(ll[1]*D2R)*111320, ky=110540, px=ll[0]*kx, py=ll[1]*ky;
  let best={dist:Infinity,i:0,t:0};
  for(let i=0;i<coords.length-1;i++){
    const ax=coords[i][0]*kx, ay=coords[i][1]*ky, bx=coords[i+1][0]*kx, by=coords[i+1][1]*ky;
    const dx=bx-ax, dy=by-ay, L2=dx*dx+dy*dy;
    const t=L2?Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/L2)):0;
    const d=Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
    if(d<best.dist) best={dist:d,i,t};
  }
  return best;
}
function nextTurn(coords, proj){
  let cur=bearingDeg(coords[proj.i], coords[proj.i+1]);
  let acc=(1-proj.t)*haversine(coords[proj.i][1],coords[proj.i][0],coords[proj.i+1][1],coords[proj.i+1][0]);
  for(let j=proj.i+1;j<coords.length-1;j++){
    const b2=bearingDeg(coords[j],coords[j+1]); let turn=b2-cur; while(turn>180)turn-=360; while(turn<-180)turn+=360;
    if(Math.abs(turn)>=32) return {dist:acc, text:(Math.abs(turn)>=115?(turn<0?'Sharp left':'Sharp right'):(turn<0?'Turn left':'Turn right'))};
    acc+=haversine(coords[j][1],coords[j][0],coords[j+1][1],coords[j+1][0]); cur=b2;
  }
  return null;
}
function setNavBanner(main, sub){ const el=$('navBanner'); if(!el) return; el.hidden=false; el.querySelector('.nav-main').textContent=main; el.querySelector('.nav-sub').textContent=sub||''; }
function liveGuidance(){
  if(!navActive || !routeResult || !user) return;
  const coords=routeResult.coords; if(!coords || coords.length<2) return;
  const proj=projectOnRoute([user.lng,user.lat], coords);
  if(proj.dist>45){ if(++offRouteCount>=3){ offRouteCount=0; navReroute(); } else setNavBanner('Off route','head back to the highlighted line'); return; }
  offRouteCount=0;
  const end=coords[coords.length-1], dEnd=haversine(user.lat,user.lng,end[1],end[0]);
  if(dEnd<30){ setNavBanner('You’ve arrived 🎉',''); navActive=false; const b=$('rtGoBtn'); if(b) b.textContent='Go'; return; }
  const nt=nextTurn(coords, proj);
  if(nt && nt.dist<dEnd+50) setNavBanner(nt.text,'in '+Math.round(nt.dist)+' m');
  else setNavBanner('Continue',Math.round(dEnd)+' m to go');
}
function navReroute(){
  if(!routeEnd || !user) return;
  toast('Off route — rerouting');
  ensureGraph().then(ok=>{ if(!ok) return;
    const list=Router.routeThree([user.lng,user.lat], routeEnd); if(!list) return;
    routeStart=[user.lng,user.lat]; routeOptions=list;
    const o=list.find(x=>x.key===routeSel)||list[0]; routeSel=o.key; routeResult=o.route;
    refreshRouteSource(); renderDirs(routeResult.directions); updateRtControls(); setNavArrows(navStage===2);
  });
}
const GO_HTML=$('rtGoBtn').innerHTML;
function startNav(){ if(!routeResult) return; navActive=true; offRouteCount=0; if(!locActive) geo.trigger(); closeMenu(); $('rtGoBtn').textContent='End ride'; setNavBanner('Starting…',''); toast('Navigation on'); if(user) liveGuidance(); }
function stopNav(){ navActive=false; const b=$('rtGoBtn'); if(b) b.innerHTML=GO_HTML; const el=$('navBanner'); if(el) el.hidden=true; }
$('rtGoBtn').addEventListener('click', ()=> navActive?stopNav():startNav());
$('rtSearch').addEventListener('input', ()=>{
  const raw=$('rtSearch').value.trim(), box=$('rtResults'), pc=raw.replace(/\s+/g,'');
  if(/^\d{6}$/.test(pc)){                       // a Singapore postcode
    const c=POSTCODES&&POSTCODES.get(pc);
    if(c){ box._hits=[{name:'Postcode '+pc, lng:c[0], lat:c[1]}]; box.innerHTML=`<button class="rt-result" data-i="0">Postcode ${pc}</button>`; }
    else { box._hits=[]; box.innerHTML=`<div class="rt-noresult">${POSTCODES?('No location for postcode '+pc+' — try a park name or tap the map'):'Loading postcodes…'}</div>`; }
    box.hidden=false;
    if(!POSTCODES) loadPostcodes().then(()=>{ if($('rtSearch').value.trim().replace(/\s+/g,'')===pc) $('rtSearch').dispatchEvent(new Event('input')); });
    return;
  }
  const q=raw.toLowerCase();
  if(q.length<2){ box.hidden=true; box.innerHTML=''; return; }
  const hits=POI.filter(p=>p.name.toLowerCase().includes(q)).slice(0,6);
  box._hits=hits;
  box.innerHTML = hits.length ? hits.map((p,i)=>`<button class="rt-result" data-i="${i}">${esc(p.name)}</button>`).join('')
                              : `<div class="rt-noresult">No park matches “${esc(raw)}”</div>`;
  box.hidden=false;
});
$('rtResults').addEventListener('click', e=>{
  const b=e.target.closest('.rt-result'); if(!b) return;
  const p=($('rtResults')._hits||[])[+b.dataset.i]; if(p) pickDestination(p);
});
$('rtChips').addEventListener('click', e=>{
  const b=e.target.closest('.rt-chip'); if(!b) return;
  const p=($('rtChips')._items||[])[+b.dataset.i]; if(p) pickDestination(p);
});
$('routeBtn').addEventListener('click', ()=> routeMode?exitRoute():enterRoute());
$('routeClose').addEventListener('click', exitRoute);
$('rtLocBtn').addEventListener('click', ()=>{
  if(!user){ geo.trigger(); toast('Getting your location…'); return; }
  setPoint('start',[user.lng,user.lat]); setFromLabel('Current location'); updateGpsStatus(); updateMapHint();
  if(routeEnd) computeRoute(); else { renderChips(); updateRtControls(); }
});
$('rtSwapBtn').addEventListener('click', ()=>{
  if(!routeStart||!routeEnd) return;
  const a=routeStart, b=routeEnd; clearRoutePoints(); setPoint('start',b); setPoint('end',a);
  setFromLabel(routeEndName||'Dropped pin'); routeEndName='Start point'; computeRoute();
});
$('rtMoreBtn').addEventListener('click', ()=>{ const m=$('rtMenu'); const open=m.hidden; m.hidden=!open; $('rtMoreBtn').setAttribute('aria-expanded', String(open)); if(open) setDockH(); });
$('rtSaveBtn').addEventListener('click', ()=>{
  if(!routeEnd) return;
  savePlace({name: routeEndName && routeEndName!=='Dropped pin' ? routeEndName : 'Pin '+routeEnd[1].toFixed(3)+', '+routeEnd[0].toFixed(3), lng:routeEnd[0], lat:routeEnd[1]});
  closeMenu(); toast('Destination saved');
});
$('rtClrBtn').addEventListener('click', ()=>{ stopNav(); clearRoutePoints(); setFromLabel(user?'Current location':'Set start'); routeResult=null; routeOptions=null; routeEndName=null; refreshRouteSource(); hideOptions(); renderChips(); updateMapHint(); rtHint(''); updateRtControls(); });
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
const modalFocusable='button:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])';
let modalOpener=null;
function openModal(el){
  modalOpener=document.activeElement;
  scrim.classList.add('open'); el.classList.add('open'); el.inert=false; el.setAttribute('aria-hidden','false');
  requestAnimationFrame(()=>{ const first=el.querySelector(modalFocusable); if(first) first.focus(); });
}
function closeModal(){
  const open=document.querySelector('.sheet.open');
  scrim.classList.remove('open');
  document.querySelectorAll('.sheet.open').forEach(s=>{ s.classList.remove('open'); s.inert=true; s.setAttribute('aria-hidden','true'); });
  if(open && modalOpener && document.contains(modalOpener)) modalOpener.focus();
  modalOpener=null;
}
$('infoBtn').addEventListener('click', ()=>openModal($('sheet')));
$('closeSheet').addEventListener('click', closeModal);
$('closeInstall').addEventListener('click', closeModal);
scrim.addEventListener('click', closeModal);
document.addEventListener('keydown', e=>{
  const open=document.querySelector('.sheet.open');
  if(e.key==='Escape' && open){ e.preventDefault(); closeModal(); return; }
  if(e.key!=='Tab' || !open) return;
  const focusable=[...open.querySelectorAll(modalFocusable)].filter(el=>!el.hidden && !el.inert);
  if(!focusable.length){ e.preventDefault(); return; }
  const first=focusable[0], last=focusable[focusable.length-1];
  if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
});

// ---------- toast ----------
let toastT=null; const toastEl=$('toast');
function toast(msg){ toastEl.textContent=msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>toastEl.classList.remove('show'),3200); }

// ---------- analytics (GoatCounter events; no-ops offline or if blocked) ----------
function ping(name){ try{ if(window.goatcounter && goatcounter.count) goatcounter.count({path:name, title:name, event:true}); }catch(e){} }
// Shareable branded card: the route/ride shape + stats on a self-contained PNG (no basemap tiles,
// so no attribution concern in the shared image). GPX stays for power users; this is for social.
function drawRideCard(coords, meta){
  const S=1080, pad=96, cv=document.createElement('canvas'); cv.width=cv.height=S; const g=cv.getContext('2d');
  const dark=document.documentElement.getAttribute('data-theme')==='dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  const bg=dark?'#0e1613':'#f4f7f5', ink=dark?'#eaf2ef':'#0e1613', dim=dark?'#9fb3ab':'#5b6b64', accent=getVar('--accent')||'#12b886';
  g.fillStyle=bg; g.fillRect(0,0,S,S); g.fillStyle=accent; g.fillRect(0,0,S,12);
  g.textAlign='left'; g.fillStyle=ink; g.font='700 48px system-ui,-apple-system,sans-serif'; g.fillText('Cycling Buddy SG', pad, 108);
  g.fillStyle=dim; g.font='500 28px system-ui,sans-serif'; g.fillText(meta.subtitle||'Singapore', pad, 150);
  const boxY=196, boxH=548, boxW=S-2*pad;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const c of coords){ if(c[0]<minX)minX=c[0]; if(c[0]>maxX)maxX=c[0]; if(c[1]<minY)minY=c[1]; if(c[1]>maxY)maxY=c[1]; }
  const kx=Math.cos((minY+maxY)/2*Math.PI/180);
  const wX=Math.max(1e-6,(maxX-minX)*kx), wY=Math.max(1e-6,maxY-minY), scale=Math.min(boxW/wX, boxH/wY)*0.88;
  const offX=pad+(boxW-wX*scale)/2, offY=boxY+(boxH-wY*scale)/2;
  const X=c=>offX+(c[0]-minX)*kx*scale, Y=c=>offY+(maxY-c[1])*scale;
  g.strokeStyle=accent; g.lineWidth=11; g.lineJoin='round'; g.lineCap='round';
  g.beginPath(); coords.forEach((c,i)=> i?g.lineTo(X(c),Y(c)):g.moveTo(X(c),Y(c))); g.stroke();
  const dot=(c,col)=>{ g.beginPath(); g.arc(X(c),Y(c),13,0,7); g.fillStyle=col; g.fill(); g.lineWidth=4; g.strokeStyle=bg; g.stroke(); };
  dot(coords[0],'#22B573'); dot(coords[coords.length-1], getVar('--rec')||'#e02749');
  g.fillStyle=ink; g.font='800 96px system-ui,sans-serif'; g.fillText(meta.big, pad, 872);
  g.fillStyle=dim; g.font='500 32px system-ui,sans-serif'; g.fillText(meta.line, pad, 924);
  g.fillStyle=dim; g.font='500 26px system-ui,sans-serif'; g.fillText('jiaenlin.github.io/cycling-buddy-sg', pad, S-64);
  return cv;
}
function shareImage(coords, meta, filename){
  if(!coords || coords.length<2){ toast('Nothing to share yet'); return; }
  ping('share-image');
  drawRideCard(coords, meta).toBlob(async blob=>{
    if(!blob){ toast('Could not make the image'); return; }
    const file=new File([blob], filename, {type:'image/png'});
    if(navigator.canShare && navigator.canShare({files:[file]})){
      try{ await navigator.share({files:[file], title:'Cycling Buddy SG', text:meta.share||'Cycling Buddy SG'}); return; }catch(e){ if(e && e.name==='AbortError') return; }
    }
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1500);
    toast('Image saved');
  }, 'image/png');
}
$('imgBtn').addEventListener('click', ()=> shareImage(track, {
  subtitle:'Ride · '+new Date().toLocaleDateString(), big:(recDist/1000).toFixed(2)+' km',
  line:$('sumTime').textContent+' · '+$('sumAvg').textContent+' km/h avg', share:'My ride on Cycling Buddy SG 🚴'
}, 'cycling-buddy-ride.png'));
$('rtImgBtn').addEventListener('click', ()=> routeResult && shareImage(routeResult.coords, {
  subtitle:'Planned route · Singapore', big:(routeResult.meters/1000).toFixed(1)+' km',
  line:Math.round(100*routeResult.cyclingPct)+'% cycling · '+Math.round(100*routeResult.pcnMeters/Math.max(1,routeResult.meters))+'% park connector',
  share:'My planned ride on Cycling Buddy SG 🚴'
}, 'cycling-buddy-route.png'));

// ---------- share ----------
const SHARE_URL = 'https://jiaenlin.github.io/cycling-buddy-sg/';
$('shareBtn').addEventListener('click', async ()=>{
  ping('share');
  const data = {title:'Cycling Buddy SG', text:'Free offline cycling map for Singapore’s Park Connectors — routes, rain radar, ride recording.', url:SHARE_URL};
  if(navigator.share){ try{ await navigator.share(data); return; }catch(e){ if(e && e.name==='AbortError') return; } }
  try{ await navigator.clipboard.writeText(SHARE_URL); toast('Link copied — paste it anywhere'); }
  catch(e){ toast(SHARE_URL); }
});

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
window.addEventListener('appinstalled', ()=>{ $('installBtn').hidden=true; closeModal(); toast('Installed — find “Cycling Buddy” on your home screen'); ping('install'); });

// ---------- service worker + update prompt ----------
// A new version precaches in the background then waits; we surface a tappable pill so the rider
// updates when they choose (never mid-route), then reload once the new worker takes control.
if('serviceWorker' in navigator){
  let userChoseUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(userChoseUpdate) location.reload();   // reload only on an opted-in update, not the first install
  });
  const showUpdatePill = worker => {
    pendingUpdateWorker = worker;
    const pill = $('updatePill'); if(!pill || recording || (pill._wired===worker && !pill.hidden)) return;
    pill._wired = worker;                     // guard: reg.waiting and updatefound can both fire
    pill.hidden = false; requestAnimationFrame(()=>pill.classList.add('show'));
    pill.onclick = ()=>{ userChoseUpdate = true; pendingUpdateWorker=null; pill.classList.remove('show'); worker.postMessage('SKIP_WAITING'); };
  };
  renderPendingUpdate = ()=>{ if(pendingUpdateWorker && !recording) showUpdatePill(pendingUpdateWorker); };
  window.addEventListener('load', async ()=>{
    let reg; try{ reg = await navigator.serviceWorker.register('sw.js'); }catch(e){ return; }
    if(reg.waiting && navigator.serviceWorker.controller) showUpdatePill(reg.waiting);   // update already downloaded
    reg.addEventListener('updatefound', ()=>{
      const nw = reg.installing; if(!nw) return;
      nw.addEventListener('statechange', ()=>{
        if(nw.state==='installed' && navigator.serviceWorker.controller) showUpdatePill(nw);   // controller present => update, not first install
      });
    });
    // re-check when the app returns to the foreground, so a re-opened PWA finds updates promptly
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) reg.update().catch(()=>{}); });
  });
}

// ---------- init ----------
syncThemeIcon();
updateCompassIcon();
updateWxUI();            // show last snapshot instantly (if any)
loadWeather();          // then refresh in the background when online
$('dockHandle').addEventListener('click', ()=> setDock(!$('dock').classList.contains('collapsed')));
if(matchMedia('(max-width:560px)').matches){ legend.classList.add('collapsed'); lgHead.setAttribute('aria-expanded','false'); }
updatePeek();
setDockH();
window.addEventListener('resize', setDockH);
