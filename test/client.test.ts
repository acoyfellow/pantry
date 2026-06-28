import { describe, expect, test } from 'bun:test';
import { sampleRecipe } from '../examples/sample-recipe.ts';
import { PantryClient } from '../src/client.ts';

// An injected fetch that records calls and returns canned responses.
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const config = { url: 'https://pantry.test', token: 'tok' };

describe('PantryClient', () => {
  test('unconfigured client lists nothing (fail-soft) and throws clear errors on get/push', async () => {
    const client = new PantryClient({
      fetch: (async () => new Response()) as unknown as typeof fetch,
    });
    expect(client.configured).toBe(false);
    expect(await client.list()).toEqual([]);
    await expect(client.get('x')).rejects.toThrow(/PANTRY_URL is not set/);
  });

  test('list sends bearer token and returns recipes', async () => {
    const { fn, calls } = fakeFetch(() =>
      Response.json({ recipes: [{ name: 'slugify', version: 1 }] }),
    );
    const client = new PantryClient({ ...config, fetch: fn });
    const recipes = await client.list();
    expect(recipes).toHaveLength(1);
    expect(calls[0].url).toBe('https://pantry.test/recipes');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  test('get returns the full recipe including code; 404 => null', async () => {
    const { fn } = fakeFetch((url) =>
      url.endsWith('/recipe/slugify')
        ? Response.json({ name: 'slugify', code: 'return 1;', capabilities: ['text.transform'] })
        : new Response(null, { status: 404 }),
    );
    const client = new PantryClient({ ...config, fetch: fn });
    const got = await client.get('slugify');
    expect(got?.code).toBe('return 1;');
    expect(await client.get('missing')).toBeNull();
  });

  test('push posts JSON and returns name/version', async () => {
    const { fn, calls } = fakeFetch(() =>
      Response.json({ name: 'slugify', version: 2 }, { status: 200 }),
    );
    const client = new PantryClient({ ...config, fetch: fn });
    const result = await client.push(sampleRecipe);
    expect(result).toEqual({ name: 'slugify', version: 2 });
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body)).name).toBe('slugify');
  });

  test('push surfaces server error detail', async () => {
    const { fn } = fakeFetch(() => new Response('bad', { status: 400 }));
    const client = new PantryClient({ ...config, fetch: fn });
    await expect(client.push(sampleRecipe)).rejects.toThrow(/push failed: 400/);
  });
});
