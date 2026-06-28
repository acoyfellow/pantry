// END-TO-END proof: client -> worker -> runner, one round-trip.
//
// PantryClient (with an injected fetch that targets the worker's app.fetch)
// pushes a recipe, GETs it back WITH code, then runs it via the bounded runner
// over a restricted ctx — asserting the round-trip returns the recipe's output.
// This stitches together the three pieces that other tests exercise in
// isolation (client transport, worker storage, runner execution).

import { describe, expect, test } from 'bun:test';
import { runRecipe } from '../examples/run-recipe.ts';
import { sampleRecipe } from '../examples/sample-recipe.ts';
import { PantryClient } from '../src/client.ts';
import type { FullRecipe } from '../src/recipe.ts';
import app, { type Env } from '../src/worker.ts';
import { FakeD1 } from './fake-d1.ts';

const TOKEN = 'e2e-secret-token';

// An injected fetch that drives the real worker via app.fetch over an in-memory
// D1. The client cannot tell this from a network round-trip.
function workerFetch(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(input), init);
    return app.fetch(req, env);
  }) as unknown as typeof fetch;
}

describe('end-to-end: client -> worker -> runner', () => {
  test('push a recipe, GET it back with code, run it, get the recipe output', async () => {
    const env: Env = {
      DB: new FakeD1() as unknown as D1Database,
      PANTRY_TOKEN: TOKEN,
      PANTRY_OWNER: 'default',
    };
    const client = new PantryClient({
      url: 'https://pantry.test',
      token: TOKEN,
      fetch: workerFetch(env),
    });

    // 1) client pushes the real sample slugify recipe through the worker.
    const pushed = await client.push(sampleRecipe);
    expect(pushed).toEqual({ name: 'slugify', version: 1 });

    // 2) client GETs the full recipe back, including code, through the worker.
    const fetched = await client.get('slugify');
    expect(fetched).not.toBeNull();
    const recipe = fetched as FullRecipe;
    expect(recipe.name).toBe('slugify');
    expect(recipe.code).toBe(sampleRecipe.code);
    expect(recipe.capabilities).toEqual(['text.transform']);

    // 3) caller runs the fetched recipe over a restricted ctx via the runner.
    //    (The slugify recipe contains no escape tokens, so the default guard
    //    lets it through; running it is the caller's own trust decision.)
    const result = runRecipe(recipe, { input: { text: 'Hello, Pantry World!' } });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ slug: 'hello-pantry-world' });
    expect(result.capabilities).toEqual(['text.transform']);
  });
});
