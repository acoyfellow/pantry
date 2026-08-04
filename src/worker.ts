import { Hono } from 'hono';
import {
  RecipeError,
  type RecipeRow,
  fullRecipe,
  lintRecipeCode,
  listEntry,
  recipeSnapshotDigest,
  validateRecipeInput,
} from './recipe.ts';

export type Env = {
  DB: D1Database;
  // Bearer token. A wrangler secret. NEVER hardcoded, never shipped to a client.
  PANTRY_TOKEN?: string;
  // Optional fixed owner for single-tenant deploys; defaults to the token-derived owner.
  PANTRY_OWNER?: string;
  // Optional multi-owner map: a JSON object { "<bearer-token>": "<owner>" }. A
  // wrangler secret. Each token maps to its own owner for a shared multi-owner
  // deployment. When set, tokens here take precedence; PANTRY_TOKEN stays a fallback.
  PANTRY_TOKENS?: string;
  // Static-site binding. The SAME Worker serves the docs/landing site from
  // ./app/dist for any path the API does not own. Optional so the API logic
  // and its tests run unchanged without an assets binding present.
  APP_ASSETS?: Fetcher;
  PANTRY_ACCESS_PRINCIPALS?: string;
  PANTRY_ACCESS_TEAMS?: string;
  PANTRY_ACCESS_IDENTITY_HEADER?: string;
  PANTRY_ACCESS_ONLY?: string;
  // Local development only. When set, an unauthenticated request is treated as
  // this Access identity so the Operations UI can be exercised without an edge
  // session. It must never be configured on a deployed environment.
  PANTRY_DEV_ACCESS_IDENTITY?: string;
};

// The API paths this Worker owns. Everything else falls through to the static
// site. Mirrors wrangler `assets.run_worker_first`.
function isApiPath(pathname: string): boolean {
  if (pathname === '/health' || pathname === '/recipes' || pathname.startsWith('/api/'))
    return true;
  if (pathname.startsWith('/recipes/')) return true;
  if (pathname.startsWith('/recipe/')) return true;
  return false;
}

type AgentScope = 'recipes:read' | 'recipes:write' | 'usage:report';
type AuthKind = 'access' | 'agent' | 'legacy';
type Vars = {
  owner: string;
  accessIdentity?: string;
  teamId?: string;
  teamRole?: TeamRole;
  authKind?: AuthKind;
  agentScopes?: AgentScope[];
};
type TeamRole = 'owner' | 'approver' | 'member';

type AgentCredentialRow = {
  id: string;
  team_id: string;
  principal: string;
  owner_principal: string;
  scopes_json: string;
};

const agentScopes: AgentScope[] = ['recipes:read', 'recipes:write', 'usage:report'];

// Parse the optional PANTRY_TOKENS JSON map into [token, owner] pairs. Returns
// null when unset/empty/malformed so the single-token path remains the fallback.
function parseTokenMap(raw: string | undefined): Array<[string, string]> | null {
  if (!raw?.trim()) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const pairs = Object.entries(obj)
      .filter(([token, owner]) => token && typeof owner === 'string' && owner.trim())
      .map(([token, owner]) => [token, (owner as string).toLowerCase()] as [string, string]);
    return pairs.length ? pairs : null;
  } catch {
    return null;
  }
}

// Constant-time string compare. Avoids leaking token length/prefix via timing.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare a fixed-length digest so length differences do not short-circuit.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function parseAccessPrincipals(raw: string | undefined): Map<string, string> | null {
  if (!raw?.trim()) return null;
  try {
    const entries = Object.entries(JSON.parse(raw) as Record<string, unknown>).filter(
      ([identity, principal]) =>
        identity.trim() &&
        identity.length <= 320 &&
        typeof principal === 'string' &&
        principal.trim() &&
        principal.length <= 128,
    );
    return new Map(
      entries.map(([identity, principal]) => [
        identity.toLowerCase(),
        (principal as string).toLowerCase(),
      ]),
    );
  } catch {
    return new Map();
  }
}

function parseAccessTeams(raw: string | undefined): Map<string, string> | null {
  if (!raw?.trim()) return null;
  try {
    const entries = Object.entries(JSON.parse(raw) as Record<string, unknown>).filter(
      ([principal, teamId]) =>
        principal.trim() &&
        principal.length <= 128 &&
        typeof teamId === 'string' &&
        teamId.trim() &&
        teamId.length <= 128,
    );
    return new Map(
      entries.map(([principal, teamId]) => [
        principal.toLowerCase(),
        (teamId as string).toLowerCase(),
      ]),
    );
  } catch {
    return new Map();
  }
}

type TeamMemberRow = {
  team_id: string;
  role: TeamRole;
};

