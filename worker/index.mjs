// Cycling Buddy SG — feedback Worker (Cloudflare Workers + D1)
//
// A tiny, owned backend for Phase 1 community feedback. It receives drawn paths / dropped pins /
// comments, serves the moderation-approved ones as a public feed, and records per-device thumbs-up
// whose counts only the owner sees. Deploy: see worker/README.md.
//
// Endpoints (JSON):
//   POST /api/feedback            {kind,geometry?,note,rating?,contributor?,appVersion} -> {id}
//   GET  /api/feedback            -> {items:[{id,kind,geometry,note,rating,contributor,createdAt}]}   (approved only)
//   POST /api/feedback/:id/vote   {device} -> {ok}                                                     (deduped per device)
//   GET  /api/admin/feedback?key=ADMIN_KEY            -> all rows incl. status + vote counts (owner)
//   POST /api/admin/feedback/:id?key=ADMIN_KEY  {action:'approve'|'reject'|'delete'} -> {ok}
//
// Config (wrangler.toml / secrets): DB (D1 binding), ADMIN_KEY (secret), ALLOW_ORIGIN (the site origin).
const MAX_NOTE = 2000, MAX_VERTS = 400, FEED_LIMIT = 100;

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { 'content-type': 'application/json', ...cors(origin) },
});
const cors = origin => ({
  'access-control-allow-origin': origin || '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
});
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function validKind(k) { return k === 'path' || k === 'pin' || k === 'comment'; }
function vertexCount(geom) {
  if (!geom || typeof geom !== 'object') return 0;
  const c = geom.coordinates;
  if (geom.type === 'Point') return 1;
  if (geom.type === 'LineString' && Array.isArray(c)) return c.length;
  return 1e9;                                         // reject anything else (polygons etc.)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOW_ORIGIN || request.headers.get('origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','feedback',...]

    try {
      // --- public: submit ---
      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'feedback' && parts.length === 2) {
        const b = await request.json().catch(() => ({}));
        if (!validKind(b.kind)) return json({ error: 'bad kind' }, 400, origin);
        const note = String(b.note || '').trim();
        if (note.length < 1 || note.length > MAX_NOTE) return json({ error: 'note length' }, 400, origin);
        const geom = b.kind === 'comment' ? null : b.geometry;
        if (b.kind !== 'comment' && vertexCount(geom) > MAX_VERTS) return json({ error: 'geometry too large' }, 400, origin);
        const rating = Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5 ? b.rating : null;
        const contributor = b.contributor ? String(b.contributor).trim().slice(0, 40) : null;
        const id = uuid();
        await env.DB.prepare(
          'INSERT INTO feedback (id,created_at,kind,geometry,note,rating,contributor,app_version,status) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(id, Date.now(), b.kind, geom ? JSON.stringify(geom) : null, note, rating, contributor, String(b.appVersion || ''), 'pending').run();
        return json({ id, ok: true, status: 'pending' }, 201, origin);
      }

      // --- public: approved feed ---
      if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'feedback' && parts.length === 2) {
        const rows = await env.DB.prepare(
          "SELECT id,created_at,kind,geometry,note,rating,contributor FROM feedback WHERE status='approved' ORDER BY created_at DESC LIMIT ?"
        ).bind(FEED_LIMIT).all();
        const items = (rows.results || []).map(r => ({
          id: r.id, createdAt: r.created_at, kind: r.kind,
          geometry: r.geometry ? JSON.parse(r.geometry) : null,
          note: r.note, rating: r.rating, contributor: r.contributor,
        }));
        return json({ items }, 200, origin);
      }

      // --- public: vote (deduped by device token) ---
      if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'feedback' && parts[3] === 'vote') {
        const id = parts[2], b = await request.json().catch(() => ({}));
        const device = String(b.device || '').slice(0, 64);
        if (!device) return json({ error: 'no device' }, 400, origin);
        const exists = await env.DB.prepare("SELECT 1 FROM feedback WHERE id=? AND status='approved'").bind(id).first();
        if (!exists) return json({ error: 'not found' }, 404, origin);
        await env.DB.prepare('INSERT OR IGNORE INTO vote (feedback_id,device,created_at) VALUES (?,?,?)').bind(id, device, Date.now()).run();
        return json({ ok: true }, 200, origin);
      }

      // --- owner: moderation (guarded by ADMIN_KEY) ---
      if (parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'feedback') {
        if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401, origin);
        if (request.method === 'GET' && parts.length === 3) {
          const rows = await env.DB.prepare(
            'SELECT f.*, (SELECT COUNT(*) FROM vote v WHERE v.feedback_id=f.id) AS votes FROM feedback f ORDER BY f.created_at DESC LIMIT 500'
          ).all();
          return json({ items: rows.results || [] }, 200, origin);
        }
        if (request.method === 'POST' && parts.length === 4) {
          const id = parts[3], b = await request.json().catch(() => ({})), action = b.action;
          if (action === 'approve' || action === 'reject') {
            await env.DB.prepare('UPDATE feedback SET status=? WHERE id=?').bind(action === 'approve' ? 'approved' : 'rejected', id).run();
            return json({ ok: true }, 200, origin);
          }
          if (action === 'delete') {
            await env.DB.prepare('DELETE FROM vote WHERE feedback_id=?').bind(id).run();
            await env.DB.prepare('DELETE FROM feedback WHERE id=?').bind(id).run();
            return json({ ok: true }, 200, origin);
          }
          return json({ error: 'bad action' }, 400, origin);
        }
      }

      return json({ error: 'not found' }, 404, origin);
    } catch (err) {
      return json({ error: 'server error', detail: String(err && err.message || err) }, 500, origin);
    }
  },
};
