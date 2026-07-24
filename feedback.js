/* Cycling Buddy SG — feedback page. Draw a path / drop a pin / comment, submit to the owned Worker
   (queued offline), get a shareable contribution card, and browse the moderation-approved community
   feed with a per-device thumbs-up (counts stay owner-only). © 2026 Lin Jiaen. */
'use strict';
// Deployed Cloudflare Worker (see worker/README.md). Empty = "service not live yet": submissions
// save on the device and the feed shows a friendly placeholder.
const FEEDBACK_API = 'https://cbsg-feedback.jiaenlin999.workers.dev';
const APP_VERSION = 'cbsg-v48';

const $ = id => document.getElementById(id);
const getVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
function toast(t){ const el=$('fbToast'); el.textContent=t; el.classList.add('on'); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('on'),2600); }
function status(t, err){ const el=$('fbStatus'); el.textContent=t; el.hidden=false; el.classList.toggle('err',!!err); }
function deviceToken(){ let d=localStorage.getItem('cbsg.device'); if(!d){ d=uuid(); localStorage.setItem('cbsg.device',d); } return d; }

// ---------- theme (mirror the main app) ----------
const theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', theme);
const STYLE = theme==='dark' ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/positron';

// ---------- map + drawing ----------
let mode='path', pts=[], pin=null;
const map = new maplibregl.Map({ container:'fbmap', style:STYLE, center:[103.85,1.30], zoom:11, maxZoom:19, attributionControl:false });
map.addControl(new maplibregl.AttributionControl({compact:true}), 'bottom-left');
map.addControl(new maplibregl.GeolocateControl({ positionOptions:{enableHighAccuracy:true}, trackUserLocation:true }), 'top-right');
// Start the OpenFreeMap attribution folded so it doesn't cover the drawing guide; the ⓘ still expands it.
function foldAttribution(){ const el=document.querySelector('#fbmap .maplibregl-ctrl-attrib'); if(el){ el.classList.add('maplibregl-compact'); el.classList.remove('maplibregl-compact-show'); } }
foldAttribution(); map.on('load', foldAttribution); map.once('idle', foldAttribution);
function emptyFC(){ return {type:'FeatureCollection',features:[]}; }
map.on('load', ()=>{
  const cpn = getVar('--cpn') || '#5E7169';
  const refs = [['fbpcn','data/pcn.lines.geojson', getVar('--accent')||'#2F79E8'],
                ['fbcpn','data/cpn.lines.geojson', cpn], ['fbride','data/rideable.lines.geojson', cpn]];
  for(const [id,url,color] of refs){
    map.addSource(id,{type:'geojson',data:url});
    map.addLayer({id:id+'-l',type:'line',source:id,paint:{'line-color':color,'line-width':2,'line-opacity':0.55}});
  }
  map.addSource('draw',{type:'geojson',data:emptyFC()});
  map.addLayer({id:'draw-l',type:'line',source:'draw',filter:['==',['geometry-type'],'LineString'],
    paint:{'line-color':getVar('--accent')||'#2F79E8','line-width':4}});
  map.addLayer({id:'draw-pt',type:'circle',source:'draw',filter:['==',['geometry-type'],'Point'],
    paint:{'circle-radius':5,'circle-color':getVar('--accent')||'#2F79E8','circle-stroke-color':'#fff','circle-stroke-width':2}});
});
function renderDraw(){
  const s=map.getSource('draw'); if(!s) return;
  const feats=[];
  if(mode==='path'){
    if(pts.length>=2) feats.push({type:'Feature',geometry:{type:'LineString',coordinates:pts}});
    for(const p of pts) feats.push({type:'Feature',geometry:{type:'Point',coordinates:p}});
  } else if(mode==='pin' && pin){ feats.push({type:'Feature',geometry:{type:'Point',coordinates:pin}}); }
  s.setData({type:'FeatureCollection',features:feats});
}
map.on('click', e=>{
  const ll=[+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)];
  if(mode==='path') pts.push(ll);
  else if(mode==='pin') pin=ll;
  else return;
  renderDraw();
});
$('fbUndo').addEventListener('click', ()=>{ if(mode==='path') pts.pop(); else pin=null; renderDraw(); });
$('fbClear').addEventListener('click', ()=>{ pts=[]; pin=null; renderDraw(); });

// ---------- modes ----------
document.querySelectorAll('.fb-mode').forEach(btn=>btn.addEventListener('click', ()=>{
  document.querySelectorAll('.fb-mode').forEach(b=>b.classList.toggle('on', b===btn));
  mode=btn.dataset.mode;
  $('fbMapWrap').classList.toggle('comment', mode==='comment');
  $('fbHint').textContent = mode==='path' ? 'Tap the map to drop points — each tap adds a corner and they join into a path. Undo removes the last.' : 'Tap the map to place a single pin.';
  renderDraw();
  if(mode!=='comment') setTimeout(()=>map.resize(), 60);
}));

