<img src=".github/assets/hero.jpg" alt="Glowing amber jars on a dark shelf" width="100%" />

# pantry

<p align="center">
  <strong>A harness-agnostic shelf for exact saved code.</strong><br />
  Pi, OpenCode, your own orchestrator or agent, curl, and a plain Worker can fetch the same recipe; pantry never runs it.
</p>

<p align="center">
  <a href="https://pantry.coey.dev">Live</a> &middot;
  <a href="https://pantry.coey.dev/docs">Docs</a> &middot;
  <a href="https://pantry.coey.dev/proof">Proof</a>
</p>

<p align="center">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?logo=cloudflare&logoColor=white" />
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun-000?logo=bun&logoColor=white" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-bun%20test-3fb950" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

> pantry is a durable, harness-agnostic shelf for recipes. A recipe is a named function with an input schema, capability tags, status, version, and owner provenance. pantry stores the source in D1 and hands it back on request. It never runs a recipe; the caller reviews the exact saved artifact and chooses its own execution authority.

## What It Is

A recipe is a named JavaScript function with an input schema, capability tags, status, version, and owner provenance. pantry keeps recipes in D1 and hands the code back when asked. It never runs a recipe. The caller fetches the exact saved source, reviews it, and chooses the execution authority.

The store is private by default. A bearer token maps to one owner, and the default list shows only that owner's recipes. Many owners can share one deployment: set `PANTRY_TOKENS` to a JSON map of `{ "<token>": "<owner>" }` and each token authenticates as its own owner (single-tenant `PANTRY_TOKEN` + `PANTRY_OWNER` remain the fallback). A private recipe never crosses an owner boundary. Shared pantry is opt-in: an author can mark their own recipe `"visibility":"shared"` so other owners may read it with author provenance, version, and status. Writes stay owner-scoped, and pantry still never runs a recipe.

Think extensions are runtime-local capabilities for a Think agent; pantry is a runtime-neutral code registry where any harness fetches the exact saved source and chooses its own execution authority. Runtime extensions live inside one agent. A pantry recipe is a portable artifact any harness can fetch.

## The Recipe Shape

A recipe is the JSON you push to `POST /recipes`:

```json
{
  "name": "slugify",
  "description": "Turn arbitrary text into a URL-safe slug. Deterministic, no I/O.",
  "inputSchema": {
    "type": "object",
    "properties": { "text": { "type": "string", "maxLength": 500 } },
    "required": ["text"]
  },
  "code": "const text = String((ctx.input && ctx.input.text) || '');\nreturn { slug: text.toLowerCase().replace(/[^a-z0-9]+/g, '-') };",
  "capabilities": ["text.transform"],
  "status": "enabled",
  "sourceRunId": null
}
```

Field rules, enforced by `validateRecipeInput` in `src/recipe.ts`:

- `name` must match `/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/`. One name per owner.
- `description` is 5 to 500 characters.
- `inputSchema` is an object whose `type` is `"object"`. It defaults to `{ "type": "object", "properties": {} }` when omitted.
- `code` is required and must be at most 32000 bytes. pantry accepts three runner shapes: a bare JavaScript function body, an `export default` function/expression, or a `module.exports` function/expression. The demo runner calls bare bodies with one argument, `ctx`; exported callables receive `(input, ctx)`.
- `capabilities` must list at least one tag. A tag is either a scoped namespace (`workspace.*`, `machine.*`, `cloudbox.*`) or a generic dotted tag such as `text.transform`. Tags are deduplicated and sorted.
- `status` is `"pending"`, `"enabled"`, or `"disabled"`. Unknown values become `"enabled"`; the Pi push path can save pending recipes for owner approval before enabling.
- `sourceRunId` is an optional string, otherwise `null`.
- `visibility` is `"private"` by default. Set `"shared"` to opt your own recipe into the shared read pool.

The `code` field returns a plain value. The demo runner accepts the shapes an agent naturally authors: a bare function body that reads `ctx`, an `export default (input, ctx) => ...` (or `export default function run(input, ctx)`), or a `module.exports = (input, ctx) => ...`. The sample in `examples/sample-recipe.ts` uses the bare-body shape, reads `ctx.input.text`, and returns `{ slug }`.

## How To Use It

Run it locally with wrangler. Install, apply the D1 migration to the local database, set a token in `.dev.vars` (gitignored), then start the dev server:

```sh
bun install
bunx wrangler d1 migrations apply pantry-db --local   # creates/updates the local D1 schema
echo 'PANTRY_TOKEN=dev-secret' > .dev.vars
bun run dev
```

