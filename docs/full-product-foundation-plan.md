# Full-product foundation plan

**Phase:** read-only foundation audit and implementation plan.  
**Repository state audited:** `a17508df1506d99984768d99843a43f9679ab92f` plus an already-dirty worktree; no existing modification was changed by this phase.  
**Authority artifact:** [`.context/team-recipes-architecture.md`](../.context/team-recipes-architecture.md). Where current code and older product/docs wording differ, the architecture artifact is the target design.

## Result

Pantry has the right raw ingredients for a workspace product—D1 migrations, immutable recipe-version snapshots, approval receipts, a management UI, Access-only Operations configuration, and agent credentials—but the active Operations path is still a shared owner shelf. `PANTRY_ACCESS_SHARE_ALL=true` maps every request carrying the configured email header to `PANTRY_SHARED_OWNER`; it does not resolve a D1 actor, membership, role, folder permission, or workspace. The existing `teams` and `team_members` tables are not consulted by `src/worker.ts` on that path.

The safe implementation is an additive, feature-flagged workspace layer. It must preserve the owner-keyed rows, their snapshot digests, approval receipts, attestations, usage reports, and immutable version rows. It must not reinterpret `recipes.owner` as the employee authorization subject. New employee routes should use a stable Access subject, D1 actor/workspace/folder authorization, and new audit/release records; legacy routes remain available only while the cutover flag is off.

No D1 database was inspected or changed, no migration was applied, no deployment occurred, and no GitLab action occurred.

## Evidence: current state

### Schema and history

| Existing migration | Current durable state relevant to the foundation |
| --- | --- |
| `0001_recipes.sql` | `recipes` is keyed by immutable `id`, but operational identity is the unique `(owner, name)` pair. It holds mutable current source/version/status. |
| `0002_visibility.sql` | Adds owner-wide `private`/`shared` visibility, not resource ACLs. |
| `0003_usage_and_tags.sql` | Adds tags and a caller/retrieval counter plus `recipe_usage_reports`; reports are keyed by legacy owner/name. |
| `0004_recipe_attestations.sql` | Adds recipe digest and attestation rows keyed by `(owner, recipe_name, version, digest)`. |
| `0005_approvals.sql` | Adds current approved digest/version plus immutable receipt rows. Receipts retain source code and an unverified string `actor`. |
| `0006_teams.sql` | Defines `teams` and `team_members(team_id, principal, role)`, with roles `owner`, `approver`, and `member`. |
| `0007_agent_credentials.sql` | Defines team/owner-principal-bound agents and SHA-256 credential verifiers. It has no expiry, folder attenuation, rotation lineage, or actor foreign key. |
| `0008_recipe_versions.sql` | Backfills immutable snapshots and prohibits their update/delete. Snapshot identity remains legacy `(owner, recipe_name, recipe_version, recipe_digest)`. |
| `0009_review_decisions.sql` | Adds mutable current-row `reviewed_version`/`reviewed_digest`. |

The migration directory stops at `0009`; new files must start at `0010`, are strictly additive, and must not modify any existing file.

### Worker and authorization

`src/worker.ts` currently has one `owner` context value, rather than an actor/workspace/resource authorization context.

- The Operations branch accepts `Cf-Access-Authenticated-User-Email` by default, or `PANTRY_ACCESS_IDENTITY_HEADER`, and trusts the value after the edge path. It does not validate `Cf-Access-Jwt-Assertion`, issuer, audience, signature, expiry, or `nbf`.
- With `PANTRY_ACCESS_SHARE_ALL=true`, every presented Access identity is assigned the configured `PANTRY_SHARED_OWNER`. Tests explicitly prove no `team_members` query occurs on this path.
- The shared-owner branch permits every admitted identity to create, revise, delete, issue/rotate/revoke agent credentials, and approve pending recipes. There is no role check.
- Agent authentication obtains a legacy owner principal from `agent_identities.owner_principal`, and scopes only distinguish read/write/usage. The credential has no workspace binding enforced independently of that legacy owner, expiry, folder allowlist, or actor identity.
- `GET /recipes` is owner-scoped or globally `visibility = 'shared'`; it has no workspace or folder filtering. Filtering and pagination are in memory.
- `GET /recipe/:name` resolves the caller's owner recipe first, then an arbitrary most-recent shared recipe with the same name. A pinned version may be requested, but identity remains the ambiguous name/owner resolver.
- `POST /recipes` is an upsert that increments the existing legacy row's version. `DELETE /recipe/:name` is a permanent delete of the current row rather than an archive.
- Approval has a useful optimistic version/digest check and batched receipt/current-row update, but the approval actor is the header email string. The receipt does not bind a workspace/folder distribution digest or a real actor ID.
- Successful full retrieval increments `recipes.run_count`; caller-reported usage increments the same counter. This is incompatible with the target distinction between retrieval audit and caller-side usage assertion.
- `isSameOrigin` is applied only through the Access-share-all path. Employee write routes must retain same-origin/Fetch Metadata CSRF protection after the middleware is replaced. Reflected CORS must not become the human-session authorization control.
- `/health` is deliberately open. The employee Access decision must explicitly choose between a separately monitored health endpoint and an Access-protected API surface; the current configuration does not satisfy an “all API routes are Access-protected” requirement by itself.

### Serialization, clients, and management UI

