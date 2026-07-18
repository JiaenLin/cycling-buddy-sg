/* Build the cycling-closures/diversions overlay for Cycling Buddy SG.
 *
 *   node build/build_closures.js
 *
 * Curated, time-limited closures — not a bulk dataset — defined by hand here with a source.
 *
 * Current closure — Gardens by the Bay, Bay South Garden:
 *   Per the official notice, cyclists have NO ACCESS along the waterfront promenade facing Marina
 *   Reservoir (Bay South <-> Bay East bridge works). The new cycling route goes around the
 *   perimeter; pedestrians keep promenade access; on-site signage directs everyone.
 *   Source: https://www.gardensbythebay.com.sg — official diversion map:
 *   https://www.gardensbythebay.com.sg/content/dam/gbb-2021/image/about-us/media-room/2026/wetlands-by-the-bay/Diversion-map.pdf
 *
 * We DON'T reroute or trace the schematic detour (that produced a wrong line twice). Instead we
 * flag the affected stretch of the EXISTING loop: the Southern Ridges Loop (loop 3) where it runs
 * through Gardens by the Bay along the closed waterfront. The app draws a red "diversion risk" glow
 * over that stretch + a marker; tap -> notice + official map. Geometry is the real PCN geometry
 * (clipped to the affected area), so nothing is invented.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'data');
const round = n => Number(n.toFixed(5));

const MAP_URL = 'https://www.gardensbythebay.com.sg/content/dam/gbb-2021/image/about-us/media-room/2026/wetlands-by-the-bay/Diversion-map.pdf';
const MARKER = [103.87314, 1.28262];   // "no cycling" sign on the closed waterfront promenade

// The circled affected area (the Gardens by the Bay stretch of the Southern Ridges loop).
const RISK_LOOP = 3;
const BB = { w:103.8648, s:1.2808, e:103.8745, n:1.2852 };
const inBB = ([x,y]) => x>=BB.w && x<=BB.e && y>=BB.s && y<=BB.n;

// Clip a segment to the bbox: keep runs of inside points, plus one adjacent boundary point each
// side so the glow stays continuous to the edge of the circled area (no visible gaps).
function clip(coords){
  const runs=[]; let run=null;
  for(let i=0;i<coords.length;i++){
    const here=inBB(coords[i]);
    if(here){
      if(!run){ run=[]; if(i>0) run.push(coords[i-1]); }   // reach back to the boundary
      run.push(coords[i]);
    } else if(run){
      run.push(coords[i]);                                  // reach forward to the boundary
      runs.push(run); run=null;
    }
  }
  if(run) runs.push(run);
  return runs.map(r => r.map(p => [round(p[0]), round(p[1])])).filter(r => r.length>=2);
}

const active = {
  name:'Gardens by the Bay — Bay South',
  title:'Cycling diversion — Bay South',
  note:'No cycling on the waterfront promenade facing Marina Reservoir, for the Bay South–Bay East bridge works. The cycling detour goes around the Bay South perimeter — follow on-site signage.',
  from:'2026-05-04', until:'~2028', src:'gardensbythebay.com.sg', url:MAP_URL
};

const pcn = JSON.parse(fs.readFileSync(path.join(OUT,'pcn.lines.geojson'),'utf8'));
const riskFeatures = [];
let riskKm = 0, mLat=110540, mLng=111320*Math.cos(1.283*Math.PI/180);
for(const f of pcn.features){
  if(f.properties.loop !== RISK_LOOP) continue;
  for(const run of clip(f.geometry.coordinates)){
    for(let i=1;i<run.length;i++){ const dx=(run[i][0]-run[i-1][0])*mLng, dy=(run[i][1]-run[i-1][1])*mLat; riskKm += Math.hypot(dx,dy)/1000; }
    riskFeatures.push({ type:'Feature', properties:{ kind:'risk' }, geometry:{ type:'LineString', coordinates:run } });
  }
}

const fc = { type:'FeatureCollection', features:[
  ...riskFeatures,
  { type:'Feature', properties:{ kind:'marker', title:active.title, note:active.note, src:active.src, url:active.url },
    geometry:{ type:'Point', coordinates:MARKER } }
]};
fs.writeFileSync(path.join(OUT,'closures.geojson'), JSON.stringify(fc));

const meta = { count:1, marker:MARKER, risk_km:Number(riskKm.toFixed(2)), active:[active],
  source:'Gardens by the Bay notice; affected stretch = Southern Ridges Loop (loop 3) through Gardens by the Bay, from pcn.lines.geojson' };
fs.writeFileSync(path.join(OUT,'closures.meta.json'), JSON.stringify(meta, null, 2));
console.log(`closures: ${riskFeatures.length} risk segments (~${riskKm.toFixed(2)} km) + 1 marker, ${(fs.statSync(path.join(OUT,'closures.geojson')).size/1024).toFixed(1)} KB`);
