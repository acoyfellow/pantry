# pantry for agents

pantry is a capability-scoped recipe store. It stores and hands back scripts. It never runs them on the server. Every surface below uses the same core client in `src/client.ts` and the same local demo runner in `examples/run-recipe.ts`.

## Config

```sh
export PANTRY_URL="https://pantry.coey.dev"
export PANTRY_TOKEN="..."
# or write the token to ~/.terrarium/pantry-token.secret
```

If local DNS is stale, pin a fresh address deliberately:

```sh
export PANTRY_RESOLVE="pantry.coey.dev:$(dig +short pantry.coey.dev A | head -1)"
```

The token is never printed by the tools.

## CLI, the universal happy path

Use this from any harness, shell, cron job, or agent:

```sh
pantry list
pantry list --json
pantry get slugify
pantry get slugify --json
pantry run slugify --input '{"text":"Hello Pantry"}'
printf '{"text":"Hello Pantry"}' | pantry run slugify --input -
pantry run slugify --input @input.json --json
pantry push recipe.json
```

During local development:

```sh
node bin/pantry list
bunx pantry list
```

`list` shows recipe names, descriptions, schemas, and capabilities without code. `get` returns the full recipe, including code. Read before you run.

## Pi extension

Pi loads `.pi/extensions/pantry/index.ts` and exposes one `pantry` tool with four actions:

```json
{"action":"list"}
{"action":"get","name":"slugify"}
{"action":"run","name":"slugify","input":{"text":"Hello Pantry"}}
{"action":"push","recipe":{"name":"demo","description":"...","inputSchema":{},"code":"return 1;","capabilities":[]}}
```

The Pi surface is a thin shell over the same `PantryClient` and `runRecipe` core.

## OpenCode plugin

Install or reference the package, then load the plugin from the package export:

```ts
// opencode config
import PantryPlugin from 'pantry/opencode';

export default [PantryPlugin];
```

OpenCode gets a native `pantry` tool with the same four actions as Pi: `list`, `get`, `run`, and `push`. The plugin depends on `@opencode-ai/plugin` as an optional peer so pantry stays useful as a CLI even outside OpenCode.

## Honest run caveat

`pantry run` is not a security sandbox. It executes fetched recipe code locally over an explicit restricted `ctx` using the demo runner's bounded posture. The runner shadows ambient names and can apply a best-effort parse-time tripwire, but `import()`, the Function-constructor climb, and string-built names can escape it. Running fetched code is the caller's decision and risk. Untrusted recipes need a real isolate, such as a Worker Loader, a separate Worker, a child process, or a vetted JavaScript sandbox.