The migration step is required. The D1 binding is `DB` and the database is `pantry-db`; the schema lives in `migrations/0001_recipes.sql`. Without it the local database has no `recipes` table, and every route that touches D1 returns a `500` with `no such table: recipes`. Run the migration once per fresh local database. For a deployed instance, apply the same migration with `--remote` instead of `--local`.

The Worker fails closed. With no `PANTRY_TOKEN` configured, every authenticated route returns `503`. A wrong or missing bearer token returns `401`. Only `/health` and the CORS preflight are open.

## The API

The public instance lives at `https://pantry.coey.dev` (gated; the only open route is `/health`). All routes except `/health` and `OPTIONS` require `Authorization: Bearer <PANTRY_TOKEN>`. Examples below assume `PANTRY_URL` and `PANTRY_TOKEN` are set in your shell.

### `GET /health`

Open, no auth. For uptime checks.

```sh
curl "$PANTRY_URL/health"
# {"ok":true,"service":"pantry"}
```


### Shared pantry (opt-in)

Single-player remains the default. Shared pantry widens reads only, with no new core verbs:

```sh
pantry push recipe.json           # private
pantry push recipe.json --shared  # publish your own recipe
pantry list                       # your recipes
pantry list --shared              # shared recipes, no code, includes author
pantry get Name                   # own recipe wins, then shared
```

API shape: `GET /recipes?scope=shared` lists shared recipes across owners without code and includes `author`, `version`, and `status`. `GET /recipe/:name` resolves your own recipe first, then the most recently updated shared recipe with that name. Private recipes never cross owner boundaries. Provenance is informational: a shared recipe is still fetched code, and the caller decides whether and where to run it.

### `POST /recipes`

Upsert a recipe. Creates on first push (`201`), bumps `version` and updates the row on a repeat push of the same `(owner, name)` (`200`). Optional `visibility` is `private` or `shared`; only your own row is written.

```sh
curl -X POST "$PANTRY_URL/recipes" \
  -H "authorization: Bearer $PANTRY_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "slugify",
    "description": "Turn arbitrary text into a URL-safe slug.",
    "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
    "code": "const text = String((ctx.input && ctx.input.text) || \"\");\nreturn { slug: text.toLowerCase().replace(/[^a-z0-9]+/g, \"-\") };",
    "capabilities": ["text.transform"],
    "status": "enabled"
  }'
# {"name":"slugify","version":1}
```

An invalid body returns `400` with `{ "error": ..., "code": "InvalidInput" }`.

A valid push runs a best-effort lint and returns any `warnings` alongside `name` and `version`. It flags code that will not run deterministically (`Math.random`, `Date.now`, `new Date`, `fetch`, and similar) and a bare function body that reads `input` instead of `ctx.input`. The lint is a coarse token scan, not a proof: a clean lint does not guarantee a recipe is deterministic, and a recipe can defeat the scan. It does not reject by default; add `?strict=1` to reject a recipe that fails the lint with a `422`.

### `GET /recipes`

List recipes for the owner, ordered by `updatedAt` descending. The list never includes `code`. This is the discovery call and the review-before-run entry point. Add `?scope=shared` to list shared recipes from all owners with `author` provenance, still without `code`.

Filter discovery so its cost stays bounded by relevance as the cookbook grows: `?q=` matches a keyword over name and description, and `?capability=` matches a capability tag. Filters compose with `?scope=`, and the list still never includes `code`.

```sh
curl "$PANTRY_URL/recipes" -H "authorization: Bearer $PANTRY_TOKEN"
# {"recipes":[{"name":"slugify","description":"...","inputSchema":{...},
#   "capabilities":["text.transform"],"status":"enabled","version":1,
#   "sourceRunId":null,"updatedAt":"..."}]}
```

### `GET /recipe/:name`

The full recipe, including `code`. This is the call a caller makes right before reviewing and possibly running the recipe. Your own recipe wins; if missing, pantry returns the most recently updated shared recipe with that name. Returns `404` when neither exists.

```sh
curl "$PANTRY_URL/recipe/slugify" -H "authorization: Bearer $PANTRY_TOKEN"
# {"name":"slugify",...,"code":"const text = ...","createdAt":"..."}
```

### `DELETE /recipe/:name`

Owner-scoped delete. Returns `404` when nothing was deleted.

