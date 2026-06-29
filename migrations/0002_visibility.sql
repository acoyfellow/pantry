ALTER TABLE recipes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

CREATE INDEX IF NOT EXISTS idx_recipes_visibility_updated_at ON recipes (visibility, updated_at DESC);
