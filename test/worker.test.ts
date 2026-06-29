import { beforeEach, describe, expect, test } from 'bun:test';
import app, { type Env, corsHeaders, timingSafeEqual } from '../src/worker.ts';
import { FakeD1 } from './fake-d1.ts';

const TOKEN = 'super-secret-token';

function makeEnv(token: string | undefined = TOKEN): Env {
  return makeEnvForDb(new FakeD1(), 'default', token);
}

function makeEnvForDb(db: FakeD1, owner: string, token: string | undefined = TOKEN): Env {
  return {
    DB: db as unknown as D1Database,
    PANTRY_TOKEN: token,
    PANTRY_OWNER: owner,
  };
}

function makeUnconfiguredEnv(): Env {
  return {
    DB: new FakeD1() as unknown as D1Database,
    PANTRY_TOKEN: undefined,
    PANTRY_OWNER: 'default',
  };
}

function req(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  auth = true,
  origin = 'https://app.test',
) {
  const headers = new Headers(init.headers);
  if (auth) headers.set('authorization', `Bearer ${TOKEN}`);
  if (origin) headers.set('origin', origin);
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`https://pantry.test${path}`, { ...init, headers });
}

const sample = {
  name: 'slugify',
  description: 'turn text into a slug',
  inputSchema: { type: 'object', properties: {} },
  code: 'return { slug: ctx.input.text };',
  capabilities: ['text.transform'],
};

describe('helpers', () => {
  test('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  test('corsHeaders echoes origin', () => {
    expect(corsHeaders('https://x.test')['access-control-allow-origin']).toBe('https://x.test');
    expect(corsHeaders(null)['access-control-allow-origin']).toBe('*');
  });
});

describe('auth gate (fail-closed)', () => {
  test('OPTIONS returns 204 with ACAO BEFORE auth (no token header)', async () => {
    const res = await app.fetch(req('/recipes', { method: 'OPTIONS' }, false), makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });

  test('missing token => 401', async () => {
    const res = await app.fetch(req('/recipes', {}, false), makeEnv());
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });

  test('wrong token => 401', async () => {
    const r = new Request('https://pantry.test/recipes', {
      headers: { authorization: 'Bearer wrong', origin: 'https://app.test' },
    });
    const res = await app.fetch(r, makeEnv());
    expect(res.status).toBe(401);
  });

  test('unconfigured server (no PANTRY_TOKEN) => 503, never open', async () => {
    const res = await app.fetch(req('/recipes', {}, true), makeUnconfiguredEnv());
    expect(res.status).toBe(503);
  });

  test('health is open and needs no token', async () => {
    const res = await app.fetch(req('/health', {}, false), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'pantry' });
  });
});

