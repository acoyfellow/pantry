# Contributing

pantry is a small experiment. Contributions that keep it small are welcome.

## Setup

```sh
bun install
bunx wrangler d1 migrations apply pantry-db --local   # creates the recipes table in local D1
echo 'PANTRY_TOKEN=dev-secret' > .dev.vars            # gitignored
bun run dev                                          # wrangler dev
```

The migration step is required and runs once per fresh local database. The schema is `migrations/0001_recipes.sql`. Skip it and every route that touches D1 returns a `500` with `no such table: recipes`.

## Before You Open A Change

Run the full check. It must pass.

```sh
bun run check    # typecheck + biome + test
```

That runs:

- `bun run typecheck` (`tsc --noEmit`), which must be clean.
- `bunx --bun @biomejs/biome check .`, which must report no fixes. Biome owns lint and format: 2-space indent, single quotes, trailing commas, semicolons, line width 100. Do not add ESLint or Prettier.
- `bun test`, which must stay green.

## What To Keep In Mind

- pantry never runs a recipe. Any change that makes the Worker execute recipe `code` is out of scope. Execution is the caller's job, in the caller's isolate.
- The recipe shape in `src/recipe.ts` mirrors `my-ax/src/saved-recipes.ts`. Keep them aligned when you touch validation.
- The auth gate is fail-closed by design. Do not add a path that runs an authenticated query without the owner filter.
- Add a behavioral test for any new route or validation rule. Tests use a fake D1 (`test/fake-d1.ts`), so they run without a network.
- Version stays `0.0.1`, and the package stays `private`.

## Style

Follow the writing voice in any docs you touch: short declarative sentences, no hype, claims backed by the code. No `->` arrows in prose.