- `src/recipe.ts` serializes `author` from `row.owner`; it contains no `createdBy`, `updatedBy`, workspace, folder, alias, release distribution, or real actor provenance fields. `recipeSnapshotDigest` includes legacy `owner`; changing it would invalidate historic digests, so it must remain unchanged for historic records.
- `src/client.ts`, `src/cli.ts`, `src/mcp.ts`, `.pi/pantry-tool.ts`, and `extensions/opencode/index.ts` are all built around owner/name routes. `PantryClient.get` can pass an optional version, but the CLI, MCP, Pi, and OpenCode `get`/`run` surfaces do not require one. The target agent contract requires pinned retrieval.
- `PantryClient.approve` currently sends only `action` and optional reason, while the Worker approval endpoint requires `version` and `recipeDigest`; this must be fixed or retired when the workspace review API is introduced.
- `app-ui/src/App.svelte` is the only Operations UI component. It already has navigation slots for People, Folders, Activity, and Settings. Those views are presentation-only: People says the directory/roles are unavailable; Folders displays recipe tags and explicitly says folders and permissions do not exist; Activity derives activity from recipe counters. This is the exact UI seam for real membership, folder/ACL, and audit screens.
- `test/fake-d1.ts` pattern-matches the legacy SQL only. It cannot establish the safety of recursive folder authorization, Access/actor resolution, transaction races, or the new D1 indexes/triggers. New authorization/migration tests need a real local D1/Miniflare database fixture in addition to targeted fake-repository unit tests.

### Operations configuration

`wrangler.ax.jsonc` binds the Operations custom domain and D1 database with `PANTRY_SHARED_OWNER`, `PANTRY_ACCESS_SHARE_ALL=true`, and `PANTRY_ACCESS_ONLY=true`. It has no JWT audience/issuer/JWKS configuration, employee-workspace flag, workspace slug, role-policy version, or deployment-time rejection of `PANTRY_DEV_ACCESS_IDENTITY`. `example.dev-vars-ops.txt` correctly places the development identity in local vars, but production validation is not implemented.

The public `wrangler.jsonc` remains owner/token-oriented. The employee foundation must be Operations-scoped first and must not silently change public self-hosted semantics.

## Target invariants

1. A verified Access JWT `sub`, not email and not a caller-supplied body/header identity, is the durable human authority key.
2. Exactly one employee workspace exists for the Operations deployment: `cloudflare-employees`. Existing legacy owners remain provenance only.
3. Every employee request resolves server-side to an actor, workspace, effective workspace role, and effective folder permissions. The browser never supplies any of them as authority.
4. The root folder inherits workspace policy. A restricted folder has one or more active positive grants. Restricted ancestors are cumulative; no deny rules are introduced.
5. A recipe has a stable legacy history and an employee-workspace binding. Historic recipe and version digests are never recomputed.
6. A new revision, capability/schema change, or distribution broadening requires a pending release/review decision. A restriction-only move changes access immediately and is audited.
7. Agent effective permission is the intersection of workspace binding, credential state/expiry, declared scope, folder allowlist, service actor role, and folder ACL. Agents cannot manage ACLs/memberships, issue human sessions, or review releases.
8. Lists and search return only metadata authorized for the caller; inaccessible rows must be removed before pagination/count calculation. Source fetch is explicitly version-pinned for machines.
9. Sensitive allow and safe deny decisions append a source-free audit event using the actual actor/credential/resource version.
10. Rollback switches routing with a feature flag; it never removes mappings, ACLs, versions, receipts, credentials, or audit records.

## Exact additive migration set

These are the planned filenames and schema contracts. They are not created by this audit. They intentionally do not backfill or delete production data: data migration happens only after a backup manifest and only through an explicit, reviewed migration runner.

### `migrations/0010_workspace_actors.sql`

Create the following tables and indexes before any employee route can be enabled.

| Object | Exact fields and constraints |
| --- | --- |
| `actors` | `id TEXT PRIMARY KEY`; `kind TEXT NOT NULL CHECK (kind IN ('human','agent','system'))`; `access_subject TEXT`; `display_email_normalized TEXT`; `status TEXT NOT NULL CHECK (status IN ('active','revoked','disabled'))`; `created_at TEXT NOT NULL`; `updated_at TEXT NOT NULL`; `revoked_at TEXT`; `created_by_actor_id TEXT REFERENCES actors(id)`. Add `CHECK ((kind = 'human' AND access_subject IS NOT NULL) OR kind <> 'human')`. Add partial unique index `actors_human_access_subject_unique` on `access_subject` where `kind = 'human' AND access_subject IS NOT NULL`; add index `actors_display_email` on normalized display email. Email is display/audit data, never the primary authorization key. |
| `workspaces` | `id TEXT PRIMARY KEY`; `slug TEXT NOT NULL UNIQUE`; `display_name TEXT NOT NULL`; `kind TEXT NOT NULL CHECK (kind = 'employee')`; `status TEXT NOT NULL CHECK (status IN ('active','disabled'))`; `created_at TEXT NOT NULL`; `created_by_actor_id TEXT NOT NULL REFERENCES actors(id)`. The migration runner creates the sole Operations row later, not this DDL migration. |
| `workspace_memberships` | `id TEXT PRIMARY KEY`; `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`; `actor_id TEXT NOT NULL REFERENCES actors(id)`; `role TEXT NOT NULL CHECK (role IN ('reader','contributor','reviewer','admin'))`; `source TEXT NOT NULL CHECK (source IN ('access-default','admin-grant','access-group'))`; `valid_from TEXT NOT NULL`; `valid_until TEXT`; `created_at TEXT NOT NULL`; `created_by_actor_id TEXT REFERENCES actors(id)`; `revoked_at TEXT`; `revoked_by_actor_id TEXT REFERENCES actors(id)`. Add partial unique index `workspace_memberships_one_active` on `(workspace_id, actor_id)` where `valid_until IS NULL AND revoked_at IS NULL`; add active-resolution index `(workspace_id, actor_id, valid_from, valid_until, revoked_at)`. Initial employee readers are derived after verified Access admission; only elevated grants need durable rows in the first release. |

