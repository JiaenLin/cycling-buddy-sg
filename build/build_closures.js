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
 * over that stretch + a marker; tap -> notice + official map. Geometry follows the exact real PCN
 * centreline between the two user-confirmed waterfront boundaries, so nothing is invented.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'data');
const round = n => Number(n.toFixed(5));

const MAP_URL = 'https://www.gardensbythebay.com.sg/content/dam/gbb-2021/image/about-us/media-room/2026/wetlands-by-the-bay/Diversion-map.pdf';
// The affected stretch = the shoreline promenade facing Marina Reservoir, bounded by the two black
// guide marks in the user's annotated map. It starts partway through the "Gardens by the Bay"
// feature and continues onto the adjoining "Marina Barrage" feature, stopping before the MCE-facing
// turn. The cut points are interpolated on the real PCN centreline; the warning marker stays put.
const RISK_LOOP = 3;
const SHORE_PARK = 'Gardens by the Bay';
const EAST_PARK = 'Marina Barrage';
const WEST_CUT = [103.86283, 1.28569];
const EAST_CUT = [103.87133, 1.28062];
const MARKER = [103.86549, 1.28473];

// Source vertices bracketing the user-confirmed cuts. These assertions make a future data refresh
// fail closed instead of silently moving the glow to a different path.
const WEST_INNER = [103.8638, 1.28539];
const WEST_OUTER = [103.86057, 1.28638];
const EAST_INNER = [103.87102, 1.2811];
const EAST_OUTER = [103.87139, 1.28053];

const mLat=110540, mLng=111320*Math.cos(1.284*Math.PI/180);
const sameCoord = (a,b) => a && b && a[0]===b[0] && a[1]===b[1];
const coordIndex = (coords,target) => coords.findIndex(c => sameCoord(c,target));
function pointToSegmentMeters(p,a,b){
  const ax=a[0]*mLng, ay=a[1]*mLat, bx=b[0]*mLng, by=b[1]*mLat;
  const px=p[0]*mLng, py=p[1]*mLat, dx=bx-ax, dy=by-ay;
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)));
  return { t, distance:Math.hypot(px-(ax+t*dx),py-(ay+t*dy)) };
}
function assertCut(label,cut,a,b){
  const hit=pointToSegmentMeters(cut,a,b);
  if(hit.t<=0 || hit.t>=1 || hit.distance>1.5){
    throw new Error(`${label} cut is not inside its expected PCN segment (${hit.distance.toFixed(2)} m away)`);
  }
}

const active = {
  name:'Gardens by the Bay — Bay South',
  title:'Cycling diversion — Bay South',
  note:'No cycling on the waterfront promenade facing Marina Reservoir, for the Bay South–Bay East bridge works. The cycling detour goes around the Bay South perimeter — follow on-site signage.',
  from:'2026-05-04', until:'~2028', src:'gardensbythebay.com.sg', url:MAP_URL
};

const pcn = JSON.parse(fs.readFileSync(path.join(OUT,'pcn.lines.geojson'),'utf8'));
function featureFor(park){
  const matches = pcn.features.filter(f =>
    f.properties.loop === RISK_LOOP &&
    f.properties.park === park &&
    f.geometry && f.geometry.type === 'LineString'
  );
  if(matches.length !== 1) throw new Error(`Expected exactly one ${park} feature on loop ${RISK_LOOP}; found ${matches.length}`);
  return matches[0];
}
const shore = featureFor(SHORE_PARK);
const east = featureFor(EAST_PARK);
const shoreCoords = shore.geometry.coordinates;
const eastCoords = east.geometry.coordinates;
const westInnerIndex = coordIndex(shoreCoords,WEST_INNER);
const eastInnerIndex = coordIndex(eastCoords,EAST_INNER);
if(westInnerIndex<0 || !sameCoord(shoreCoords[westInnerIndex+1],WEST_OUTER)){
  throw new Error('Western cut source segment changed');
}
if(eastInnerIndex<1 || !sameCoord(eastCoords[eastInnerIndex-1],EAST_OUTER)){
  throw new Error('Eastern cut source segment changed');
}
if(!sameCoord(eastCoords[eastCoords.length-1],shoreCoords[0])){
  throw new Error('Gardens by the Bay and Marina Barrage features no longer share an endpoint');
}
assertCut('Western',WEST_CUT,WEST_INNER,WEST_OUTER);
assertCut('Eastern',EAST_CUT,EAST_INNER,EAST_OUTER);

// East cut -> Marina Barrage vertices -> shared join -> Gardens shoreline vertices -> west cut.
const riskCoords = [
  EAST_CUT,
  ...eastCoords.slice(eastInnerIndex),
  ...shoreCoords.slice(1,westInnerIndex+1),
  WEST_CUT
].map(([lng,lat]) => [round(lng),round(lat)]);
if(riskCoords.length<2 || riskCoords.some((c,i)=>i>0 && sameCoord(c,riskCoords[i-1]))){
  throw new Error('Invalid or duplicate closure geometry');
}
const markerHit = Math.min(...riskCoords.slice(1).map((b,i)=>pointToSegmentMeters(MARKER,riskCoords[i],b).distance));
if(markerHit>1.5) throw new Error(`Warning marker moved off the highlighted path (${markerHit.toFixed(2)} m away)`);

const riskFeatures = [
  { type:'Feature', properties:{ kind:'risk' }, geometry:{ type:'LineString', coordinates:riskCoords } }
];
let riskKm = 0;
for(let i=1;i<riskCoords.length;i++){
  const dx=(riskCoords[i][0]-riskCoords[i-1][0])*mLng;
  const dy=(riskCoords[i][1]-riskCoords[i-1][1])*mLat;
  riskKm += Math.hypot(dx,dy)/1000;
}

const fc = { type:'FeatureCollection', features:[
  ...riskFeatures,
  { type:'Feature', properties:{ kind:'marker', title:active.title, note:active.note, src:active.src, url:active.url },
    geometry:{ type:'Point', coordinates:MARKER } }
]};
fs.writeFileSync(path.join(OUT,'closures.geojson'), JSON.stringify(fc));

const meta = { count:1, marker:MARKER, risk_km:Number(riskKm.toFixed(2)), active:[active],
  source:'Gardens by the Bay notice; affected stretch = Southern Ridges Loop (loop 3), clipped between user-confirmed waterfront boundaries on Gardens by the Bay and Marina Barrage PCN features' };
fs.writeFileSync(path.join(OUT,'closures.meta.json'), JSON.stringify(meta, null, 2));
console.log(`closures: ${riskFeatures.length} risk segments (~${riskKm.toFixed(2)} km) + 1 marker, ${(fs.statSync(path.join(OUT,'closures.geojson')).size/1024).toFixed(1)} KB`);
