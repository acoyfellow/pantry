import { Hono } from 'hono';
import {
  RecipeError,
  type RecipeRow,
  fullRecipe,
  listEntry,
  validateRecipeInput,
} from './recipe.ts';

export type Env = {
  DB: D1Database;
  // Bearer token. A wrangler secret. NEVER hardcoded, never shipped to a client.
  PANTRY_TOKEN?: string;
  // Optional fixed owner for single-tenant deploys; defaults to the token-derived owner.
  PANTRY_OWNER?: string;
  // Static-site binding. The SAME Worker serves the docs/landing site from
  // ./app/dist for any path the API does not own. Optional so the API logic
  // and its tests run unchanged without an assets binding present.
  APP_ASSETS?: Fetcher;
};

// The API paths this Worker owns. Everything else falls through to the static
// site. Mirrors wrangler `assets.run_worker_first`.
function isApiPath(pathname: string): boolean {
  if (pathname === '/health' || pathname === '/recipes') return true;
  if (pathname.startsWith('/recipes/')) return true;
  if (pathname.startsWith('/recipe/')) return true;
  return false;
}

type Vars = { owner: string };

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

// Bearer-token gate, fail-closed. No token configured => everything 503 (never
// silently open). Wrong/missing token => 401. Constant-time compare.
app.use('*', async (c, next) => {
  const configured = c.env.PANTRY_TOKEN;
  if (!configured) {
    return c.json({ error: 'pantry is not configured: PANTRY_TOKEN missing' }, 503);
  }
  const header = c.req.header('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!presented || !timingSafeEqual(presented, configured)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Owner scoping: a token maps to one owner. Single-tenant by default.
  c.set('owner', (c.env.PANTRY_OWNER ?? 'default').toLowerCase());
  await next();
});

function handleError(error: unknown): Response {
  if (error instanceof RecipeError) {
    const status = error.code === 'NotFound' ? 404 : error.code === 'Conflict' ? 409 : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return Response.json({ error: 'internal error' }, { status: 500 });
}

// POST /recipes — upsert. Bumps version on each push of an existing (owner,name).
app.post('/recipes', async (c) => {
  try {
    const parsed = validateRecipeInput(await c.req.json().catch(() => null));
    const owner = c.get('owner');
    const now = new Date().toISOString();
    const existing = await c.env.DB.prepare(
      'SELECT version, created_at FROM recipes WHERE owner = ? AND name = ?',
    )
      .bind(owner, parsed.name)
      .first<{ version: number; created_at: string }>();

    const version = existing ? existing.version + 1 : 1;
    const createdAt = existing ? existing.created_at : now;
    const id = crypto.randomUUID();

    await c.env.DB.prepare(
      `INSERT INTO recipes (id, owner, name, description, input_schema_json, code, capabilities_json, status, version, source_run_id, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner, name) DO UPDATE SET
         description = excluded.description,
         input_schema_json = excluded.input_schema_json,
         code = excluded.code,
         capabilities_json = excluded.capabilities_json,
         status = excluded.status,
         version = excluded.version,
         source_run_id = excluded.source_run_id,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at`,
    )
      .bind(
        id,
        owner,
        parsed.name,
        parsed.description,
        JSON.stringify(parsed.inputSchema),
        parsed.code,
        JSON.stringify(parsed.capabilities),
        parsed.status,
        version,
        parsed.sourceRunId,
        parsed.visibility,
        createdAt,
        now,
      )
      .run();

    return c.json({ name: parsed.name, version }, existing ? 200 : 201);
  } catch (error) {
    return handleError(error);
  }
});

// GET /recipes — list WITHOUT code. Cheap discovery.
// Default scope is owner-only. ?scope=shared lists opt-in shared recipes from all owners.
app.get('/recipes', async (c) => {
  const owner = c.get('owner');
  const scope = c.req.query('scope');
  if (scope === 'shared') {
    const { results = [] } = await c.env.DB.prepare(
      "SELECT * FROM recipes WHERE visibility = 'shared' ORDER BY updated_at DESC",
    ).all<RecipeRow>();
    return c.json({ recipes: results.map(listEntry) });
  }
  const { results = [] } = await c.env.DB.prepare(
    'SELECT * FROM recipes WHERE owner = ? ORDER BY updated_at DESC',
  )
    .bind(owner)
    .all<RecipeRow>();
  return c.json({ recipes: results.map(listEntry) });
});

// GET /recipe/:name — full recipe INCLUDING code. The fetch a caller runs.
// Resolution is deterministic: your own recipe wins, then the most recently updated shared recipe.
app.get('/recipe/:name', async (c) => {
  const owner = c.get('owner');
  const own = await c.env.DB.prepare('SELECT * FROM recipes WHERE owner = ? AND name = ?')
    .bind(owner, c.req.param('name'))
    .first<RecipeRow>();
  if (own) return c.json(fullRecipe(own));
  const shared = await c.env.DB.prepare(
    "SELECT * FROM recipes WHERE visibility = 'shared' AND name = ? ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(c.req.param('name'))
    .first<RecipeRow>();
  if (!shared) return handleError(new RecipeError('NotFound', 'recipe not found'));
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

export { app, timingSafeEqual, corsHeaders };