Do not import `teams` or `team_members` into these tables in DDL. A later reviewed mapping runner may create actors/memberships only where a stable subject is verified; unverified principal strings stay legacy provenance.

### `migrations/0011_folders_and_permissions.sql`

| Object | Exact fields and constraints |
| --- | --- |
| `folders` | `id TEXT PRIMARY KEY`; `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`; `parent_id TEXT REFERENCES folders(id)`; `slug TEXT NOT NULL`; `display_name TEXT NOT NULL`; `created_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `updated_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `created_at TEXT NOT NULL`; `updated_at TEXT NOT NULL`; `archived_at TEXT`; `archived_by_actor_id TEXT REFERENCES actors(id)`; `CHECK (parent_id IS NULL OR parent_id <> id)`. Add expression unique index `folders_unique_sibling_slug` on `(workspace_id, COALESCE(parent_id, ''), slug)`, active lookup index `(workspace_id, parent_id, archived_at, slug)`, and partial unique index `folders_one_root_per_workspace` on `(workspace_id)` where `parent_id IS NULL`. |
| folder cycle guards | Add `folders_no_cycle_on_insert` and `folders_no_cycle_on_parent_update` `BEFORE INSERT/UPDATE OF parent_id` triggers that use a recursive ancestor CTE and `RAISE(ABORT, 'folder parent cycle')` if the candidate folder appears in its own ancestor chain. The Worker still validates same-workspace parentage; the trigger is the last durable guard. |
| `folder_permissions` | `id TEXT PRIMARY KEY`; `folder_id TEXT NOT NULL REFERENCES folders(id)`; `subject_actor_id TEXT NOT NULL REFERENCES actors(id)`; `permission TEXT NOT NULL CHECK (permission IN ('read','write','review','admin'))`; `granted_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `granted_at TEXT NOT NULL`; `revoked_at TEXT`; `revoked_by_actor_id TEXT REFERENCES actors(id)`; `revocation_reason TEXT`. Add partial unique index `folder_permissions_one_active_grant` on `(folder_id, subject_actor_id, permission)` where `revoked_at IS NULL`; add authorization index `(folder_id, subject_actor_id, revoked_at, permission)`. There are no deny rows and no raw-email permission subjects. |

The migration runner creates the one root folder for `cloudflare-employees` after it creates the workspace, with the named migration system actor as creator. The root has no ACL rows and therefore inherits workspace policy.

### `migrations/0012_recipe_workspace_bridge.sql`

Add only nullable bridge columns to `recipes`; leave `owner`, the existing `(owner, name)` unique index, snapshots, and digest algorithm intact.

```text
recipes.workspace_id TEXT REFERENCES workspaces(id)
recipes.folder_id TEXT REFERENCES folders(id)
recipes.created_by_actor_id TEXT REFERENCES actors(id)
recipes.updated_by_actor_id TEXT REFERENCES actors(id)
recipes.legacy_owner TEXT
recipes.workspace_recipe_key TEXT
recipes.archived_at TEXT
recipes.archived_by_actor_id TEXT REFERENCES actors(id)
```

Add `recipes_workspace_key_unique` as a partial unique index on `(workspace_id, workspace_recipe_key)` where both values are non-null; add `recipes_workspace_folder_updated` on `(workspace_id, folder_id, archived_at, updated_at DESC)`; add `recipes_workspace_legacy_coordinate` on `(workspace_id, legacy_owner, name)`. Do **not** issue `UPDATE recipes SET legacy_owner = owner` from this migration. The migration runner writes it only after a manifest exists and has selected the workspace mapping.

Create these sidecar tables:

| Object | Exact fields and constraints |
| --- | --- |
| `recipe_version_workspace_bindings` | `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`; `recipe_id TEXT NOT NULL`; `legacy_owner TEXT NOT NULL`; `recipe_name TEXT NOT NULL`; `recipe_version INTEGER NOT NULL`; `recipe_digest TEXT`; `bound_at TEXT NOT NULL`; `bound_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `migration_manifest_id TEXT`; primary key `(legacy_owner, recipe_name, recipe_version)`. Add unique index `(workspace_id, recipe_id, recipe_version)`. It binds immutable legacy snapshots without altering `recipe_versions`. |
| `recipe_aliases` | `id TEXT PRIMARY KEY`; `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`; `alias TEXT NOT NULL`; `recipe_id TEXT NOT NULL`; `kind TEXT NOT NULL CHECK (kind IN ('legacy','collision','display'))`; `created_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `created_at TEXT NOT NULL`; `archived_at TEXT`. Add partial unique index on `(workspace_id, alias)` where `archived_at IS NULL`. This is the collision escape hatch; no owner/name upsert may resolve a collision. |
| `migration_subject_map` | `id TEXT PRIMARY KEY`; `migration_manifest_id TEXT NOT NULL`; `legacy_recipe_id TEXT NOT NULL`; `legacy_owner TEXT NOT NULL`; `legacy_name TEXT NOT NULL`; `workspace_id TEXT REFERENCES workspaces(id)`; `recipe_id TEXT`; `workspace_recipe_key TEXT`; `folder_id TEXT REFERENCES folders(id)`; `outcome TEXT NOT NULL CHECK (outcome IN ('planned','mapped','collision','unmapped','failed'))`; `detail_digest TEXT`; `created_at TEXT NOT NULL`; `updated_at TEXT NOT NULL`; `UNIQUE (migration_manifest_id, legacy_recipe_id)`; `UNIQUE (migration_manifest_id, legacy_owner, legacy_name)`. |

The Worker must treat the bridge as mandatory only when the employee feature flag is enabled. Old owner routes continue using legacy columns until retirement.

### `migrations/0013_invitations_and_agent_workspace_bindings.sql`

Create invitation records for explicit elevated-role administration, not as a substitute for Cloudflare Access admission.

| Object | Exact fields and constraints |
| --- | --- |
| `workspace_invitations` | `id TEXT PRIMARY KEY`; `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`; `target_access_subject TEXT NOT NULL`; `display_email_normalized TEXT`; `role TEXT NOT NULL CHECK (role IN ('contributor','reviewer','admin'))`; `status TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired'))`; `token_verifier TEXT NOT NULL UNIQUE`; `expires_at TEXT NOT NULL`; `created_at TEXT NOT NULL`; `created_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `accepted_at TEXT`; `accepted_by_actor_id TEXT REFERENCES actors(id)`; `revoked_at TEXT`; `revoked_by_actor_id TEXT REFERENCES actors(id)`. Add a partial unique index on `(workspace_id, target_access_subject, role)` where `status = 'pending'`. The token is random, returned once, and only its SHA-256 verifier is stored. Acceptance requires the current verified subject to equal `target_access_subject`; the display email may aid delivery but is never the authority key. |
| agent identity additions | `ALTER TABLE agent_identities ADD COLUMN actor_id TEXT REFERENCES actors(id)`; `workspace_id TEXT REFERENCES workspaces(id)`; `created_by_actor_id TEXT REFERENCES actors(id)`; `revoked_by_actor_id TEXT REFERENCES actors(id)`; `revocation_reason TEXT`. Add partial unique index `agent_identities_workspace_actor_unique` on `(workspace_id, actor_id)` where both are non-null. Retain `team_id`, `principal`, and `owner_principal` untouched for legacy compatibility. |
| agent credential additions | `ALTER TABLE agent_credentials ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)`; `expires_at TEXT`; `created_by_actor_id TEXT REFERENCES actors(id)`; `revoked_by_actor_id TEXT REFERENCES actors(id)`; `revocation_reason TEXT`; `replaces_credential_id TEXT REFERENCES agent_credentials(id)`; `replaced_by_credential_id TEXT REFERENCES agent_credentials(id)`; `hash_scheme TEXT NOT NULL DEFAULT 'sha256-v1'`. Add active lookup index `(workspace_id, credential_hash, revoked_at, expires_at)`. New credentials must be generated with high entropy and verified under the declared hash scheme; old verifiers are neither rewritten nor exposed. |
| `agent_credential_folder_allowlists` | `credential_id TEXT NOT NULL REFERENCES agent_credentials(id)`; `folder_id TEXT NOT NULL REFERENCES folders(id)`; `created_at TEXT NOT NULL`; `created_by_actor_id TEXT NOT NULL REFERENCES actors(id)`; `revoked_at TEXT`; `revoked_by_actor_id TEXT REFERENCES actors(id)`; primary key `(credential_id, folder_id)`. Active rows are an allowlist, not grants: effective access is still intersected with the agent actor's folder permissions. |