// ---------- rating ----------
let rating=0;
(function(){ const box=$('fbStars'); for(let i=1;i<=5;i++){ const b=document.createElement('button'); b.type='button'; b.textContent='★'; b.setAttribute('aria-label',i+' star'+(i>1?'s':'')); b.addEventListener('click',()=>{ rating=(rating===i?0:i); paintStars(); }); box.append(b);} })();
function paintStars(){ [...$('fbStars').children].forEach((b,i)=>b.classList.toggle('on', i<rating)); }

// ---------- tabs ----------
let feedLoaded=false;
function showTab(feed){
  $('giveView').hidden=feed; $('feedView').hidden=!feed;
  $('tabGive').classList.toggle('on',!feed); $('tabFeed').classList.toggle('on',feed);
  $('tabGive').setAttribute('aria-selected',String(!feed)); $('tabFeed').setAttribute('aria-selected',String(feed));
  if(feed && !feedLoaded){ feedLoaded=true; loadFeed(); }
}
$('tabGive').addEventListener('click', ()=>showTab(false));
$('tabFeed').addEventListener('click', ()=>showTab(true));

// prefill remembered handle
const savedHandle = localStorage.getItem('cbsg.handle'); if(savedHandle) $('fbName').value=savedHandle;

// ---------- submit + offline queue ----------
$('fbForm').addEventListener('submit', e=>{
  e.preventDefault();
  const note=$('fbNote').value.trim();
  if(!note){ toast('Add a short note first'); return; }
  let geometry=null;
  if(mode==='path'){ if(pts.length<2){ toast('Draw at least two points, or switch to Just comment'); return; } geometry={type:'LineString',coordinates:pts}; }
  else if(mode==='pin'){ if(!pin){ toast('Drop a pin, or switch to Just comment'); return; } geometry={type:'Point',coordinates:pin}; }
  const contributor=$('fbName').value.trim()||null;
  if(contributor) localStorage.setItem('cbsg.handle', contributor); else localStorage.removeItem('cbsg.handle');
  submit({ id:uuid(), kind:mode, geometry, note, rating:rating||null, contributor, appVersion:APP_VERSION, ts:Date.now() });
});
function enqueue(p){ const q=JSON.parse(localStorage.getItem('cbsg.fbqueue')||'[]'); q.push(p); localStorage.setItem('cbsg.fbqueue', JSON.stringify(q.slice(-50))); }
async function submit(p){
  $('fbSubmit').disabled=true;
  if(!FEEDBACK_API){ enqueue(p); showCard(p); status('Saved on your device — it will send once the feedback service is live.'); afterSubmit(); return; }
  try{
    const r=await fetch(FEEDBACK_API+'/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});
    if(!r.ok) throw new Error('bad');
    showCard(p); status('Thanks! Sent for review — it appears in Community once approved.'); afterSubmit();
  }catch(_){ enqueue(p); showCard(p); status('You seem offline — saved on your device, will send automatically later.'); afterSubmit(); }
}
function afterSubmit(){ $('fbSubmit').disabled=false; $('fbNote').value=''; rating=0; paintStars(); pts=[]; pin=null; renderDraw(); }
async function flushQueue(){
  if(!FEEDBACK_API || !navigator.onLine) return;
  let q=JSON.parse(localStorage.getItem('cbsg.fbqueue')||'[]'); if(!q.length) return;
  const keep=[];
  for(const p of q){ try{ const r=await fetch(FEEDBACK_API+'/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}); if(!r.ok) keep.push(p); }catch(_){ keep.push(p); } }
  localStorage.setItem('cbsg.fbqueue', JSON.stringify(keep));
}
window.addEventListener('online', flushQueue); flushQueue();

// ---------- contribution card (canvas → PNG) ----------
function wrapText(x, text, left, top, maxW, lh, maxLines){
  const words=String(text).split(/\s+/); let line='', y=top, n=0;
  for(const w of words){ const t=line?line+' '+w:w; if(x.measureText(t).width>maxW && line){ x.fillText(line,left,y); y+=lh; line=w; if(++n>=maxLines-1){ x.fillText(x.measureText(line+'…').width>maxW?w:line+'…',left,y); return; } } else line=t; }
  if(line) x.fillText(line,left,y);
}
function showCard(p){
  const c=$('fbCardCanvas'), x=c.getContext('2d'), dark=theme==='dark';
  x.fillStyle=dark?'#12211b':'#ffffff'; x.fillRect(0,0,600,315);
  x.fillStyle=getVar('--accent')||'#2F79E8'; x.fillRect(0,0,600,9);
  x.textBaseline='alphabetic';
  x.fillStyle=dark?'#e8efe9':'#16211c'; x.font='800 30px system-ui,-apple-system,sans-serif'; x.fillText('Cycling Buddy SG',28,66);
  x.fillStyle=getVar('--accent-text')||getVar('--accent')||'#2F79E8'; x.font='800 15px system-ui,sans-serif';
  x.fillText((p.kind==='path'?'NEW PATH':p.kind==='pin'?'MAP PIN':'COMMENT')+' · CONTRIBUTION',28,94);
  x.fillStyle=dark?'#c8d3cc':'#42504a'; x.font='17px system-ui,sans-serif';
  wrapText(x, p.note, 28, 132, 544, 24, 4);
  x.fillStyle=dark?'#e8efe9':'#16211c'; x.font='800 19px system-ui,sans-serif';
  x.fillText('— '+(p.contributor||'Anonymous rider'), 28, 268);
  x.fillStyle=dark?'#7d8c84':'#8a978f'; x.font='13px system-ui,sans-serif';
  x.fillText('Help map Singapore for cyclists', 28, 296);
  $('fbCardScrim').hidden=false; $('fbCard').hidden=false;
}
function closeCard(){ $('fbCardScrim').hidden=true; $('fbCard').hidden=true; }
$('fbCardDone').addEventListener('click', closeCard);
$('fbCardScrim').addEventListener('click', closeCard);
$('fbCardShare').addEventListener('click', ()=>{
  $('fbCardCanvas').toBlob(async blob=>{
    const file=new File([blob],'cbsg-contribution.png',{type:'image/png'});
    if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:'My Cycling Buddy SG contribution'}); return; }catch(_){} }
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='cbsg-contribution.png'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  },'image/png');
});