async function requireAccessTeamMember(
  c: {
    env: Env;
    get: <K extends keyof Vars>(key: K) => Vars[K];
    set: <K extends keyof Vars>(key: K, value: Vars[K]) => void;
    json: (object: unknown, status?: number) => Response;
  },
  accessRequired = false,
): Promise<Response | TeamMemberRow | null> {
  const identity = c.get('accessIdentity');
  if (!identity)
    return accessRequired ? c.json({ error: 'Cloudflare Access session required' }, 401) : null;
  const teams = parseAccessTeams(c.env.PANTRY_ACCESS_TEAMS);
  if (!teams || teams.size === 0)
    return c.json({ error: 'pantry Access team mapping is not configured' }, 503);
  const teamId = teams.get(c.get('owner').toLowerCase());
  if (!teamId) return c.json({ error: 'team membership required' }, 403);
  const membership = await c.env.DB.prepare(
    'SELECT team_id, role FROM team_members WHERE team_id = ? AND principal = ?',
  )
    .bind(teamId, c.get('owner'))
    .first<TeamMemberRow>();
  if (!membership || !['owner', 'approver', 'member'].includes(membership.role)) {
    return c.json({ error: 'team membership required' }, 403);
  }
  c.set('teamId', membership.team_id);
  c.set('teamRole', membership.role);
  return membership;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === null || origin === new URL(request.url).origin;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseAgentScopes(value: unknown): AgentScope[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > agentScopes.length) return null;
  const scopes = value.filter(
    (scope): scope is AgentScope =>
      typeof scope === 'string' && agentScopes.includes(scope as AgentScope),
  );
  return scopes.length === value.length && new Set(scopes).size === scopes.length ? scopes : null;
}

function agentScopeForRequest(request: Request): AgentScope | null {
  const pathname = new URL(request.url).pathname;
  if (request.method === 'GET' && (pathname === '/recipes' || pathname.startsWith('/recipe/')))
    return 'recipes:read';
  if (request.method === 'POST' && pathname === '/recipes') return 'recipes:write';
  if (request.method === 'POST' && pathname.endsWith('/attestations')) return 'recipes:write';
  if (request.method === 'DELETE' && pathname.startsWith('/recipe/')) return 'recipes:write';
  if (request.method === 'POST' && pathname.endsWith('/usage')) return 'usage:report';
  return null;
}

function isAgentManagementPath(pathname: string): boolean {
  return (
    pathname === '/api/session' ||
    pathname.startsWith('/api/') ||
    /\/approval(?:-diff)?s?$/.test(pathname)
  );
}

// Echo the request origin so browser/webview callers work, while never using
// the wildcard with credentials. Applied to EVERY response (learned from pulse).
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// CORS on every response.
app.use('*', async (c, next) => {
  await next();
  const headers = corsHeaders(c.req.header('origin') ?? null);
  for (const [key, value] of Object.entries(headers)) c.header(key, value);
});

// Answer OPTIONS preflight with 204 BEFORE the auth gate (pulse lesson:
// browsers send preflight without the Authorization header).
app.options('*', (c) => {
  const headers = corsHeaders(c.req.header('origin') ?? null);
  return new Response(null, { status: 204, headers });
});

// Health is open (no auth) so uptime checks do not need the secret.
app.get('/health', (c) => c.json({ ok: true, service: 'pantry' }));

