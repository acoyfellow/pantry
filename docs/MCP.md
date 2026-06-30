# pantry over MCP

pantry ships a Model Context Protocol server so an MCP client (Claude Desktop, Cursor, or another harness) can list, fetch, run, and push recipes. It is a thin stdio wrapper over the same client and runner the CLI uses.

The server talks to a pantry instance over HTTP; it does not run recipes itself. `pantry_run` executes fetched code in the server's own process, and that process is not a sandbox. Running a fetched recipe is the caller's decision and the caller's risk.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `pantry_list` | `scope?: "owner" \| "shared"` | recipe names, descriptions, input schemas, and capability tags. No code. |
| `pantry_get` | `name` | one recipe, including its exact saved code and provenance (author, version, visibility). |
| `pantry_run` | `name`, `input?` | fetches the recipe and runs its code over `{ input }` in the server process. Not a sandbox. |
| `pantry_push` | `recipe`, `shared?` | upserts a recipe for this owner. Stays private unless `shared` is set. |

## Run it

The server is the `mcp` subcommand of the pantry CLI:

```sh
pantry mcp
```

It reads two environment variables:

- `PANTRY_URL` — defaults to `https://pantry.coey.dev`.
- `PANTRY_TOKEN` — your bearer token. Read from the environment or `~/.terrarium/pantry-token.secret`. It is never logged.

## Configure a client

The config is the same for any MCP client: launch `pantry mcp` and pass the two environment variables.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pantry": {
      "command": "pantry",
      "args": ["mcp"],
      "env": {
        "PANTRY_URL": "https://pantry.coey.dev",
        "PANTRY_TOKEN": "your-token"
      }
    }
  }
}
```

Cursor and other MCP clients use the same `command`, `args`, and `env`. From a checkout instead of an installed binary, use `"command": "bun"` with `"args": ["src/cli.ts", "mcp"]`.

## Trust

- pantry stores and returns code. It never runs a recipe.
- `pantry_run` runs fetched code in the server process. That is not a sandbox; the demo runner documents the escapes it cannot stop. Run code you trust, or fetch with `pantry_get` and run it in a real isolate yourself.
- Capability tags are metadata a caller reasons about, not permissions pantry enforces.