The new agent endpoint must create an `actors.kind = 'agent'` row and bind it to `agent_identities.actor_id`. It must never use the issuing human as the agent actor.

### `migrations/0014_release_reviews_and_audit_events.sql`

| Object | Exact fields and constraints |
| --- | --- |
| `recipe_release_reviews` | `id TEXT PRIMARY KEY`; `workspace_id TEXT NOT NULL REFERENCES workspaces(id)`; `recipe_id TEXT NOT NULL`; `recipe_version INTEGER NOT NULL`; `recipe_digest TEXT`; `input_schema_digest TEXT NOT NULL`; `capabilities_digest TEXT NOT NULL`; `distribution_digest TEXT NOT NULL`; `action TEXT NOT NULL CHECK (action IN ('approve','reject','request-revision'))`; `reason TEXT`; `actor_id TEXT NOT NULL REFERENCES actors(id)`; `access_subject_snapshot TEXT`; `created_at TEXT NOT NULL`; `receipt_digest TEXT NOT NULL UNIQUE`; `migration_manifest_id TEXT`. Add review lookup index `(workspace_id, recipe_id, recipe_version, created_at DESC)` and partial unique index `recipe_release_reviews_one_terminal_decision` on `(recipe_id, recipe_version, recipe_digest, distribution_digest)` where `action IN ('approve','reject')`. The Worker uses a guarded insert in the same D1 batch/transaction as the release state change so concurrent terminal decisions cannot both succeed. |
| `audit_events` | `event_id TEXT PRIMARY KEY`; `occurred_at TEXT NOT NULL`; `request_id TEXT NOT NULL`; `action TEXT NOT NULL`; `outcome TEXT NOT NULL CHECK (outcome IN ('allowed','denied','failed'))`; `workspace_id TEXT REFERENCES workspaces(id)`; `folder_id TEXT REFERENCES folders(id)`; `recipe_id TEXT`; `recipe_version INTEGER`; `recipe_digest TEXT`; `actor_id TEXT REFERENCES actors(id)`; `actor_kind TEXT CHECK (actor_kind IN ('human','agent','system'))`; `access_subject_snapshot TEXT`; `credential_id TEXT REFERENCES agent_credentials(id)`; `authorization_policy_version TEXT NOT NULL`; `reason_code TEXT NOT NULL`; `metadata_digest TEXT NOT NULL`; `metadata_json TEXT NOT NULL DEFAULT '{}'`. Pre-auth denials may leave actor fields null rather than fabricating a human/system actor. `metadata_json` is allowlisted structured metadata only; it cannot include Access JWTs, bearer values, raw request bodies, or recipe source. Add indexes `(workspace_id, occurred_at DESC)`, `(actor_id, occurred_at DESC)`, `(recipe_id, occurred_at DESC)`, and `(request_id)`. |
| audit guards | Add `BEFORE UPDATE` and `BEFORE DELETE` triggers on `audit_events` that abort. Retention is not implemented by disabling these triggers or deleting events; a separately approved future retention design must append a system-actor redaction/tombstone record without rewriting the original event. |

