import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  test('push authored recipes then run both accepted code shapes through injected fetch', async () => {
    const store = new Map<string, FullRecipe>();
    const posts: unknown[] = [];
    const client = new PantryClient({
      url: 'https://x.test',
      token: 't',
      fetch: fakeFetch(async (url, init) => {
        const href = url.toString();
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as RecipeInput;
          posts.push(body);
          store.set(body.name, {
            ...body,
            version: 1,
            updatedAt: '',
            createdAt: '',
          });
          return Response.json({ name: body.name, version: 1 });
        }
        const name = href.split('/recipe/')[1];
        const saved = store.get(name);
        return saved ? Response.json(saved) : new Response('not found', { status: 404 });
      }),
    });
    const authored: RecipeInput[] = [
      {
        ...input,
        name: 'ExportRecipe',
        code: 'export default (input) => input.n * 3;',
      },
      {
        ...input,
        name: 'BodyRecipe',
        code: 'return ctx.input.n * 4;',
      },
    ];
    const { runRecipe } = await import('../examples/run-recipe.ts');
    for (const item of authored) {
      expect(await client.push(item)).toEqual({ name: item.name, version: 1 });
      const saved = await client.get(item.name);
      if (!saved) throw new Error('expected saved recipe');
      expect(runRecipe(saved, { input: { n: 5 } }).output).toBe(
        item.name === 'ExportRecipe' ? 15 : 20,
      );
    }
    expect(posts).toHaveLength(2);
  });

  test('CLI push file then run recipe using injected global fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-cli-'));
    const file = join(dir, 'recipe.json');
    const authored: RecipeInput = {
      ...input,
      name: 'CliExportRecipe',
      code: 'export default (input) => input.word.toUpperCase();',
      inputSchema: { type: 'object', properties: { word: { type: 'string' } } },
    };
    writeFileSync(file, JSON.stringify(authored));
    const store = new Map<string, FullRecipe>();
    const oldFetch = globalThis.fetch;
    const logs: string[] = [];
    const oldLog = console.log;
    try {
      globalThis.fetch = fakeFetch(async (url, init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as RecipeInput;
          store.set(body.name, { ...body, version: 1, updatedAt: '', createdAt: '' });
          return Response.json({ name: body.name, version: 1 });
        }
        const name = url.toString().split('/recipe/')[1];
        const saved = store.get(name);
        return saved ? Response.json(saved) : new Response('not found', { status: 404 });
      });
      console.log = (value?: unknown) => {
        logs.push(String(value));
      };
      const { main } = await import('../src/cli.ts');
      process.argv = ['bun', 'pantry', 'push', file, '--json'];
      await main();
      process.argv = [
        'bun',
        'pantry',
        'run',
        'CliExportRecipe',
        '--input',
        '{"word":"ok"}',
        '--json',
      ];
      await main();
    } finally {
      globalThis.fetch = oldFetch;
      console.log = oldLog;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(JSON.parse(logs[0])).toEqual({ saved: { name: 'CliExportRecipe', version: 1 } });
    expect(JSON.parse(logs[1]).result).toMatchObject({ ok: true, output: 'OK' });
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

  test('push and run execute through OpenCode tool with POST body and run output', async () => {
    const posts: unknown[] = [];
    const saved: FullRecipe = {
      ...recipe,
      name: 'OpenCodeRecipe',
      code: 'export default (input) => input.n + 9;',
    };
    const oldFetch = globalThis.fetch;
    try {
      globalThis.fetch = fakeFetch(async (url, init) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return Response.json({ name: 'OpenCodeRecipe', version: 1 });
        }
        if (url.toString().includes('/recipe/OpenCodeRecipe')) return Response.json(saved);
        return Response.json({ recipes: [] });
      });
      const mod = await import('../extensions/opencode/index.ts');
      const plugin = await mod.default({} as never);
      const execute = plugin.tool?.pantry.execute;
      if (!execute) throw new Error('expected pantry tool execute');
      const pushed = await execute(
        { action: 'push', recipe: { ...input, name: 'OpenCodeRecipe' } },
        {} as never,
      );
      const ran = await execute(
        { action: 'run', name: 'OpenCodeRecipe', input: { n: 3 } },
        {} as never,
      );
      expect(JSON.parse(String(pushed))).toEqual({
        saved: { name: 'OpenCodeRecipe', version: 1 },
        url: 'https://x.test',
      });
      expect(JSON.parse(String(ran)).result).toMatchObject({ ok: true, output: 12 });
    } finally {
      globalThis.fetch = oldFetch;
    }
    expect(posts).toEqual([{ ...input, name: 'OpenCodeRecipe' }]);
  });
});
