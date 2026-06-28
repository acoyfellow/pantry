# pantry

A small Cloudflare Worker and D1 store of recipes, so an agent can reuse a saved recipe instead of re-deriving the same pattern.

## What It Is

A recipe is a named JavaScript function with an input schema and a list of capability tags. pantry keeps recipes in D1 and hands the code back when asked. It never runs a recipe. The caller fetches a recipe and runs it in the caller's own isolate. Whether to run fetched code is the caller's trust decision.

The store is single-tenant by default. A bearer token maps to one owner, and an owner sees only its own recipes.

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
- `code` is required, is a JavaScript function body, and must be at most 32000 bytes. The runner calls it with one argument, `ctx`.
- `capabilities` must list at least one tag. A tag is either a scoped namespace (`workspace.*`, `machine.*`, `cloudbox.*`) or a generic dotted tag such as `text.transform`. Tags are deduplicated and sorted.
- `status` is `"enabled"` or `"disabled"`. Anything other than `"disabled"` becomes `"enabled"`.
- `sourceRunId` is an optional string, otherwise `null`.

The `code` field is a function body, not a module. It receives a single `ctx` object and returns a plain value. The sample in `examples/sample-recipe.ts` reads `ctx.input.text` and returns `{ slug }`.

## How To Use It

Run it locally with wrangler. Install, apply the D1 migration to the local database, set a token in `.dev.vars` (gitignored), then start the dev server:

```sh
bun install
bunx wrangler d1 migrations apply pantry-db --local   # creates the recipes table in local D1
echo 'PANTRY_TOKEN=dev-secret' > .dev.vars
bun run dev
```

The migration step is required. The D1 binding is `DB` and the database is `pantry-db`; the schema lives in `migrations/0001_recipes.sql`. Without it the local database has no `recipes` table, and every route that touches D1 returns a `500` with `no such table: recipes`. Run the migration once per fresh local database. For a deployed instance, apply the same migration with `--remote` instead of `--local`.

The Worker fails closed. With no `PANTRY_TOKEN` configured, every authenticated route returns `503`. A wrong or missing bearer token returns `401`. Only `/health` and the CORS preflight are open.

## The API

All routes except `/health` and `OPTIONS` require `Authorization: Bearer <PANTRY_TOKEN>`. Examples below assume `PANTRY_URL` and `PANTRY_TOKEN` are set in your shell.

### `GET /health`

Open, no auth. For uptime checks.

```sh
curl "$PANTRY_URL/health"
# {"ok":true,"service":"pantry"}
```

### `POST /recipes`

Upsert a recipe. Creates on first push (`201`), bumps `version` and updates the row on a repeat push of the same `(owner, name)` (`200`).

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

### `GET /recipes`

List recipes for the owner, ordered by `updatedAt` descending. The list never includes `code`. This is the cheap discovery call.

```sh
curl "$PANTRY_URL/recipes" -H "authorization: Bearer $PANTRY_TOKEN"
# {"recipes":[{"name":"slugify","description":"...","inputSchema":{...},
#   "capabilities":["text.transform"],"status":"enabled","version":1,
#   "sourceRunId":null,"updatedAt":"..."}]}
```

### `GET /recipe/:name`

The full recipe, including `code`. This is the call a caller makes right before running the recipe. Returns `404` when the recipe does not exist for this owner.

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

## Using A Recipe From Your Agent

`src/client.ts` is a small client usable from terrarium, Pi, or a Worker. It reads `PANTRY_URL` and `PANTRY_TOKEN` from the environment by default. `list()` fails soft: an unconfigured client returns `[]` rather than throwing, so a recipe lookup degrades to "re-reason it" instead of crashing the caller.

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

Running a fetched recipe is a separate step that pantry does not perform. `examples/run-recipe.ts` shows one pattern: treat `code` as a function body, call it with an explicit `ctx`, and read the result. That runner is a demo, not a sandbox. See Security.

```sh
PANTRY_URL=... PANTRY_TOKEN=... bun examples/sample-recipe.ts   # push the sample
PANTRY_URL=... PANTRY_TOKEN=... bun examples/run-recipe.ts slugify
```

## Token Economics

A recipe saves model tokens only for a recurring pattern. When a pattern repeats, the model can call a known script instead of re-reasoning the same logic each time. That is the mechanism, and it is the whole claim.

There is still a per-call discovery cost. The model has to know a recipe exists, read its description and input schema, and decide it fits. `GET /recipes` keeps that cost low by omitting code, so discovery transfers names, descriptions, schemas, and capabilities rather than full scripts. Novel work still needs reasoning, because there is no saved recipe to reuse.

This repository ships no measured token numbers. The saving depends on how often a pattern recurs and how large the re-reasoning would have been, neither of which pantry measures. Treat the mechanism as the claim, not a benchmark.

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

## Layout

```text
src/worker.ts            Hono routes, auth gate, CORS, D1 queries
src/recipe.ts            recipe shape, validation, list/full projections
src/client.ts            PantryClient: list / get / push / delete
migrations/0001_recipes.sql   the recipes table and indexes
examples/sample-recipe.ts     a real recipe (slugify) and a push script
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
