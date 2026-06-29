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

## Valid recipe shape

A pushed recipe must have:

- `name` matching `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`
- `description` from 5 to 500 characters
- `inputSchema.type` equal to `object`
- `code` present and at most 32KB
- at least one valid capability tag, such as `text.transform` or `workspace.read`
- optional `visibility`: `private` by default, or `shared` for opt-in shared reads

The runner accepts a bare function body that reads `ctx`, `export default (input, ctx) => ...`, `export default function`, and `module.exports = (input, ctx) => ...`. Exported callables receive `(ctx.input, ctx)`. This is convenience, not a sandbox.

Copy-pasteable recipe file:

```json
{
  "name": "TitleCaseDemo",
  "description": "Convert input text to title case for docs examples.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string" }
    },
    "required": ["text"]
  },
  "code": "export default (input) => String(input.text).toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase());",
  "capabilities": ["text.transform"]
}
```

## CLI, the universal happy path

Use this from any harness, shell, cron job, or agent:

```sh
cat > /tmp/title-case-demo.json <<'JSON'
{
  "name": "TitleCaseDemo",
  "description": "Convert input text to title case for docs examples.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string" }
    },
    "required": ["text"]
  },
  "code": "export default (input) => String(input.text).toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase());",
  "capabilities": ["text.transform"]
}
JSON

pantry push /tmp/title-case-demo.json
pantry list
pantry get TitleCaseDemo
pantry run TitleCaseDemo --input '{"text":"hello pantry"}'
```

Other useful CLI calls:

```sh
pantry list --json
pantry get TitleCaseDemo --json
printf '{"text":"hello pantry"}' | pantry run TitleCaseDemo --input -
pantry run TitleCaseDemo --input @input.json --json
pantry push /tmp/title-case-demo.json --shared
pantry list --shared
```

During local development:

```sh
node bin/pantry list
bunx pantry list
```

`list` shows recipe names, descriptions, schemas, and capabilities without code. `get` returns the full recipe, including code. Read before you run.

## Shared pantry (multiplayer)

Default use is still your private shelf. To publish a recipe you own, push it with `visibility: "shared"` or use `pantry push file.json --shared`. Shared reads use the same verbs:

```sh
pantry list --shared
pantry get TitleCaseDemo
```

`pantry list --shared` maps to `GET /recipes?scope=shared`, returns no code, and includes `author` for provenance. `get` resolves your own recipe first, then a shared recipe by name. The server never runs shared code; decide whether to run it based on author, code, capabilities, and your own isolation.

## Pi extension

Pi loads `.pi/extensions/pantry/index.ts` and exposes one `pantry` tool with four actions. Push and run use the same recipe shape:

```json
{"action":"push","recipe":{"name":"TitleCaseDemo","description":"Convert input text to title case for docs examples.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]},"code":"export default (input) => String(input.text).toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase());","capabilities":["text.transform"]}}
```

```json
{"action":"run","name":"TitleCaseDemo","input":{"text":"hello pantry"}}
```

Also available:

```json
{"action":"list"}
{"action":"list","scope":"shared"}
{"action":"get","name":"TitleCaseDemo"}
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

OpenCode push and run example:

```json
{"action":"push","recipe":{"name":"TitleCaseDemo","description":"Convert input text to title case for docs examples.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]},"code":"module.exports = (input) => String(input.text).toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase());","capabilities":["text.transform"]}}
```

```json
{"action":"run","name":"TitleCaseDemo","input":{"text":"hello pantry"}}
```

## Honest run caveat

`pantry run` is not a security sandbox. It executes fetched recipe code locally over an explicit restricted `ctx` using the demo runner's bounded posture. The runner shadows ambient names and can apply a best-effort parse-time tripwire, but `import()`, the Function-constructor climb, and string-built names can escape it. Running fetched code is the caller's decision and risk. Untrusted recipes need a real isolate, such as a Worker Loader, a separate Worker, a child process, or a vetted JavaScript sandbox.
