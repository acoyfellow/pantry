# Shared pantry

pantry is single-player first. A bearer token maps to one `owner`, and normal reads and all writes stay scoped to that owner. Shared pantry is the smallest multiplayer extension of that model: authors can opt their own recipes into a shared read pool.

## Shipped model

- Schema: `recipes.visibility` is `private` by default and can be `shared`. Existing rows remain private. The `(owner, name)` uniqueness rule is unchanged.
- Writes stay owner-scoped. `POST /recipes` upserts only the caller's `(owner, name)`. Publishing means pushing your own recipe with `"visibility":"shared"` or using `push --shared`. Another owner cannot flip your row.
- `GET /recipes` still lists your recipes, private and shared, without code.
- `GET /recipes?scope=shared` lists shared recipes across all owners, without code, and includes `author` as provenance. Private rows are never included.
- `GET /recipe/:name` resolves your own recipe first. If you do not have that name, pantry returns the most recently updated shared recipe with that name. The full response includes `author`, `visibility`, and `code`.
- The server still never executes recipe code. Shared widens read access only. Capabilities remain tags for the caller to reason about, not grants.

## Surfaces

Core verbs are unchanged.

```sh
pantry push recipe.json                 # private by default
pantry push recipe.json --shared        # publish your own recipe to shared reads
pantry list                             # your recipes
pantry list --shared                    # shared read pool with author provenance
pantry get Name                         # own wins, then shared
pantry run Name --input '{"x":1}'       # fetches then runs locally, not on pantry
```

`PantryClient` exposes `list({ scope: 'shared' })`, `listShared()`, and accepts optional `visibility` on `push`. Pi and OpenCode keep `list/get/run/push`; pass `scope: "shared"` for a shared list and `shared: true` or `recipe.visibility = "shared"` on push.

## Trust posture

A shared recipe is code written by someone else. pantry returns the `author` owner so an agent or human can reason about provenance before running it. If you do not already trust the author and the code, run it in a real isolate such as a Worker Loader, separate Worker, child process, or vetted sandbox.