Legacy `recipe_approval_receipts` remain immutable historical evidence and are not rewritten. A reviewed migration runner may link their legacy actor string to an actor only when that mapping is certain.

### `migrations/0015_employee_foundation_guards.sql`

Create D1-level guard triggers that prevent an employee bridge row from pointing across workspaces:

1. `recipes_workspace_folder_match` on insert/update of `recipes.workspace_id, recipes.folder_id`, rejecting a non-null folder whose `workspace_id` differs from the recipe workspace.
2. `recipe_alias_workspace_recipe_match` on insert/update of `recipe_aliases`, rejecting aliases whose target recipe has a non-null different workspace.
3. `agent_credential_workspace_identity_match` on insert/update of `agent_credentials.workspace_id`, rejecting a credential whose agent identity's non-null workspace differs.
4. `folder_permissions_active_revocation_shape`, rejecting a row that has a revoker without `revoked_at`, or `revoked_at` without a revoker.

These are all additive safeguards. Worker checks remain required for authorization and useful error responses.

## Worker implementation seams and route plan

### 1. Introduce an explicit authorization module before changing handlers

Split `src/worker.ts` into small internal modules or clearly isolated functions without changing public legacy behavior first:

- `access-identity.ts`: validates `Cf-Access-Jwt-Assertion` against configured issuer/team domain, audience, JWKS signature, algorithm allowlist, expiry, and not-before time. It produces `{ accessSubject, normalizedEmail, issuedAt, expiresAt }` only after validation. A header email is display data only. It rejects an absent or invalid assertion with `401`.
- `authorization.ts`: resolves/upserts the verified human actor, resolves the fixed employee workspace, derives baseline reader access, loads any active elevated membership, and evaluates cumulative restricted-folder grants. It returns a typed `HumanAuthorization` rather than a string owner.
- `agent-authorization.ts`: resolves a credential, expiry/revocation/rotation state, workspace-bound agent actor, scopes, and folder allowlist. It returns a typed `AgentAuthorization` and never upgrades it to a human context.
- `audit.ts`: assigns/propagates a request correlation ID and appends allowlisted audit rows after each sensitive decision. It must handle D1 failure deliberately: authorization failures remain fail-closed; audit-write failures for sensitive successful writes must fail the write transaction rather than silently create untraceable mutations.
- `recipe-repository.ts`: performs workspace/folder-scoped queries and emits distinct serialization shapes for discovery, review, and pinned source retrieval.

Keep a `LegacyAuthorization` path only behind the existing legacy flag. Do not allow code to choose authorization behavior from a browser query parameter, request body, or client-provided role/folder.

### 2. Gate the new path

Add Operations variables, all default-off except in local staging:

```text
PANTRY_EMPLOYEE_WORKSPACE_ENABLED=false
PANTRY_EMPLOYEE_WORKSPACE_SLUG=cloudflare-employees
PANTRY_ACCESS_TEAM_DOMAIN=<approved Access team domain>
PANTRY_ACCESS_AUD=<approved Access application audience>
PANTRY_AUTHORIZATION_POLICY_VERSION=employee-v1
PANTRY_ACCESS_JWKS_URL=<derived or explicitly approved endpoint>
```

Validate at Worker startup/request boundary that production employee mode rejects `PANTRY_DEV_ACCESS_IDENTITY`, requires the Access JWT configuration, requires the workspace slug, and does not coexist with `PANTRY_ACCESS_SHARE_ALL=true`. Do not put secrets in `wrangler.ax.jsonc`; configuration that is sensitive belongs in Worker secrets. The Access application must protect `/manage/*`, `/api/*`, `/recipes*`, and `/recipe/*` during the legacy period; the final employee routes should be added to that policy before their flag turns on.

`wrangler.ax.jsonc` is the Operations seam. The public `wrangler.jsonc` must remain legacy/self-hosted until an explicitly separate product decision adopts workspaces.

### 3. Add workspace routes; preserve legacy routes during shadowing

The following routes are additive under `/api/workspaces/:workspaceSlug`; they avoid ambiguous owner/name resolution. The Worker derives the workspace from the authenticated context and rejects a URL slug that does not match that context.