app.use('*', async (c, next) => {
  const accessPrincipals = parseAccessPrincipals(c.env.PANTRY_ACCESS_PRINCIPALS);
  const accessHeader =
    c.env.PANTRY_ACCESS_IDENTITY_HEADER?.trim() || 'cf-access-authenticated-user-email';
  const accessIdentity =
    c.req.header(accessHeader)?.trim().toLowerCase() ||
    c.env.PANTRY_DEV_ACCESS_IDENTITY?.trim().toLowerCase();
  if (accessIdentity) {
    if (!accessPrincipals || accessPrincipals.size === 0) {
      return c.json({ error: 'pantry Access identity is not configured' }, 503);
    }
    const owner = accessPrincipals.get(accessIdentity);
    if (!owner) return c.json({ error: 'unauthorized' }, 401);
    if (!isSameOrigin(c.req.raw))
      return c.json({ error: 'management requests must be same-origin' }, 403);
    c.set('owner', owner);
    c.set('accessIdentity', accessIdentity);
    c.set('authKind', 'access');
    await next();
    return;
  }

  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (presented) {
    const credential = await c.env.DB.prepare(
      'SELECT c.id, c.team_id, i.principal, i.owner_principal, c.scopes_json FROM agent_credentials c JOIN agent_identities i ON i.id = c.agent_identity_id WHERE c.credential_hash = ? AND c.revoked_at IS NULL AND i.revoked_at IS NULL',
    )
      .bind(await sha256(presented))
      .first<AgentCredentialRow>();
    if (credential) {
      let scopes: AgentScope[] | null = null;
      try {
        scopes = parseAgentScopes(JSON.parse(credential.scopes_json));
      } catch {
        scopes = null;
      }
      if (!scopes) return c.json({ error: 'invalid agent credential scopes' }, 403);
      c.set('owner', credential.owner_principal);
      c.set('teamId', credential.team_id);
      c.set('authKind', 'agent');
      c.set('agentScopes', scopes);
      await next();
      return;
    }
  }

  if (c.env.PANTRY_ACCESS_ONLY === 'true') {
    return c.json({ error: 'Cloudflare Access session required' }, 401);
  }

  const single = c.env.PANTRY_TOKEN;
  const multi = parseTokenMap(c.env.PANTRY_TOKENS);
  let owner: string | null = null;
  if (multi) {
    for (const [token, mappedOwner] of multi) {
      if (presented && timingSafeEqual(presented, token)) owner = mappedOwner;
    }
  }
  if (owner === null && single && presented && timingSafeEqual(presented, single)) {
    owner = (c.env.PANTRY_OWNER ?? 'default').toLowerCase();
  }
  if (owner === null) {
    if (!single && !multi && !accessPrincipals)
      return c.json(
        { error: 'pantry is not configured: agent credentials or explicit legacy tokens required' },
        503,
      );
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('owner', owner);
  c.set('authKind', 'legacy');
  await next();
});

app.use('*', async (c, next) => {
  if (c.get('authKind') === 'agent') {
    const pathname = new URL(c.req.url).pathname;
    if (isAgentManagementPath(pathname))
      return c.json({ error: 'agent credentials cannot access management routes' }, 403);
    const requiredScope = agentScopeForRequest(c.req.raw);
    if (!requiredScope || !c.get('agentScopes')?.includes(requiredScope)) {
      return c.json({ error: 'agent credential scope does not permit this request' }, 403);
    }
  }
  await next();
});

function handleError(error: unknown): Response {
  if (error instanceof RecipeError) {
    const status = error.code === 'NotFound' ? 404 : error.code === 'Conflict' ? 409 : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return Response.json({ error: 'internal error' }, { status: 500 });
}

type RecipeVersionRow = {
  version: number;
  created_at: string;
  capabilities_json: string;
};

type ApprovalRow = {
  id: string;
  owner: string;
  recipe_name: string;
  recipe_version: number;
  recipe_digest: string;
  action: string;
  reason: string | null;
  actor: string;
  source_code: string;
  capabilities_json: string;
  created_at: string;
  receipt_digest: string;
};

type RecipeSubjectRow = {
  owner: string;
  name: string;
  version: number;
  recipe_digest: string | null;
};

type RecipeAttestationRow = {
  owner: string;
  recipe_name: string;
  recipe_version: number;
  recipe_digest: string;
  witness_receipt_sha256: string;
  created_at: string;
};

const PUSH_RETRY_ATTEMPTS = 4;

async function persistRecipe(
  db: D1Database,
  owner: string,
  recipe: ReturnType<typeof validateRecipeInput>,
): Promise<{ created: boolean; version: number; recipeDigest: string }> {
  for (let attempt = 0; attempt < PUSH_RETRY_ATTEMPTS; attempt++) {
    const existing = await db
      .prepare(
        'SELECT version, created_at, capabilities_json FROM recipes WHERE owner = ? AND name = ?',
      )
      .bind(owner, recipe.name)
      .first<RecipeVersionRow>();
    const now = new Date().toISOString();
    const version = (existing?.version ?? 0) + 1;
    const recipeDigest = await recipeSnapshotDigest(owner, recipe, version);
    const capabilitiesJson = JSON.stringify(recipe.capabilities);
    const status = 'pending';
    const [current, history] = await db.batch([
      db
        .prepare(
          `INSERT INTO recipes (id, owner, name, description, input_schema_json, code, capabilities_json, status, version, source_run_id, visibility, tags_json, run_count, last_run_at, recipe_digest, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner, name) DO UPDATE SET
             description = excluded.description,
             input_schema_json = excluded.input_schema_json,
             code = excluded.code,
             capabilities_json = excluded.capabilities_json,
             status = excluded.status,
             version = excluded.version,
             source_run_id = excluded.source_run_id,
             visibility = excluded.visibility,
             tags_json = excluded.tags_json,
             recipe_digest = excluded.recipe_digest,
             approved_version = CASE WHEN excluded.status = 'pending' THEN NULL ELSE recipes.approved_version END,
             approved_digest = CASE WHEN excluded.status = 'pending' THEN NULL ELSE recipes.approved_digest END,
             reviewed_version = CASE WHEN excluded.status = 'pending' THEN NULL ELSE recipes.reviewed_version END,
             reviewed_digest = CASE WHEN excluded.status = 'pending' THEN NULL ELSE recipes.reviewed_digest END,
             updated_at = excluded.updated_at
           WHERE recipes.version = ?`,
        )
        .bind(
          crypto.randomUUID(),
          owner,
          recipe.name,
          recipe.description,
          JSON.stringify(recipe.inputSchema),
          recipe.code,
          capabilitiesJson,
          status,
          version,
          recipe.sourceRunId,
          recipe.visibility,
          JSON.stringify(recipe.tags ?? []),
          0,
          null,
          recipeDigest,
          existing?.created_at ?? now,
          now,
          existing?.version ?? 0,
        ),
      db
        .prepare(
          `INSERT INTO recipe_versions (owner, recipe_name, recipe_version, recipe_digest, description, input_schema_json, code, capabilities_json, source_run_id, visibility, tags_json, created_at)
           SELECT owner, name, version, recipe_digest, description, input_schema_json, code, capabilities_json, source_run_id, visibility, tags_json, ?
           FROM recipes
           WHERE owner = ? AND name = ? AND version = ? AND recipe_digest = ?`,
        )
        .bind(now, owner, recipe.name, version, recipeDigest),
    ]);
    if ((current.meta?.changes ?? 0) > 0 && (history.meta?.changes ?? 0) > 0) {
      return { created: !existing, version, recipeDigest };
    }
  }
  throw new RecipeError('Conflict', 'recipe changed concurrently; retry push');
}

function attestationEntry(row: RecipeAttestationRow) {
  return {
    owner: row.owner,
    name: row.recipe_name,
    version: row.recipe_version,
    recipeDigest: row.recipe_digest,
    witnessReceiptSha256: row.witness_receipt_sha256,
    createdAt: row.created_at,
  };
}

app.post('/recipes', async (c) => {
  try {
    const parsed = validateRecipeInput(await c.req.json().catch(() => null));
    const warnings = lintRecipeCode(parsed.code);
    if (warnings.length && c.req.query('strict') === '1') {
      return c.json({ error: 'recipe failed strict lint', code: 'LintFailed', warnings }, 422);
    }
    const saved = await persistRecipe(c.env.DB, c.get('owner'), parsed);
    return c.json(
      {
        name: parsed.name,
        version: saved.version,
        recipeDigest: saved.recipeDigest,
        ...(warnings.length ? { warnings } : {}),
      },
      saved.created ? 201 : 200,
    );
  } catch (error) {
    return handleError(error);
  }
});

app.post('/recipe/:name/attestations', async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const permitted = ['version', 'recipeDigest', 'witnessReceiptSha256'];
    if (
      !body ||
      Object.keys(body).some((key) => !permitted.includes(key)) ||
      !Number.isInteger(body.version) ||
      Number(body.version) < 1 ||
      typeof body.recipeDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.recipeDigest) ||
      typeof body.witnessReceiptSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.witnessReceiptSha256)
    ) {
      return handleError(new RecipeError('InvalidInput', 'invalid attestation metadata'));
    }
    const { version, recipeDigest, witnessReceiptSha256 } = body as {
      version: number;
      recipeDigest: string;
      witnessReceiptSha256: string;
    };
    const owner = c.get('owner');
    const name = c.req.param('name');
    const now = new Date().toISOString();
    const inserted = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO recipe_attestations
           (id, owner, recipe_name, recipe_version, recipe_digest, witness_receipt_sha256, created_at)
         SELECT ?, owner, name, version, recipe_digest, ?, ?
         FROM recipes
         WHERE owner = ? AND name = ? AND version = ? AND recipe_digest = ?`,
    )
      .bind(crypto.randomUUID(), witnessReceiptSha256, now, owner, name, version, recipeDigest)
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) {
      return c.json(
        attestationEntry({
          owner,
          recipe_name: name,
          recipe_version: version,
          recipe_digest: recipeDigest,
          witness_receipt_sha256: witnessReceiptSha256,
          created_at: now,
        }),
        201,
      );
    }
    const subject = await c.env.DB.prepare(
      'SELECT owner, name, version, recipe_digest FROM recipes WHERE owner = ? AND name = ?',
    )
      .bind(owner, name)
      .first<RecipeSubjectRow>();
    if (!subject) return handleError(new RecipeError('NotFound', 'recipe not found'));
    if (subject.version !== version || subject.recipe_digest !== recipeDigest) {
      return handleError(new RecipeError('Conflict', 'attestation subject is not current'));
    }
    const existing = await c.env.DB.prepare(
      'SELECT owner, recipe_name, recipe_version, recipe_digest, witness_receipt_sha256, created_at FROM recipe_attestations WHERE witness_receipt_sha256 = ?',
    )
      .bind(witnessReceiptSha256)
      .first<RecipeAttestationRow>();
    if (
      !existing ||
      existing.owner !== owner ||
      existing.recipe_name !== name ||
      existing.recipe_version !== version ||
      existing.recipe_digest !== recipeDigest
    ) {
      return handleError(
        new RecipeError('Conflict', 'receipt is already bound to another subject'),
      );
    }
    return c.json(attestationEntry(existing), 200);
  } catch (error) {
    return handleError(error);
  }
});

app.get('/recipe/:name/attestations', async (c) => {
  const version = Number(c.req.query('version'));
  const recipeDigest = c.req.query('recipeDigest') ?? '';
  if (!Number.isInteger(version) || version < 1 || !/^[a-f0-9]{64}$/.test(recipeDigest)) {
    return handleError(new RecipeError('InvalidInput', 'version and recipeDigest are required'));
  }
  const owner = c.get('owner');
  const name = c.req.param('name');
  const subject = await c.env.DB.prepare(
    'SELECT owner, name, version, recipe_digest FROM recipes WHERE owner = ? AND name = ? AND version = ? AND recipe_digest = ?',
  )
    .bind(owner, name, version, recipeDigest)
    .first<RecipeSubjectRow>();
  if (!subject) return handleError(new RecipeError('NotFound', 'attestation subject not found'));
  const { results = [] } = await c.env.DB.prepare(
    'SELECT owner, recipe_name, recipe_version, recipe_digest, witness_receipt_sha256, created_at FROM recipe_attestations WHERE owner = ? AND recipe_name = ? AND recipe_version = ? AND recipe_digest = ?',
  )
    .bind(owner, name, version, recipeDigest)
    .all<RecipeAttestationRow>();
  return c.json({ attestations: results.map(attestationEntry) });
});

// GET /recipes — list WITHOUT code. Cheap discovery.
// Default scope is owner-only. ?scope=shared lists opt-in shared recipes from all owners.
// ?q= filters by keyword over name+description; ?capability= filters by a capability tag;
// ?tag= filters an exact discovery namespace such as mr/review.
// Filters keep discovery cost bounded by relevance, not cookbook size.
app.get('/recipes', async (c) => {
  const owner = c.get('owner');
  const requestedScope = c.req.query('scope');
  if (requestedScope && requestedScope !== 'owner' && requestedScope !== 'shared') {
    return handleError(new RecipeError('InvalidInput', 'scope must be owner or shared'));
  }
  const scope = requestedScope ?? 'owner';
  const q = c.req.query('q')?.trim().toLowerCase();
  const capability = c.req.query('capability')?.trim();
  const tag = c.req.query('tag')?.trim().toLowerCase();
  if (tag && tag.length > 96)
    return handleError(new RecipeError('InvalidInput', 'tag filter is too long'));
  const sql =
    scope === 'shared'
      ? "SELECT * FROM recipes WHERE visibility = 'shared' ORDER BY updated_at DESC"
      : 'SELECT * FROM recipes WHERE owner = ? ORDER BY updated_at DESC';
  const stmt = scope === 'shared' ? c.env.DB.prepare(sql) : c.env.DB.prepare(sql).bind(owner);
  const { results = [] } = await stmt.all<RecipeRow>();
  let filtered = results;
  if (q) {
    filtered = filtered.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q),
    );
  }
  if (capability) {
    filtered = filtered.filter((r) => {
      try {
        return (JSON.parse(r.capabilities_json) as string[]).includes(capability);
      } catch {
        return false;
      }
    });
  }
  if (tag) {
    filtered = filtered.filter((r) => {
      try {
        return (JSON.parse(r.tags_json ?? '[]') as string[]).includes(tag);
      } catch {
        return false;
      }
    });
  }
  return c.json({ scope, recipes: filtered.map(listEntry) });
});

async function approvalReceiptDigest(input: {
  owner: string;
  name: string;
  version: number;
  recipeDigest: string;
  action: string;
  reason: string | null;
  actor: string;
  sourceCode: string;
  capabilitiesJson: string;
  createdAt: string;
}): Promise<string> {
  const payload = JSON.stringify(input, Object.keys(input).sort());
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function approvalEntry(row: ApprovalRow) {
  return {
    id: row.id,
    owner: row.owner,
    name: row.recipe_name,
    version: row.recipe_version,
    recipeDigest: row.recipe_digest,
    action: row.action,
    reason: row.reason,
    actor: row.actor,
    sourceCode: row.source_code,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    createdAt: row.created_at,
    receiptDigest: row.receipt_digest,
  };
}

async function requireCredentialManager(c: {
  env: Env;
  get: <K extends keyof Vars>(key: K) => Vars[K];
  set: <K extends keyof Vars>(key: K, value: Vars[K]) => void;
  json: (object: unknown, status?: number) => Response;
}): Promise<Response | TeamMemberRow> {
  const membership = await requireAccessTeamMember(c, true);
  if (membership instanceof Response) return membership;
  if (!membership || (membership.role !== 'owner' && membership.role !== 'approver')) {
    return c.json({ error: 'team approver or owner role required' }, 403);
  }
  return membership;
}

async function createAgentCredential(
  db: D1Database,
  teamId: string,
  owner: string,
  principal: string,
  scopes: AgentScope[],
) {
  const identityId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const credential = `pantry_agent_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO agent_identities (id, team_id, principal, owner_principal, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
    )
    .bind(identityId, teamId, principal, owner, now)
    .run();
  await db
    .prepare(
      'INSERT INTO agent_credentials (id, agent_identity_id, team_id, credential_hash, scopes_json, created_at, revoked_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
    )
    .bind(credentialId, identityId, teamId, await sha256(credential), JSON.stringify(scopes), now)
    .run();
  return { id: credentialId, credential, createdAt: now };
}

