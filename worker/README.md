# Cycling Buddy SG — feedback Worker

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) + [D1](https://developers.cloudflare.com/d1/)
backend for Phase 1 community feedback. It receives drawn paths / dropped pins / comments, serves the
**moderation-approved** ones as a public feed, and records per-device thumbs-up whose counts only you see.

The PWA works without this deployed — submissions queue on the device and send once the endpoint is
live and set. Nothing appears in the public feed until you approve it.

## Deploy (once)

```sh
cd worker
npm i -g wrangler            # or: npx wrangler ...
wrangler login

wrangler d1 create cbsg-feedback          # copy the printed database_id into wrangler.toml
wrangler d1 execute cbsg-feedback --file=schema.sql --remote
wrangler secret put ADMIN_KEY             # choose a long random string; keep it private
wrangler deploy                           # prints your Worker URL, e.g. https://cbsg-feedback.<you>.workers.dev
```

Then point the app at it: set `FEEDBACK_API` in `feedback.js` to your Worker URL and redeploy the PWA.
Also confirm `ALLOW_ORIGIN` in `wrangler.toml` matches the site origin (preview and production).

## Moderate

Nothing is public until approved.

```sh
# list everything (pending + approved) with vote counts
curl "https://cbsg-feedback.<you>.workers.dev/api/admin/feedback?key=YOUR_ADMIN_KEY"

# approve / reject / delete one
curl -X POST "https://.../api/admin/feedback/<id>?key=YOUR_ADMIN_KEY" -H 'content-type: application/json' -d '{"action":"approve"}'
```

Good submissions are best relayed to **OpenStreetMap** (the app's routing source), so the fix flows
back into routing on the next graph rebuild.

## Privacy

No accounts, no email. `contributor` is a self-chosen handle (or anonymous). `device` on a vote is an
opaque client token used only to dedupe. Under PDPA, keep submissions purpose-limited (improving the
map), delete on request, and don't publish anything you haven't reviewed.
