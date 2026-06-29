import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PantryClient } from '../src/client.ts';
import type { FullRecipe, RecipeInput, RecipeListEntry } from '../src/recipe.ts';

const OLD = { ...process.env };
const emptyHome = join(import.meta.dir, '.empty-home');
const entry: RecipeListEntry = {
  name: 'slugify',
  description: 'd',
  inputSchema: { type: 'object' },
  capabilities: ['text.transform'],
  status: 'enabled',
  version: 1,
  sourceRunId: null,
  updatedAt: '',
};
const recipe: FullRecipe = { ...entry, code: 'return ctx.input.n * 2;', createdAt: '' };
const input: RecipeInput = {
  name: 'a',
  description: 'desc',
  inputSchema: { type: 'object' },
  code: 'return 1;',
  capabilities: ['text.transform'],
  status: 'enabled',
  sourceRunId: null,
};
function restore() {
  process.env = { ...OLD };
}
function fakeFetch(
  fn: Parameters<typeof fetch>[0] extends infer _
    ? (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    : never,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

beforeEach(() => {
  restore();
  process.env.PANTRY_TOKEN = 't';
  process.env.PANTRY_URL = 'https://x.test';
});
afterEach(restore);

describe('CLI surface', () => {
  test('PantryClient list parses injected fetch', async () => {
    const client = new PantryClient({
      url: 'https://x.test',
      token: 't',
      fetch: fakeFetch(async () => Response.json({ recipes: [entry] })),
    });
    expect(await client.list()).toEqual([entry]);
  });

  test('get and push parse through PantryClient', async () => {
    const calls: string[] = [];
    const client = new PantryClient({
      url: 'https://x.test',
      token: 't',
      fetch: fakeFetch(async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return url.toString().includes('/recipe/')
          ? Response.json(recipe)
          : Response.json({ name: 'a', version: 2 });
      }),
    });
    expect((await client.get('a'))?.code).toBe(recipe.code);
    expect(await client.push(input)).toEqual({ name: 'a', version: 2 });
    expect(calls).toEqual(['GET https://x.test/recipe/a', 'POST https://x.test/recipes']);
  });

  test('run uses runRecipe', async () => {
    const { runRecipe } = await import('../examples/run-recipe.ts');
    expect(runRecipe(recipe, { input: { n: 4 } })).toMatchObject({ ok: true, output: 8 });
  });

  test('no-token error is clear when no env or token file exists', async () => {
    rmSync(emptyHome, { recursive: true, force: true });
    mkdirSync(emptyHome, { recursive: true });
    process.env.PANTRY_TOKEN = '';
    process.env.HOME = emptyHome;
    process.env.TERRARIUM_HOME = emptyHome;
    const { makeClient } = await import('../src/surface.ts');
    expect(() => makeClient(fakeFetch(async () => Response.json({})))).toThrow(
      /PANTRY_TOKEN is not set/,
    );
  });
});

describe('OpenCode plugin smoke', () => {
  test('tool definitions exist', async () => {
    const mod = await import('../extensions/opencode/index.ts');
    const plugin = await mod.default({} as never);
    expect(plugin.tool?.pantry).toBeTruthy();
  });
});