| Route | Required server-side authorization and response boundary |
| --- | --- |
| `GET /api/session` | Returns `actor { id, kind, displayEmail }`, `workspace { id, slug, displayName }`, effective workspace role, and permitted navigation flags. Never returns Access JWTs, credential data, or unfiltered memberships. |
| `GET /api/workspaces/:workspaceSlug/recipes?folder=&q=&cursor=` | `read` authorization on each resolved folder; filter before count/cursor calculation; metadata only. Return `recipeKey`, folder metadata only when visible, creator/last-editor actor display data, current release state, and pinned version/digest. |
| `POST /api/workspaces/:workspaceSlug/recipes` | Requires `write` at the selected folder; creates a new workspace recipe key rather than owner/name upsert semantics. Records creator/updater actor and `recipe.created` audit event. |
| `POST /api/workspaces/:workspaceSlug/recipes/:recipeKey/revisions` | Requires `write`; creates an immutable version and pending release. It cannot modify prior source or source digest. |
| `GET /api/workspaces/:workspaceSlug/recipes/:recipeKey/versions/:version` | Metadata for a permitted version. Machine source is not supplied here by accident. |
| `GET /api/workspaces/:workspaceSlug/recipes/:recipeKey/versions/:version/source` | Requires explicit pinned version plus `read`, requires approved release for machine use, writes `recipe.retrieved` with actor/credential/version/digest. It must not increment caller-use metrics. |
| `POST /api/workspaces/:workspaceSlug/recipes/:recipeKey/move` | Requires admin at source/destination; computes distribution change. Broader distribution creates a pending release on the unchanged content; narrower distribution applies immediately. Both audit the exact before/after folder/digest. |
| `POST /api/workspaces/:workspaceSlug/recipes/:recipeKey/archive` and `/restore` | Requires `write`/`admin` policy as approved; soft archive only. No route permanently deletes a recipe or version. |
| `GET /api/workspaces/:workspaceSlug/approvals` | Requires `review`/`admin`, returns only authorized pending releases. |
| `POST /api/workspaces/:workspaceSlug/recipes/:recipeKey/versions/:version/reviews` | Human only; requires `review`/`admin`; body contains action/reason and optimistic release/digest values. Server derives actor/folder/distribution; batched guarded insert produces an immutable `recipe_release_reviews` row and audit event. |
| `POST /api/workspaces/:workspaceSlug/recipes/:recipeKey/versions/:version/usage` | Scoped human/agent caller assertion, idempotent event ID, separate from retrieval audit. The supplied version/digest must match the pinned approved release. |
| `GET/POST/PATCH /api/workspaces/:workspaceSlug/folders` and `POST /.../folders/:folderId/move` | Folder read/list requires visibility; creation/rename/archive/move requires workspace or folder `admin`. Parent/workspace and cycle checks are repeated in Worker. |
| `GET /.../folders/:folderId/permissions`, `POST /.../permissions`, `DELETE /.../permissions/:permissionId` | Requires folder/workspace `admin`; creates/revokes positive grants and audits both grantor and subject. |
| `GET/POST/PATCH /api/workspaces/:workspaceSlug/memberships` and revoke route | Human workspace admin only. No endpoint accepts an arbitrary effective role on recipe actions. |
| `GET/POST/DELETE /api/workspaces/:workspaceSlug/invitations` and `POST /.../invitations/:id/accept` | Admin creates/revokes; accepting user must have a verified Access subject equal to the invitation target. Acceptance creates the elevated membership in the same transaction and audits it. |
| `POST /api/workspaces/:workspaceSlug/agent-credentials`, rotate/revoke/list routes | Human workspace admin only; creation returns a secret once, all later listings redact it. Scope/expiry/allowlist must be intersected on every agent request. |
| `GET /api/workspaces/:workspaceSlug/audit-events?cursor=` | Workspace admin only; paginated, source-free, allowlisted audit view. |

During rollout, retain existing `/recipes`, `/recipe/:name`, and current `/api/*` behavior for public/legacy clients. The Operations UI should switch to the workspace routes only when the employee feature flag and workspace mapping are enabled. Do not make the new route fall back to owner/shared discovery.

### 4. Preserve serialization and historical digests

Keep `recipeSnapshotDigest(owner, recipe, version)` for existing rows and historical validation. Add separate canonical digest functions for new values:

- `inputSchemaDigest`, `capabilitiesDigest`, and `distributionDigest` for a release review;
- distribution digest input: workspace ID, resolved folder ID/path, active ACL policy version/entries relevant to distribution, and release policy version;
- `metadataDigest` for allowlisted audit metadata.

`src/recipe.ts` gains workspace-specific response types rather than changing every legacy `RecipeRow` response in place. Discovery must never include `code`, credential material, JWTs, raw permission metadata, or invisible ancestor folder names. Full source retrieval returns `legacyOwner` only as explicitly named historic provenance and returns `createdBy`/`updatedBy` from actors, never as authorization inputs.

### 5. Update clients and machine surfaces after Worker v2 is tested

Keep `PantryClient` legacy compatible. Introduce a workspace-aware client namespace or `WorkspacePantryClient` that requires workspace slug and has methods whose types require `recipeKey` and `version` for source retrieval. Update these seams together:

- `src/client.ts`: workspace list/create/revision/pinned-source/usage methods and typed session actor/workspace models.
- `src/cli.ts`: employee-machine commands must require `--workspace` and `--version` for `get`/`run`; browser SSO remains browser-only.
- `src/mcp.ts`, `.pi/pantry-tool.ts`, and `extensions/opencode/index.ts`: `pantry_get` and `pantry_run` must require/select an immutable version in employee mode. They continue caller-side execution only; Pantry never becomes an executor.
- `src/surface.ts`: secret loading remains agent-only. It must not treat a browser Access session as a token handoff.
- Existing `approve` client call is either upgraded to send the required immutable subject or replaced by the workspace review method; do not preserve its currently incomplete payload.

## UI implementation seams

`app-ui/src/App.svelte` can remain a single Svelte component for the first vertical slice, but API access should move into a small typed `app-ui/src/api.ts` before adding stateful management flows. The UI must render server-derived capability flags and handle `401`, `403`, and selected concealment `404` responses without locally deciding access.

