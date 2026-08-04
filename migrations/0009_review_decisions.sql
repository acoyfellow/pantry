ALTER TABLE recipes ADD COLUMN reviewed_version INTEGER;
ALTER TABLE recipes ADD COLUMN reviewed_digest TEXT;

CREATE INDEX IF NOT EXISTS idx_recipes_pending_review
  ON recipes (owner, status, reviewed_version, updated_at DESC);