describe('routes round-trip', () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });

  test('POST creates (201), GET list omits code, GET :name returns code', async () => {
    const post = await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      env,
    );
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({ name: 'slugify', version: 1 });

    const list = await app.fetch(req('/recipes'), env);
    const listBody = (await list.json()) as { recipes: Array<Record<string, unknown>> };
    expect(listBody.recipes).toHaveLength(1);
    expect('code' in listBody.recipes[0]).toBe(false);
    expect(listBody.recipes[0].version).toBe(1);

    const get = await app.fetch(req('/recipe/slugify'), env);
    const full = (await get.json()) as {
      code: string;
      capabilities: string[];
      visibility: string;
      author: string;
    };
    expect(full.code).toBe(sample.code);
    expect(full.capabilities).toEqual(['text.transform']);
    expect(full.visibility).toBe('private');
    expect(full.author).toBe('default');
  });

  test('shared scope lists shared recipes across owners with author and without code', async () => {
    const db = new FakeD1();
    await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      makeEnvForDb(db, 'alice'),
    );
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'sharedOne', visibility: 'shared' }),
      }),
      makeEnvForDb(db, 'bob'),
    );

    const res = await app.fetch(req('/recipes?scope=shared'), makeEnvForDb(db, 'alice'));
    const body = (await res.json()) as { recipes: Array<Record<string, unknown>> };
    expect(body.recipes.map((r) => r.name)).toEqual(['sharedOne']);
    expect(body.recipes[0].author).toBe('bob');
    expect(body.recipes[0].visibility).toBe('shared');
    expect('code' in body.recipes[0]).toBe(false);
  });

  test('GET own recipe wins before shared recipe of same name', async () => {
    const db = new FakeD1();
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, code: 'return "shared";', visibility: 'shared' }),
      }),
      makeEnvForDb(db, 'bob'),
    );
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, code: 'return "own";' }),
      }),
      makeEnvForDb(db, 'alice'),
    );
    const own = await app.fetch(req('/recipe/slugify'), makeEnvForDb(db, 'alice'));
    expect(((await own.json()) as { code: string; author: string }).code).toBe('return "own";');
    const shared = await app.fetch(req('/recipe/slugify'), makeEnvForDb(db, 'charlie'));
    const sharedBody = (await shared.json()) as { code: string; author: string };
    expect(sharedBody.code).toBe('return "shared";');
    expect(sharedBody.author).toBe('bob');
  });

  test('re-POST upserts and bumps version (200)', async () => {
    await app.fetch(req('/recipes', { method: 'POST', body: JSON.stringify(sample) }), env);
    const again = await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, description: 'updated description' }),
      }),
      env,
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ name: 'slugify', version: 2 });

    const get = await app.fetch(req('/recipe/slugify'), env);
    const full = (await get.json()) as { version: number; description: string };
    expect(full.version).toBe(2);
    expect(full.description).toBe('updated description');
  });

  test('invalid recipe => 400', async () => {
    const res = await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify({ ...sample, name: 'bad name' }) }),
      env,
    );
    expect(res.status).toBe(400);
  });

  test('GET missing => 404', async () => {
    const res = await app.fetch(req('/recipe/nope'), env);
    expect(res.status).toBe(404);
  });

  test('DELETE removes; second DELETE => 404', async () => {
    await app.fetch(req('/recipes', { method: 'POST', body: JSON.stringify(sample) }), env);
    const del = await app.fetch(req('/recipe/slugify', { method: 'DELETE' }), env);
    expect(del.status).toBe(200);
    const again = await app.fetch(req('/recipe/slugify', { method: 'DELETE' }), env);
    expect(again.status).toBe(404);
  });

  test('owner isolation: a different owner cannot see another owner private rows', async () => {
    await app.fetch(req('/recipes', { method: 'POST', body: JSON.stringify(sample) }), env);
    const otherEnv: Env = { ...env, PANTRY_OWNER: 'someone-else' };
    const list = await app.fetch(req('/recipes'), otherEnv);
    expect((await list.json()) as { recipes: unknown[] }).toEqual({ recipes: [] });
    const sharedList = await app.fetch(req('/recipes?scope=shared'), otherEnv);
    expect((await sharedList.json()) as { recipes: unknown[] }).toEqual({ recipes: [] });
    const get = await app.fetch(req('/recipe/slugify'), otherEnv);
    expect(get.status).toBe(404);
  });

  test('another owner cannot flip someone else visibility', async () => {
    const db = new FakeD1();
    await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      makeEnvForDb(db, 'alice'),
    );
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, visibility: 'shared' }),
      }),
      makeEnvForDb(db, 'bob'),
    );
    const alice = await app.fetch(req('/recipe/slugify'), makeEnvForDb(db, 'alice'));
    expect(((await alice.json()) as { visibility: string }).visibility).toBe('private');
    const bob = await app.fetch(req('/recipe/slugify'), makeEnvForDb(db, 'bob'));
    const bobBody = (await bob.json()) as { visibility: string; author: string };
    expect(bobBody.visibility).toBe('shared');
    expect(bobBody.author).toBe('bob');
  });

  test('every response carries ACAO', async () => {
    const res = await app.fetch(req('/recipes'), env);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });
});