| Existing UI area | Replacement seam |
| --- | --- |
| `loadSession()` and sidebar workspace label | Consume richer `/api/session`; show actor display identity, workspace display name, and server-provided role. Do not show Access subject or credential details. |
| Recipes inventory and `refresh()` | Request workspace-scoped paginated discovery. Replace tag-derived folder labels with actual permitted folders. Persist cursor/filter state without guessing counts for inaccessible rows. |
| Create/revision dialog | Folder picker contains only write-authorized folders. Create uses a new recipe endpoint; revision uses `recipeKey` and shows its immutable pending release. It cannot submit actor, role, workspace ID, or permission facts as authority. |
| Detail/approval dialog | Load a pinned review version and source through review-only route. Show creator/editor provenance, folder, distribution/release state, exact version/digest, and review receipt. Enable decisions only when session capability says `canReview`; server remains decisive. |
| Existing People view | Replace placeholder “SSO managed” card with paginated memberships, pending invitations, grant/revoke actions, and an explicit display of baseline Access reader access versus elevated Pantry role. Gate controls on `canManageMembers`. Do not build direct Access-policy management into Pantry. |
| Existing Folders view | Replace tags with folder tree, inherited/restricted status, permitted children, positive grants, and admin-only create/move/ACL dialogs. Explain cumulative ancestor restrictions without exposing restricted ancestor names to callers who cannot see them. |
| Existing Activity view | Read audit event summaries, not `run_count`/`last_run_at`. Clearly label `recipe.retrieved`, `usage.reported`, `release.reviewed`, and administrative events as different facts. |
| Existing Settings/MCP setup | Display approved operational connection guidance and credential lifecycle status only. Agent secret creation UI may display the secret exactly once in a modal that is not retained in Svelte state after close; it must never put it in local/session storage. |

Add component/API tests for optimistic-state invalidation after `403`, move/ACL changes, invitation accept/revoke, rotation/revoke, and stale release decisions. Do not use UI state as an authorization cache.

## Data migration, shadowing, and cutover

1. **Human approvals first.** Obtain the approved Access application/audience/JWKS validation method, stable-subject availability, employee admission policy, elevated-role admins, folder disclosure policy, credential secret storage, audit retention policy, and legacy-token sunset date.
2. **Take an out-of-repository backup/export.** Produce a signed/hashed manifest of recipes, all `(owner,name,version,digest)` tuples, source-byte hashes, receipt digests, attestation counts, usage-report counts, teams, and credentials. It contains no plaintext credentials and is not committed.
3. **Inventory collisions.** For every desired employee-facing name, list all legacy owners. Stop mapping a collision until an administrator selects a `recipe_aliases` mapping. Never solve it with `POST /recipes` or an owner/name upsert.
4. **Apply only the new migrations to disposable local/staging D1 first.** Confirm all existing rows and their old digest relationships are unchanged. No remote production migration is in this phase.
5. **Create one system actor, workspace, and root folder.** Use a named `system:migration/<manifest-id>` actor. Insert rows through a migration runner, not automatic Worker startup logic.
6. **Build `migration_subject_map` in planned state.** Map each legacy `recipes.id` and its immutable versions. Set `legacy_owner`, `workspace_id`, `folder_id`, and actor provenance only after verified mapping. Unknown owners remain legacy provenance, and the migration system actor is recorded instead of inventing a human author.
7. **Treat `review_this_mr` and `reviews_todo` as data canaries.** Export and validate every current/historical source byte, digest, approval receipt, attestation, and usage record. Locate by stable legacy coordinates and ID, not a fresh push. Put them in `engineering/reviews` only after the folder/ACL decision is approved; otherwise root-share them. A broader move creates a pending distribution release referencing unchanged content.
8. **Shadow authorization.** For an Access test cohort, execute legacy and employee authorizers on safe metadata queries and compare allow/deny results. Do not retrieve source merely to compare list behavior. Record mismatches in audit/operations evidence.
9. **Staging canary.** Use real Access-protected staging to test human roles, root/restricted folders, agents, pinned retrieval, reviews, usage, audit, rotation, revocation, and rollback flag behavior.
10. **Production canary and cutover.** Enable `PANTRY_EMPLOYEE_WORKSPACE_ENABLED` for a named cohort, then wider Operations traffic. Only after manifest parity and clean observation does the Operations configuration retire `PANTRY_ACCESS_SHARE_ALL` and disable legacy tokens for that origin.
11. **Rollback.** Set the feature flag back to legacy routing. Do not run a down migration and do not delete workspace records, ACLs, audit rows, versions, mappings, or credentials.

## Test and evidence plan

### Required automated tests

- Access verifier rejects missing, invalid-signature, wrong-audience, expired, and not-before JWTs. A forged email header never creates a human actor.
- Subject is stable across display-email case/change; absent elevated membership fails closed.
- Baseline reader, contributor, reviewer, and admin boundaries are covered; every sensitive route is exercised with human, agent, legacy, and unauthenticated contexts.
- Folder inherited policy, explicit grants, cumulative restricted ancestors, cross-workspace parent attempts, cycles, archived folders, and list-count/cursor non-disclosure are tested against migrated local D1.
- Every agent attenuation dimension—scope, expiry, revocation, successor rotation, workspace binding, agent actor role, and folder allowlist—is independently denied when absent. Agent management/review calls are denied.
- Concurrent revision/review tests prove one terminal review receipt; broadening a distribution reopens review; restricting changes access without mutating historic approval evidence.
- Pinned source retrieval audits exact recipe/version/digest and remains distinct from idempotent usage assertion. Neither falsely claims Pantry executed source.
- Migration fixtures cover multiple owners, duplicate names, old null digest rows, approved/pending/rejected versions, receipts, attestations, usage reports, agent rows, and both named review recipes. Compare pre/post manifests exactly.
- Audit trigger tests prove update/delete fail; audit serialization tests prove source, token, JWT, and request-body fields are absent.
- The legacy feature-flag path still passes its regression suite until retirement.