app.post('/api/agent-credentials', async (c) => {
  const manager = await requireCredentialManager(c);
  if (manager instanceof Response) return manager;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const principal = typeof body?.principal === 'string' ? body.principal.trim().toLowerCase() : '';
  const scopes = parseAgentScopes(body?.scopes);
  if (
    !principal ||
    principal.length > 128 ||
    !scopes ||
    Object.keys(body ?? {}).some((key) => key !== 'principal' && key !== 'scopes')
  ) {
    return c.json({ error: 'principal and a non-empty valid scopes array are required' }, 400);
  }
  const created = await createAgentCredential(
    c.env.DB,
    manager.team_id,
    c.get('owner'),
    principal,
    scopes,
  );
  return c.json(
    {
      id: created.id,
      principal,
      team: manager.team_id,
      scopes,
      createdAt: created.createdAt,
      credential: created.credential,
    },
    201,
  );
});

app.post('/api/agent-credentials/:id/rotate', async (c) => {
  const manager = await requireCredentialManager(c);
  if (manager instanceof Response) return manager;
  const current = await c.env.DB.prepare(
    'SELECT c.id, c.team_id, i.principal, i.owner_principal, c.scopes_json FROM agent_credentials c JOIN agent_identities i ON i.id = c.agent_identity_id WHERE c.id = ? AND c.team_id = ? AND c.revoked_at IS NULL AND i.revoked_at IS NULL',
  )
    .bind(c.req.param('id'), manager.team_id)
    .first<AgentCredentialRow>();
  if (!current) return c.json({ error: 'agent credential not found' }, 404);
  const credential = `pantry_agent_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const replacementId = crypto.randomUUID();
  const updated = await c.env.DB.prepare(
    'UPDATE agent_credentials SET revoked_at = ?, rotated_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL',
  )
    .bind(now, now, current.id, manager.team_id)
    .run();
  if ((updated.meta?.changes ?? 0) !== 1)
    return c.json({ error: 'agent credential was already rotated or revoked' }, 409);
  await c.env.DB.prepare(
    'INSERT INTO agent_credentials (id, agent_identity_id, team_id, credential_hash, scopes_json, created_at, revoked_at, rotated_at) SELECT ?, agent_identity_id, team_id, ?, scopes_json, ?, NULL, NULL FROM agent_credentials WHERE id = ?',
  )
    .bind(replacementId, await sha256(credential), now, current.id)
    .run();
  return c.json({
    id: replacementId,
    principal: current.principal,
    team: current.team_id,
    scopes: JSON.parse(current.scopes_json),
    createdAt: now,
    credential,
  });
});

app.delete('/api/agent-credentials/:id', async (c) => {
  const manager = await requireCredentialManager(c);
  if (manager instanceof Response) return manager;
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    'UPDATE agent_credentials SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL',
  )
    .bind(now, c.req.param('id'), manager.team_id)
    .run();
  if ((result.meta?.changes ?? 0) !== 1)
    return c.json({ error: 'agent credential not found or already revoked' }, 404);
  return c.json({ revoked: true, id: c.req.param('id'), revokedAt: now });
});

app.get('/api/session', async (c) => {
  const membership = await requireAccessTeamMember(c, true);
  if (membership instanceof Response) return membership;
  if (!membership) return c.json({ error: 'Cloudflare Access session required' }, 401);
  return c.json({ principal: c.get('owner'), team: membership.team_id, role: membership.role });
});

app.get('/api/approvals', async (c) => {
  const membership = await requireAccessTeamMember(c);
  if (membership instanceof Response) return membership;
  const rows = await c.env.DB.prepare(
    "SELECT * FROM recipes WHERE owner = ? AND status = 'pending' AND reviewed_version IS NULL AND reviewed_digest IS NULL ORDER BY updated_at DESC",
  )
    .bind(c.get('owner'))
    .all<RecipeRow>();
  return c.json({ recipes: (rows.results ?? []).map(listEntry) });
});

app.get('/recipe/:name/approval-diff', async (c) => {
  const membership = await requireAccessTeamMember(c);
  if (membership instanceof Response) return membership;
  const owner = c.get('owner');
  const recipe = await c.env.DB.prepare('SELECT * FROM recipes WHERE owner = ? AND name = ?')
    .bind(owner, c.req.param('name'))
    .first<RecipeRow>();
  if (!recipe) return handleError(new RecipeError('NotFound', 'recipe not found'));
  const previous = await c.env.DB.prepare(
    'SELECT * FROM recipe_approval_receipts WHERE owner = ? AND recipe_name = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(owner, recipe.name)
    .first<ApprovalRow>();
  return c.json({
    current: fullRecipe(recipe),
    previous: previous ? approvalEntry(previous) : null,
    sourceChanged: previous ? previous.source_code !== recipe.code : true,
    capabilitiesChanged: previous ? previous.capabilities_json !== recipe.capabilities_json : true,
  });
});

app.post('/recipe/:name/approval', async (c) => {
  if (c.get('authKind') !== 'access')
    return c.json({ error: 'Cloudflare Access session required for approvals' }, 403);
  const membership = await requireAccessTeamMember(c, true);
  if (membership instanceof Response) return membership;
  if (membership && membership.role !== 'owner' && membership.role !== 'approver') {
    return c.json({ error: 'team approver or owner role required' }, 403);
  }
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const action = typeof body?.action === 'string' ? body.action : '';
    const version = body?.version;
    const recipeDigest = typeof body?.recipeDigest === 'string' ? body.recipeDigest : '';
    if (!['approve', 'reject', 'request-revision'].includes(action)) {
      return handleError(
        new RecipeError('InvalidInput', 'action must be approve, reject, or request-revision'),
      );
    }
    if (!Number.isInteger(version) || Number(version) < 1 || !/^[a-f0-9]{64}$/.test(recipeDigest)) {
      return handleError(new RecipeError('InvalidInput', 'version and recipeDigest are required'));
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : null;
    if ((action !== 'approve' && !reason) || (reason && reason.length > 1000)) {
      return handleError(
        new RecipeError(
          'InvalidInput',
          'a reason is required unless approving and must be <= 1000 characters',
        ),
      );
    }
    const owner = c.get('owner');
    const recipe = await c.env.DB.prepare('SELECT * FROM recipes WHERE owner = ? AND name = ?')
      .bind(owner, c.req.param('name'))
      .first<RecipeRow>();
    if (!recipe) return handleError(new RecipeError('NotFound', 'recipe not found'));
    if (
      recipe.status !== 'pending' ||
      recipe.reviewed_version != null ||
      recipe.reviewed_digest != null
    ) {
      return handleError(
        new RecipeError('Conflict', 'only an undecided pending recipe can be reviewed'),
      );
    }
    if (recipe.version !== version || recipe.recipe_digest !== recipeDigest) {
      return handleError(new RecipeError('Conflict', 'approval subject is stale'));
    }
    const createdAt = new Date().toISOString();
    const actor = c.get('accessIdentity') ?? owner;
    const receiptDigest = await approvalReceiptDigest({
      owner,
      name: recipe.name,
      version,
      recipeDigest,
      action,
      reason,
      actor,
      sourceCode: recipe.code,
      capabilitiesJson: recipe.capabilities_json,
      createdAt,
    });
    const receiptId = crypto.randomUUID();
    const nextStatus =
      action === 'approve' ? 'enabled' : action === 'reject' ? 'rejected' : 'pending';
    const approvedVersion = action === 'approve' ? version : null;
    const approvedDigest = action === 'approve' ? recipeDigest : null;
    const [receipt, updated] = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO recipe_approval_receipts (id, owner, recipe_name, recipe_version, recipe_digest, action, reason, actor, source_code, capabilities_json, created_at, receipt_digest)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM recipes
             WHERE owner = ? AND name = ? AND version = ? AND recipe_digest = ?
               AND status = 'pending' AND reviewed_version IS NULL AND reviewed_digest IS NULL
           )`,
      ).bind(
        receiptId,
        owner,
        recipe.name,
        version,
        recipeDigest,
        action,
        reason,
        actor,
        recipe.code,
        recipe.capabilities_json,
        createdAt,
        receiptDigest,
        owner,
        recipe.name,
        version,
        recipeDigest,
      ),
      c.env.DB.prepare(
        `UPDATE recipes
           SET status = ?, approved_version = ?, approved_digest = ?, reviewed_version = ?, reviewed_digest = ?
           WHERE owner = ? AND name = ? AND version = ? AND recipe_digest = ?
             AND status = 'pending' AND reviewed_version IS NULL AND reviewed_digest IS NULL`,
      ).bind(
        nextStatus,
        approvedVersion,
        approvedDigest,
        version,
        recipeDigest,
        owner,
        recipe.name,
        version,
        recipeDigest,
      ),
    ]);
    if ((receipt.meta?.changes ?? 0) !== 1 || (updated.meta?.changes ?? 0) !== 1) {
      return handleError(
        new RecipeError('Conflict', 'approval subject changed before the decision was recorded'),
      );
    }
    return c.json({
      recipe: listEntry({
        ...recipe,
        status: nextStatus,
        approved_version: approvedVersion,
        approved_digest: approvedDigest,
        reviewed_version: version,
        reviewed_digest: recipeDigest,
      }),
      receipt: { id: receiptId, digest: receiptDigest, action, version },
    });
  } catch (error) {
    return handleError(error);
  }
});