// ---------- community feed (approved only; no public vote counts) ----------
function ago(ms){ const s=(Date.now()-ms)/1000; if(s<3600) return Math.max(1,Math.round(s/60))+'m ago'; if(s<86400) return Math.round(s/3600)+'h ago'; return Math.round(s/86400)+'d ago'; }
async function loadFeed(){
  const list=$('fbList');
  if(!FEEDBACK_API){ list.innerHTML='<div class="fb-empty">The community feed appears here once the feedback service is live.</div>'; return; }
  list.innerHTML='<div class="fb-empty">Loading…</div>';
  try{
    const r=await fetch(FEEDBACK_API+'/api/feedback'); const data=await r.json(); const items=data.items||[];
    if(!items.length){ list.innerHTML='<div class="fb-empty">No approved feedback yet — be the first to contribute!</div>'; return; }
    const voted=new Set(JSON.parse(localStorage.getItem('cbsg.voted')||'[]'));
    list.textContent='';
    for(const it of items){
      const card=document.createElement('div'); card.className='fb-fcard';
      const h=document.createElement('div'); h.className='h';
      const badge=document.createElement('span'); badge.className='badge'; badge.textContent=it.kind==='path'?'New path':it.kind==='pin'?'Pin':'Comment';
      const who=document.createElement('span'); who.className='who'; who.textContent=it.contributor||'Anonymous rider';
      const when=document.createElement('span'); when.className='when'; when.textContent=ago(it.createdAt);
      h.append(badge,who,when);
      const note=document.createElement('div'); note.className='note'; note.textContent=it.note;   // textContent → stored text can't inject HTML
      const foot=document.createElement('div'); foot.className='foot';
      const vote=document.createElement('button'); vote.type='button'; vote.className='fb-vote'+(voted.has(it.id)?' voted':'');
      vote.textContent = voted.has(it.id) ? '👍 Thanks' : '👍 Helpful'; vote.disabled=voted.has(it.id);
      vote.addEventListener('click', ()=>castVote(it.id, vote, voted));
      foot.append(vote);
      card.append(h,note,foot); list.append(card);
    }
  }catch(_){ list.innerHTML='<div class="fb-empty">Couldn’t load the feed — check your connection and try again.</div>'; }
}
async function castVote(id, btn, voted){
  btn.disabled=true;
  try{ await fetch(FEEDBACK_API+'/api/feedback/'+id+'/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device:deviceToken()})}); }catch(_){}
  voted.add(id); localStorage.setItem('cbsg.voted', JSON.stringify([...voted]));
  btn.classList.add('voted'); btn.textContent='👍 Thanks';
}