### Required non-code evidence before cutover

- Access application identifiers and verified JWT-validation configuration.
- Backup manifest plus post-map/post-backfill manifest with exact counts/digests.
- Approved collision/alias resolution record.
- Staging Access role matrix and browser/API evidence for allowed and denied cases.
- Credential rotation/revocation evidence with no secret in logs or repository.
- Flag state, shadow mismatch report, and rollback rehearsal result.

## Risk register

| Priority | Risk | Evidence in audit | Mitigation and release gate |
| --- | --- | --- | --- |
| Critical | Email-header spoofing or direct Worker reachability is accepted as human identity. | Worker trusts configurable email header and does not validate Access JWT. | Implement JWT validation in Worker, protect all selected Operations routes at Access, and prove forged/missing/wrong-audience headers are `401` before flag enablement. |
| Critical | All Access-admitted users currently receive full write, approval, and credential-admin authority. | Share-all branch fixes owner and has no membership/role queries. | Do not enable employee routing until actor/membership/folder checks and role tests pass. |
| Critical | Folder/resource disclosure leaks restricted recipe metadata or pagination counts. | Current recipe list is owner/shared global and filters in memory. | Server-side authorization predicate before cursor/count; define `404` versus `403` disclosure policy; test restricted ancestors and search. |
| Critical | Cutover corrupts or invalidates historic recipe evidence. | Digests include owner; versions/attestations/receipts use owner/name coordinates. | Bridge/sidecar model only, immutable manifest verification, no historic digest recomputation, no `POST /recipes` migration. |
| High | Existing recipe name collisions silently select/overwrite an unintended artifact. | Current resolver selects own then most-recent shared row; upsert is owner/name based. | Inventory before mapping; require explicit alias decision; no automatic flattening. |
| High | Agent credential has broader/longer access than intended. | Current credentials lack expiry, folder constraints, workspace actor binding, and rotation linkage. | Add credential bindings/allowlists and evaluate intersection each request; audit issue/rotate/revoke; test every attenuation. |
| High | Review approval does not bind changed distribution/ACL. | Current receipt binds legacy owner/name/source/capabilities only. | Add immutable release review with schema/capability/distribution digests and guarded terminal decision. |
| High | Audit cannot reconstruct sensitive decisions, or logs secrets/source. | No audit table; receipt actor is email; receipt includes source code. | New source-free append-only audit events with actor/credential/resource context; allowlisted metadata serializer and trigger tests. |
| High | Browser CSRF / reflected CORS weakens employee management routes. | CORS reflects origin; same-origin enforcement is tied to current share-all branch. | Keep explicit same-origin/Fetch Metadata checks for human mutations; CORS is never identity proof. |
| Medium | Documentation claims team/Access behavior that differs from active Worker. | README references principal/team maps not present in current Worker; app UI admits roles/folders are unavailable. | Update docs only alongside shipped behavior; add a deployment configuration conformance test. |
| Medium | Local tests give false confidence because `FakeD1` bypasses SQLite query/triggers. | FakeD1 pattern matches current worker SQL. | Add local real-D1 migration/integration coverage for the new schema; retain focused unit tests for pure authorization functions. |
| Medium | Retrieval and execution/use telemetry are conflated. | `GET /recipe/:name` increments `run_count`; usage uses same fields. | Stop using retrieval counters as run truth in employee mode; audit retrieval and persist caller usage separately. |
| Medium | `/health` is unintentionally public despite an all-API Access requirement. | Worker makes it open and Wrangler route is public custom domain. | Record an explicit approved health-check design before Access enforcement is claimed. |
| Medium | Existing dirty worktree changes obscure review provenance. | 18 tracked files were already modified at audit start. | Keep this plan as a separate documentation-only addition; subsequent implementation must rebase/review against the intended parent changes and preserve unrelated edits. |

## Must-fix sequence

1. Approve the identity, disclosure, Access, retention, and legacy-retirement decisions.
2. Implement JWT-backed actor/workspace authorization and the additive migrations in a disposable environment; do not start with UI work.
3. Replace share-all privilege with role/folder enforcement under a default-off feature flag.
4. Establish pinned workspace source retrieval and correct client/MCP/CLI tool contracts before enabling agents on the new path.
5. Add append-only audit/release evidence and real-D1 migration tests.
6. Perform manifest-verified, collision-reviewed mapping and shadow mode before any Operations cutover.

## Blockers requiring human decisions

1. Approved Cloudflare Access JWT issuer, audience, JWKS validation pattern, and proof every relevant IdP identity has a stable `sub`.
2. The exact Access admission policy, initial workspace admins, and whether groups may later become role/folder subjects.
3. `engineering/reviews` folder membership/disclosure policy for `review_this_mr` and `reviews_todo`.
4. The restricted-resource behavior choice: conceal with `404` or disclose with `403` after authenticated navigation.
5. Credential secret storage, legacy token sunset date, audit retention/redaction policy, and Operations health-check exception/design.
6. An operator-owned D1 backup/export and recovery procedure; this audit intentionally did not access production D1.