app.get('/recipe/:name/approvals', async (c) => {
  const membership = await requireAccessTeamMember(c);
  if (membership instanceof Response) return membership;
  const rows = await c.env.DB.prepare(
    'SELECT * FROM recipe_approval_receipts WHERE owner = ? AND recipe_name = ? ORDER BY created_at DESC',
  )
    .bind(c.get('owner'), c.req.param('name'))
    .all<ApprovalRow>();
  return c.json({ receipts: (rows.results ?? []).map(approvalEntry) });
});

// POST /recipe/:name/usage — caller-reported successful use, never execution by Pantry.
// A private recipe is reportable only by its owner; a shared recipe is reportable by
// any authenticated recipient. eventId makes retries idempotent. Reports carry no code.
app.post('/recipe/:name/usage', async (c) => {
  try {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const eventId = typeof body?.eventId === 'string' ? body.eventId.trim() : '';
    const version = body?.version;
    if (!eventId || eventId.length > 128 || !Number.isInteger(version) || Number(version) < 1) {
      return handleError(
        new RecipeError('InvalidInput', 'eventId and positive integer version are required'),
      );
    }
    if (body?.outcome !== 'success') {
      return handleError(new RecipeError('InvalidInput', 'usage outcome must be success'));
    }
    const owner = c.get('owner');
    const recipe = await c.env.DB.prepare('SELECT * FROM recipes WHERE owner = ? AND name = ?')
      .bind(owner, c.req.param('name'))
      .first<RecipeRow>();
    const shared = recipe
      ? null
      : await c.env.DB.prepare(
          "SELECT * FROM recipes WHERE visibility = 'shared' AND name = ? ORDER BY updated_at DESC LIMIT 1",
        )
          .bind(c.req.param('name'))
          .first<RecipeRow>();
    const target = recipe ?? shared;
    if (!target || target.version !== Number(version)) {
      return handleError(new RecipeError('NotFound', 'recipe not found'));
    }
    const reportedAt = new Date().toISOString();
    const inserted = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO recipe_usage_reports (id, owner, recipe_name, reporter, version, reported_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(eventId, target.owner, target.name, owner, target.version, reportedAt)
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) {
      await c.env.DB.prepare(
        'UPDATE recipes SET run_count = run_count + 1, last_run_at = ? WHERE owner = ? AND name = ?',
      )
        .bind(reportedAt, target.owner, target.name)
        .run();
    }
    const updated = await c.env.DB.prepare('SELECT * FROM recipes WHERE owner = ? AND name = ?')
      .bind(target.owner, target.name)
      .first<RecipeRow>();
    return c.json({
      recorded: (inserted.meta?.changes ?? 0) > 0,
      runCount: updated?.run_count ?? target.run_count ?? 0,
      lastRunAt: updated?.last_run_at ?? target.last_run_at ?? null,
    });
  } catch (error) {
    return handleError(error);
  }
});

