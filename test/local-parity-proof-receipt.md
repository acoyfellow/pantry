# Local parity proof receipt

**Scope:** local-only verification from `/Users/jcoeyman/cloudflare/pantry/test` on the existing dirty worktree at `a17508d`. No deployment, remote D1 operation, GitLab mutation, or request to `pantry.coey.dev` was made.

## Command results

| Check | Repository-root command | Result |
| --- | --- | --- |
| Full test suite | `bun run test` | Pass: 129 tests, 0 failures, 362 assertions across 15 files. |
| Typecheck | `bun run typecheck` | Pass. |
| Svelte diagnostics | `bun run check:svelte` | Pass: 0 errors, 0 warnings. |
| Operations build | `bun run build:ops` | Pass: Vite built the Operations assets. |
| Local migration rehearsal | `bunx wrangler d1 migrations apply pantry-db --local --config wrangler.ax.jsonc --persist-to <temporary directory>` | Pass: migrations `0001_recipes.sql` through `0015_employee_foundation_guards.sql` applied to disposable local D1 only. |

The local-D1 schema query after the rehearsal found `actors`, `audit_events`, `folders`, `recipe_release_reviews`, `workspace_memberships`, and `workspaces`; `d1_migrations` recorded all 15 migration files.

## Feature-flag proof

`bun test test/workspace-foundation.test.ts test/workspace-recipes.test.ts` passed 8 tests with 0 failures.

- **Flag off:** the owner-scoped `/recipes` write remains accepted, has owner `default`, has no `workspace_id`, and the workspace route is rejected (`403`).
- **Flag on:** the employee workspace uses the configured local verified Access subject, enforces role and restricted-folder checks, supports workspace recipe inventory and approved pinned source retrieval, and records source-free activity.

## Responsive-browser proof

Not run. This host has no available `agent-browser`, Chromium, Chrome, Playwright, or Puppeteer executable/package. Therefore visual verification of both flag states at **320px, 390px, 430px, and 1280px** is blocked rather than inferred from static checks.

## Employee MCP credential boundary

`env -u PANTRY_TOKEN -u PANTRY_URL bun src/cli.ts login` exited as expected with the browser-SSO-unavailable message. It directs employee access to the Pantry deployment browser management app with SSO. The command mentions `PANTRY_TOKEN` only for explicitly non-interactive automation.

A local assertion over `docs/MCP.md` also passed: the guide states that employee access does not authenticate with a bearer token and that the unavailable login path does not ask employees to create or paste `PANTRY_TOKEN`.

## Review-recipe manifest parity

Blocked for the requested two-canary confirmation.

The plan identifies `review_this_mr` and `reviews_todo` as the two review data canaries. The local repository has one current seed-source manifest, `review_this_mr`, in `scripts/seed-dev.ts` (current file SHA-256: `2826e679f1451e635979545fe27533dde35a80c01e36ceaafc3aaf1a91b6f1e7`). `reviews_todo` appears only in `docs/full-product-foundation-plan.md`; no local recipe manifest, immutable history, digest, receipt, attestation, or usage fixture exists for it.

Because this proof may not contact Pantry or production D1, it cannot obtain or compare the missing real canary manifest. The disposable migration rehearsal did not change repository source files or access production data, but it cannot establish two-canary data parity without an operator-provided, local sanitized export/fixture containing both artifacts.

## Worktree note

The repository already contained tracked and untracked implementation changes before this proof. This task did not modify application source; the only proof artifact written is this receipt.
