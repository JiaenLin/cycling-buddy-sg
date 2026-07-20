-- Cycling Buddy SG — feedback backend (Cloudflare D1)
-- Apply:  wrangler d1 execute cbsg-feedback --file=worker/schema.sql
--
-- One row per submission. Nothing is public until status = 'approved' (moderation-before-publish).
-- No accounts: `contributor` is a self-chosen display handle (or NULL for anonymous). We never store
-- email or an app-side identity; `device` on a vote is an opaque client token only used to dedupe.
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,        -- uuid v4 from the client
  created_at  INTEGER NOT NULL,        -- epoch ms
  kind        TEXT NOT NULL,           -- 'path' | 'pin' | 'comment'
  geometry    TEXT,                    -- GeoJSON geometry string (NULL for a plain comment)
  note        TEXT NOT NULL,           -- the user's message (validated: 1..2000 chars)
  rating      INTEGER,                 -- optional 1..5
  contributor TEXT,                    -- chosen handle, or NULL (anonymous)
  app_version TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected'
);
CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback(status, created_at DESC);

-- One vote per (feedback, device). Counts are for the owner's triage only (not shown publicly),
-- so they signal demand without becoming a gameable public score.
CREATE TABLE IF NOT EXISTS vote (
  feedback_id TEXT NOT NULL,
  device      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (feedback_id, device)
);