// GET /recipe/:name — full recipe INCLUDING code. The fetch a caller runs.
// Resolution is deterministic: your own recipe wins, then the most recently updated shared recipe.
app.get('/recipe/:name', async (c) => {
  const owner = c.get('owner');
  const requestedVersion = c.req.query('version');
  const own = await c.env.DB.prepare('SELECT * FROM recipes WHERE owner = ? AND name = ?')
    .bind(owner, c.req.param('name'))
    .first<RecipeRow>();
  if (own) {
    const approvalEnforced =
      own.approved_version !== undefined || own.approved_digest !== undefined;
    if (
      (approvalEnforced && own.status !== 'enabled') ||
      (approvalEnforced &&
        (!Number.isInteger(own.approved_version) ||
          own.approved_version !== own.version ||
          own.approved_digest !== own.recipe_digest)) ||
      (requestedVersion !== undefined && Number(requestedVersion) !== own.version)
    ) {
      return handleError(new RecipeError('Conflict', 'recipe is not an approved enabled version'));
    }
    return c.json(fullRecipe(own));
  }
  const shared = await c.env.DB.prepare(
    "SELECT * FROM recipes WHERE visibility = 'shared' AND name = ? ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(c.req.param('name'))
    .first<RecipeRow>();
  if (!shared) return handleError(new RecipeError('NotFound', 'recipe not found'));
  const sharedApprovalEnforced =
    shared.approved_version !== undefined || shared.approved_digest !== undefined;
  if (
    (sharedApprovalEnforced && shared.status !== 'enabled') ||
    (sharedApprovalEnforced &&
      (!Number.isInteger(shared.approved_version) ||
        shared.approved_version !== shared.version ||
        shared.approved_digest !== shared.recipe_digest)) ||
    (requestedVersion !== undefined && Number(requestedVersion) !== shared.version)
  ) {
    return handleError(new RecipeError('Conflict', 'recipe is not an approved enabled version'));
  }
  return c.json(fullRecipe(shared));
});

// DELETE /recipe/:name — owner-scoped delete.
app.delete('/recipe/:name', async (c) => {
  const owner = c.get('owner');
  const result = await c.env.DB.prepare('DELETE FROM recipes WHERE owner = ? AND name = ?')
    .bind(owner, c.req.param('name'))
    .run();
  if ((result.meta?.changes ?? 0) === 0) {
    return handleError(new RecipeError('NotFound', 'recipe not found'));
  }
  return c.json({ deleted: true, name: c.req.param('name') });
});

// ONE Worker, two surfaces. API paths run the Hono app (auth/CORS/D1 unchanged);
// every other path falls through to the static docs/landing site in ./app/dist.
// OPTIONS preflight still reaches Hono so CORS is answered before the auth gate.
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' || isApiPath(url.pathname)) {
      return app.fetch(request, env, ctx);
    }
    if (env.APP_ASSETS) return env.APP_ASSETS.fetch(request);
    // No assets binding (e.g. local API-only run): let Hono answer.
    return app.fetch(request, env, ctx);
  },
};

export { app, timingSafeEqual, corsHeaders, parseAccessPrincipals, parseAccessTeams, isSameOrigin };
