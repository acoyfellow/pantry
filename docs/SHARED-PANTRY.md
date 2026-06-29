# Shared pantry — forward design note (not implemented)

pantry today is single-owner. A bearer token maps to one `owner`, and every
recipe row is scoped `WHERE owner = ?` (see `src/worker.ts`, `PANTRY_OWNER`
default, and the `owner` column in `migrations/0001_recipes.sql`). One person,
one shelf.

The next level is a **shared pantry**: the same interface, with the owner
boundary relaxed into shared or namespaced recipe spaces — so a team (or several
agents) can read and reuse a common set of recipes instead of each keeping a
private shelf.

Because the `owner` column already exists, this is an **extension, not a
rewrite**. Sketch of the smallest honest version:

- Keep `owner` as the write boundary: you still author into your own space.
- Add a readable shared space — e.g. a reserved `shared` owner, or a
  `visibility` column (`private` | `shared`) — so `GET /recipes` can return
  your recipes plus the shared set.
- Reads widen; writes stay owner-scoped. No recipe executes server-side, so the
  trust model is unchanged: the caller still runs fetched code in its own
  isolate.
- The CLI / OpenCode / Pi surfaces need no new verbs — `list`/`get`/`run`/`push`
  already fit. A shared pantry is the same happy path, rephrased.

Open questions to decide before building: who may publish to the shared space,
how trust/provenance is shown on a shared recipe, and whether shared recipes are
namespaced (`team/recipe`) or flat. None of this is built yet; this note exists
so the path is recorded.
