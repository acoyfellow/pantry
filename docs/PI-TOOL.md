# The `pantry` Pi tool

A [Pi](https://github.com/earendil-works) custom tool that lets a Pi or
terrarium session reuse pantry recipes **without curl**. It is a thin shell over
the existing client (`src/client.ts`, `PantryClient`) and the existing demo
runner (`examples/run-recipe.ts`, `runRecipe`). It does **not** reimplement the
HTTP and it does **not** add a security boundary.

- Lives at: `.pi/extensions/pantry/index.ts` (a project-local Pi extension).
- Registers one tool named `pantry` with four actions: `list`, `get`, `run`, `push`.

## What it is NOT

`pantry run` executes fetched recipe code over an explicit, restricted `ctx`
using the demo runner's bounded posture (shadowed ambient names + a best-effort
parse-time tripwire). **That is a convenience for code you already trust, not
containment.** `import()`, the `Function`-constructor climb, and string-built
names all escape it. Deciding to run a recipe is the caller's decision and the
caller's risk. Untrusted recipes need a real isolate (a Cloudflare Worker
Loader, a separate Worker, a child process, or a vetted JS sandbox) — this tool
does not provide one. See the header of `examples/run-recipe.ts` for the honest
details.

## Enable it

This extension is auto-discovered by Pi from the project-local
`.pi/extensions/` directory **after the project is trusted**. So from a Pi
session whose cwd is this repo:

1. Trust the project (Pi prompts on first run, or pass `--approve` / `-a`).
2. The `pantry` tool is registered automatically at session start.

Quick one-off test without relying on discovery:

```bash
pi -e ./.pi/extensions/pantry/index.ts
```

Restrict the session to just this tool:

```bash
pi -e ./.pi/extensions/pantry/index.ts -t pantry
```

After editing the extension, `/reload` picks up the changes in a running
session.

## Configure it

Read at call time, never printed:

| Variable | Default | Purpose |
|---|---|---|
| `PANTRY_URL` | `https://pantry.coey.dev` | Pantry base URL. Override to point at any reachable host/IP. |
| `PANTRY_TOKEN` | — | Bearer token. Read from env, else from `~/.terrarium/pantry-token.secret`. **Never logged or returned.** |
| `PANTRY_RESOLVE` | — | Optional `host:ip` pin (curl `--resolve` style) for the stale-DNS case (below). |

## Actions

- **`list`** — recipe names + descriptions + `inputSchema` + capabilities, **no code**. Cheap discovery. Pass `scope: "shared"` for the shared read pool with `author` provenance.
- **`get(name)`** — the full recipe **including** `code` + capabilities. Read this before you run anything.
- **`run(name, input)`** — fetch the recipe, then execute its `code` over an explicit restricted `ctx` (`{ input }`). Not a sandbox (see above). `guard` defaults to `true` (best-effort tripwire; pass `false` to run raw).
- **`push(recipe)`** — upsert a recipe: `{ name, description, inputSchema, code, capabilities[], visibility?, status?, sourceRunId? }`. Pass `shared: true` or `recipe.visibility = "shared"` to publish your own recipe to shared reads.

## Shared pantry

Single-player is the default. Shared pantry uses the same four actions: list with `scope: "shared"`, push with `shared: true` or `visibility: "shared"`, get, and run. Writes remain owner-scoped. Shared responses include `author` so the caller can reason about provenance before running fetched code.

## Known issue: stale local DNS

A stale local DNS resolver can make plain
`fetch("https://pantry.coey.dev/...")` throw a `ConnectionRefused`-style error
even though pantry is **live** (`curl` reproduces it; `curl --resolve` fixes
it). The tool does **not** silently auto-resolve. On that failure it returns a
clear error that names the stale-DNS possibility and the two documented
workarounds:

1. **Pin the host to a resolved IP** (in-process twin of `curl --resolve`):

   ```bash
   # find a current IP
   dig +short pantry.coey.dev A
   # then pin it: the tool rewrites the request to the IP while keeping the
   # real Host header + TLS SNI, so a stale resolver cannot break a live pantry.
   export PANTRY_RESOLVE="pantry.coey.dev:104.21.69.22"
   ```

2. **Override the URL** to any host you can actually reach:

   ```bash
   export PANTRY_URL="https://<reachable-host-or-ip>"
   ```

## Example session

```bash
export PANTRY_TOKEN="$(cat ~/.terrarium/pantry-token.secret)"
export PANTRY_RESOLVE="pantry.coey.dev:$(dig +short pantry.coey.dev A | head -1)"  # only if DNS is stale

pi -e ./.pi/extensions/pantry/index.ts -t pantry \
  "Call pantry list and tell me the recipe names."
# -> slugify
```
