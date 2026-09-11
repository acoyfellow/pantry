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

`pantry mcp` does not make an employee authenticate with a bearer token. Employee access belongs in the Pantry deployment's browser management app, protected by its configured SSO provider.

The `pantry login` command is the reserved CLI entry point for future browser session handoff. This package does not implement that handoff today: it does not open a browser, discover an identity provider, implement OAuth, or implement PKCE. It exits with an actionable message directing an employee to the deployment browser sign-in instead of asking them to create or paste `PANTRY_TOKEN`.

## Configure an automation client

MCP stdio hosts cannot use the future interactive browser handoff yet. They must be configured as non-interactive automation with an explicitly provisioned, scoped credential. The compatibility credential can be supplied through `PANTRY_TOKEN` or `~/.terrarium/pantry-token.secret`; it is never logged.

- `PANTRY_URL` — defaults to `https://pantry.coey.dev`.
- `PANTRY_TOKEN` — explicit automation credential only, not employee SSO setup.

Claude Desktop (`claude_desktop_config.json`) machine configuration:

```json
{
  "mcpServers": {
    "pantry": {
      "command": "pantry",
      "args": ["mcp"],
      "env": {
        "PANTRY_URL": "https://pantry.coey.dev",
        "PANTRY_TOKEN": "scoped-automation-credential"
      }
    }
  }
}
```

Cursor and other MCP clients use the same machine configuration. From a checkout instead of an installed binary, use `"command": "bun"` with `"args": ["src/cli.ts", "mcp"]`. Do not place an employee browser session or a long-lived production credential in a checked-in client configuration.

## Trust

- pantry stores and returns code. It never runs a recipe.
- `pantry_run` runs fetched code in the server process. That is not a sandbox; the demo runner documents the escapes it cannot stop. Run code you trust, or fetch with `pantry_get` and run it in a real isolate yourself.
- Capability tags are metadata a caller reasons about, not permissions pantry enforces.
