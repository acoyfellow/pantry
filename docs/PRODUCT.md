# Pantry product architecture

Pantry is an open-source, self-hosted recipe workspace. A forked deployment gives one person or team a private shelf for reviewed, versioned capabilities. Pantry stores source and approval evidence; it never executes recipe code.

## Deployment shape

```text
browser / agent
      |
      v
Cloudflare Access or OAuth -> Hono Worker -> D1
                                  |
                                  +-- recipes and versions
                                  +-- approval receipts
                                  +-- usage assertions
```

The Worker is the authentication and policy boundary. The Svelte app in `/manage/` is a static operator client and must not contain secrets or make policy decisions locally.

## Identity model

The initial OSS deployment supports one instance with one team. The durable model is:

```text
instance
└── team
    ├── members (owner, editor, approver, reader)
    ├── agents (scoped machine credentials)
    └── recipes
```

The public machine API retains bearer credentials for agent compatibility. The Operations deployment is different: `PANTRY_ACCESS_ONLY=true` disables legacy bearer-token authentication at the Worker boundary, while Cloudflare Access protects the product origin and supplies the verified identity used for team policy. Scoped agent credentials created from the Access-authenticated workspace remain valid for machine routes; `PANTRY_TOKENS` and `PANTRY_TOKEN` are not valid human-management credentials.

The production identity adapter should accept either Cloudflare Access identity headers or an OAuth session and resolve them to a team member. Agent credentials should be separate, scoped, rotatable machine credentials. Human sessions and agent credentials must never be stored in browser storage or embedded in static assets.

## Sharing and trust

Recipes are private by default. Shared visibility widens discovery and reads only; it does not grant write access. Approval binds a version and digest. Any source or capability change returns a recipe to `pending` and clears its executable approval. Callers fetch a pinned approved version, review it, and choose their own execution authority.

## Self-hosting path

1. Fork the repository.
2. Create a Cloudflare Worker and D1 database named `pantry-db`.
3. Install dependencies with `bun install`.
4. Apply migrations with `bunx wrangler d1 migrations apply pantry-db --remote`.
5. Configure Access/OAuth for browser routes and a scoped agent credential for API clients.
6. Set the local development variables in `.dev.vars` or production secrets in Wrangler; never commit them.
7. Build the static site with `bun run build:site`.
8. Deploy with `bun run deploy`.
9. Open `/manage/`, sign in, create a recipe, and approve its first version.

See [AGENT-CONNECTION.md](./AGENT-CONNECTION.md) for the machine-client setup.

## Local Operations development

```sh
cp example.dev-vars-ops.txt .dev.vars.ops
bun run seed:dev
bun run dev:ops
```

`seed:dev` applies migrations to the local D1 state and inserts pending, enabled, and used recipes so the review queue and activity analytics have data. `.dev.vars.ops` sets `PANTRY_DEV_ACCESS_IDENTITY`, which substitutes a fixed Access identity for local requests only. It must never be configured on a deployed environment; production identity always comes from the verified Cloudflare Access header.

## Product boundaries

- Pantry is a registry and review surface, not a code execution sandbox.
- Usage reports are caller assertions, not evidence that Pantry ran code.
- Production deployment, remote migration, and identity-provider configuration remain operator-owned steps.
- A first release should prefer one team per instance over premature multi-tenant complexity.