```sh
curl -X DELETE "$PANTRY_URL/recipe/slugify" -H "authorization: Bearer $PANTRY_TOKEN"
# {"deleted":true,"name":"slugify"}
```

## The Pantry Agent Tool

A caller reaches pantry through the same registry verbs from several harnesses: an MCP server for any MCP client, a small client for code, the Pi tool for a session, OpenCode through its plugin, your own orchestrator through a sync bridge, or curl against the API.

The MCP server (`pantry mcp`) exposes `pantry_list`, `pantry_get`, `pantry_run`, and `pantry_push` over stdio, so Claude Desktop, Cursor, or another MCP client reaches the same recipes. See [docs/MCP.md](./docs/MCP.md) for the client config and the trust posture.

`src/client.ts` is a small client usable from terrarium, Pi, or a Worker. It reads `PANTRY_URL` and `PANTRY_TOKEN` from the environment by default. `list()` fails soft: an unconfigured client returns `[]` rather than throwing, so a recipe lookup degrades to ordinary reasoning instead of crashing the caller.

```ts
import { pantry } from 'pantry'; // ./src/client.ts

// Discovery: no code is transferred, so this is cheap.
const available = await pantry.list();

// Fetch the full recipe including code.
const recipe = await pantry.get('slugify');
if (recipe) {
  // recipe.code is a function body. The caller decides whether to run it,
  // and in what isolate. pantry does not run it for you.
}

// Save a recipe back.
await pantry.push({
  name: 'slugify',
  description: 'Turn arbitrary text into a URL-safe slug.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  code: 'return { slug: String(ctx.input.text).toLowerCase() };',
  capabilities: ['text.transform'],
  status: 'enabled',
  sourceRunId: null,
});
```

The Pi tool wraps that same client so a Pi or terrarium session can reach pantry without curl. It lives at `.pi/extensions/pantry/index.ts`, registers one tool named `pantry`, and exposes four actions:

- `list` returns names, descriptions, input schemas, and capabilities, without `code`. This is the discovery call and the review-before-run entry point.
- `get(name)` returns the full recipe including `code`. The session reads this before deciding to run anything.
- `run(name, input)` fetches the recipe and executes its `code` over an explicit `ctx` of `{ input }`. This step runs fetched code; see below.
- `push(recipe)` upserts a recipe in the same shape the API accepts.

Pi auto-discovers the extension once the project is trusted, so the tool registers at session start. To test it directly:

```sh
pi -e ./.pi/extensions/pantry/index.ts -t pantry \
  "Call pantry list and tell me the recipe names."
```

The tool's `run` action and the demo runner share one honest posture: running a fetched recipe is the caller's decision and the caller's risk. The runner shadows a few ambient names and runs a best-effort parse-time scan, but `import()`, the `Function`-constructor climb, and string-built names all escape it. It is a convenience for code you already trust, not a sandbox. Untrusted recipes need a real isolate. See Security, and `docs/PI-TOOL.md` for the tool's configuration, the stale-DNS workaround, and a full example session.

Running a fetched recipe from code is the same separate step. `examples/run-recipe.ts` shows one pattern: treat `code` as a function body, call it with an explicit `ctx`, and read the result.

```sh
PANTRY_URL=... PANTRY_TOKEN=... bun examples/sample-recipe.ts   # push the sample
PANTRY_URL=... PANTRY_TOKEN=... bun examples/run-recipe.ts slugify
```

## Where Recipes Come From

A recipe reaches pantry one of two ways.

The direct way is a `POST /recipes`, by curl, the client, or the Pi tool's `push`. `examples/recipes/` holds recipes authored this way, such as `deploy_coey_worker`, a guided plan for deploying a coey.dev Worker with D1.

The other way is a sync bridge from your own orchestrator. An orchestrator that keeps its own saved recipes in a store maps each one to a pantry `POST /recipes` body: `name`, `description`, `inputSchema` from the stored JSON, `code`, and `capabilities` from the stored JSON. A well-behaved bridge is deliberately narrow:

- Additive. Nothing in the orchestrator's request path calls it; a caller opts in.
- Env-gated. It reads `PANTRY_URL` (default `https://pantry.coey.dev`) and `PANTRY_TOKEN`. With no token it logs a no-op and returns.
- Enabled-only. It pushes a recipe only when its status is `enabled`, and skips the rest.
- Fail-soft. A network error, a rejected recipe, or a malformed row is logged and skipped. The sync never throws into the orchestrator's flow.

