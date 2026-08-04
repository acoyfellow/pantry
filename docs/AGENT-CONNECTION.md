# Connect an agent securely

Pantry returns reviewed recipe artifacts to callers. The caller owns execution and must treat fetched source as code.

## Human setup

Use the authenticated web app at `/manage/` to review source, capabilities, version, digest, and approval receipts. A browser session should come from Cloudflare Access or the deployment's OAuth provider. Do not paste a production bearer token into a shared screen, commit it, or store it in local/session storage.

## Agent setup

An Access-authenticated team owner or approver creates a dedicated credential with `POST /api/agent-credentials`. The request supplies an agent principal and a non-empty subset of `recipes:read`, `recipes:write`, and `usage:report`. The returned credential is shown once in that creation response; immediately store it in the agent runtime's secret manager or environment, never in a recipe, prompt, browser bundle, repository, or log.

```sh
export PANTRY_URL=https://your-pantry.example
export PANTRY_TOKEN=loaded-by-your-secret-manager
```

Rotate with `POST /api/agent-credentials/:id/rotate` and revoke with `DELETE /api/agent-credentials/:id`; both require an Access owner or approver session. Agent credentials cannot use session or approval routes. `PANTRY_TOKEN` and `PANTRY_TOKENS` remain legacy compatibility credentials only when explicitly configured, and they cannot approve recipes.

## Discovery and pinned fetch

Discovery does not return source:

```sh
curl "$PANTRY_URL/recipes?scope=shared" \
  -H "authorization: Bearer $PANTRY_TOKEN"
```

Fetch only after selecting a recipe and version. Pin the version so an update cannot silently change what the agent reviews:

```sh
curl "$PANTRY_URL/recipe/slugify?version=1" \
  -H "authorization: Bearer $PANTRY_TOKEN"
```

Verify the returned name, version, digest, status, capabilities, and approval metadata. Reject `pending`, `rejected`, `disabled`, `superseded`, or unapproved responses.

## Caller-side execution

Pantry does not run the returned code. Execute it in the agent's own reviewed authority boundary, with only the bindings required by the declared capabilities. A convenience runner is not a security sandbox. For sensitive capabilities, use a real isolate or a host-controlled runtime.

After a successful caller-side run, report usage with an idempotent event ID:

```sh
curl -X POST "$PANTRY_URL/recipe/slugify/usage" \
  -H "authorization: Bearer $PANTRY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"eventId":"agent-run-001","version":1,"outcome":"success"}'
```

Usage is an authenticated caller assertion. It is useful for discovery and operations, but it is not Pantry execution evidence.

## MCP and local clients

The MCP server and `PantryClient` use the same API and environment variables. Configure those variables in the MCP host's secret environment. Never put them in an MCP recipe or client-side web storage. See [MCP.md](./MCP.md) and [PI-TOOL.md](./PI-TOOL.md) for harness-specific setup.
