CREATE TRIGGER IF NOT EXISTS recipes_workspace_folder_match
BEFORE INSERT ON recipes
WHEN NEW.workspace_id IS NOT NULL
  AND NEW.folder_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM folders
    WHERE id = NEW.folder_id AND workspace_id <> NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'recipe folder workspace mismatch');
END;

CREATE TRIGGER IF NOT EXISTS recipes_workspace_folder_match_on_update
BEFORE UPDATE OF workspace_id, folder_id ON recipes
WHEN NEW.workspace_id IS NOT NULL
  AND NEW.folder_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM folders
    WHERE id = NEW.folder_id AND workspace_id <> NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'recipe folder workspace mismatch');
END;

CREATE TRIGGER IF NOT EXISTS recipe_alias_workspace_recipe_match
BEFORE INSERT ON recipe_aliases
WHEN EXISTS (
  SELECT 1 FROM recipes
  WHERE id = NEW.recipe_id
    AND workspace_id IS NOT NULL
    AND workspace_id <> NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'recipe alias workspace mismatch');
END;

CREATE TRIGGER IF NOT EXISTS recipe_alias_workspace_recipe_match_on_update
BEFORE UPDATE OF workspace_id, recipe_id ON recipe_aliases
WHEN EXISTS (
  SELECT 1 FROM recipes
  WHERE id = NEW.recipe_id
    AND workspace_id IS NOT NULL
    AND workspace_id <> NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'recipe alias workspace mismatch');
END;

CREATE TRIGGER IF NOT EXISTS agent_credential_workspace_identity_match
BEFORE INSERT ON agent_credentials
WHEN NEW.workspace_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM agent_identities
    WHERE id = NEW.agent_identity_id
      AND workspace_id IS NOT NULL
      AND workspace_id <> NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'agent credential workspace mismatch');
END;

CREATE TRIGGER IF NOT EXISTS agent_credential_workspace_identity_match_on_update
BEFORE UPDATE OF workspace_id, agent_identity_id ON agent_credentials
WHEN NEW.workspace_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM agent_identities
    WHERE id = NEW.agent_identity_id
      AND workspace_id IS NOT NULL
      AND workspace_id <> NEW.workspace_id
  )
BEGIN
  SELECT RAISE(ABORT, 'agent credential workspace mismatch');
END;

CREATE TRIGGER IF NOT EXISTS folder_permissions_active_revocation_shape
BEFORE INSERT ON folder_permissions
WHEN (NEW.revoked_by_actor_id IS NULL AND NEW.revoked_at IS NOT NULL)
  OR (NEW.revoked_by_actor_id IS NOT NULL AND NEW.revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'folder permission revocation shape');
END;

CREATE TRIGGER IF NOT EXISTS folder_permissions_active_revocation_shape_on_update
BEFORE UPDATE OF revoked_at, revoked_by_actor_id ON folder_permissions
WHEN (NEW.revoked_by_actor_id IS NULL AND NEW.revoked_at IS NOT NULL)
  OR (NEW.revoked_by_actor_id IS NOT NULL AND NEW.revoked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'folder permission revocation shape');
END;