The capability tags carry across unchanged. An orchestrator might write `workspace.*`, `machine.*`, or `cloudbox.*` tags; pantry stores them verbatim and grants nothing. The tag is something a fetching caller reasons about, not a permission pantry enforces. The token travels only in the `Authorization` header and is never logged.

## Security

pantry stores and hands back a script. It never executes a recipe. The bytes in `code` are returned verbatim from D1.

Running a fetched recipe is the caller's decision and the caller's risk. `examples/run-recipe.ts` is a demo runner, and its header says plainly that it is not a trust boundary. It binds a few ambient names such as `fetch` and `process` to `undefined` as a convenience for a casual `typeof process` lookup, and it runs a best-effort parse-time scan for obvious escape tokens. Both are tripwires. Neither contains hostile code. The file documents the escapes that defeat the shadowing, including `import('node:fs')` and the Function-constructor climb back to global scope. A passing scan proves nothing about safety.

If you do not already trust a recipe's author, run the recipe in a real isolate: a Cloudflare Worker Loader, a separate Worker, a child process, or a vetted JS sandbox. Real isolation is the caller's job, and pantry does not do it.

Server-side defenses pantry does provide:

- Bearer-token gate, fail-closed. No token configured returns `503`. Wrong or missing token returns `401`. The compare is constant-time so it does not leak token length or prefix through timing.
- Owner scoping. A token maps to one owner. Every query filters by owner, so one owner cannot read or delete another owner's recipes.
- CORS echoes the request origin and never pairs the wildcard with credentials. Preflight is answered before the auth gate, because browsers send preflight without the `Authorization` header.
- The token is a wrangler/alchemy secret. It is never hardcoded and never shipped to a client.

## Limits

- `code` is capped at 32000 bytes.
- `description` is 5 to 500 characters.
- One recipe name per owner. A repeat push upserts and bumps `version`; it does not create a second row.
- `inputSchema.type` must be `"object"`.
- pantry stores recipes; it does not validate that `code` is correct, safe, or matches its `inputSchema`. Validation covers shape and size, not behavior.
- pantry never runs a recipe, so it enforces nothing about what `code` does at runtime. `capabilities` are tags for the caller to reason about, not a sandbox.
- D1 limits apply to row size and database size.

## Eval Note

The main pantry claim is custody of exact reviewed artifacts across harnesses. The older eval still records a bounded token observation: fetching saved code can reduce generated output for repeated procedures, while discovery and tool-invocation overhead can make total tokens rise for small procedures.

There is still a per-call discovery cost. The model has to know a recipe exists, read its description and input schema, and decide it fits. `GET /recipes` keeps that cost low by omitting code, so discovery transfers names, descriptions, schemas, and capabilities rather than full scripts. Novel work still needs reasoning, because there is no saved artifact to fetch.

The structural claim is observable: pantry hands back exact saved code, and the `evals/` harness measures local recipe execution plus tokenizer-counted payload sizes for discovery. With `LIVE_MODEL=1` and a reachable provider, the harness records provider-reported token usage and scores correctness for every arm. Without provider usage, it stays in labeled estimate mode and fabricates nothing. One exploratory prod Kimi K2.7 sample saw reuse reduce output tokens and raise total tokens for a tiny procedure because of input/tool overhead. A clean multi-sample benchmark remains open. The live writeup is at [pantry.coey.dev/proof](https://pantry.coey.dev/proof).

## Layout

```text
src/worker.ts            one Worker: API paths run Hono, the rest serve the site
app/                     the docs/landing site (built to app/dist)
scripts/build-site.ts    builds app/dist (bun run build:site)
src/recipe.ts            recipe shape, validation, list/full projections
src/client.ts            PantryClient: list / get / push / delete
.pi/extensions/pantry/index.ts  the Pi tool (list / get / run / push)
migrations/0001_recipes.sql   the recipes table and indexes
examples/sample-recipe.ts     a real recipe (slugify) and a push script
examples/recipes/             recipes authored directly (deploy_coey_worker)
examples/run-recipe.ts        a demo runner; NOT a sandbox
alchemy.run.ts           deploy path (Worker + D1)
```

## Develop

```sh
bun install
bunx wrangler d1 migrations apply pantry-db --local   # apply the D1 migration to local D1
bun run dev          # wrangler dev, needs PANTRY_TOKEN in .dev.vars
bun test             # behavioral tests
bun run typecheck    # tsc --noEmit
bunx --bun @biomejs/biome check .
bun run check        # typecheck + biome + test
```

## License

MIT. See `LICENSE`.
