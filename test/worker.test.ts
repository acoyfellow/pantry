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
    const health = (await res.json()) as { ok: boolean; service: string };
    expect(health).toEqual({ ok: true, service: 'pantry' });
  });

  test('missing Access identity is unauthorized when Access is the configured boundary', async () => {
    const env: Env = {
      DB: new FakeD1() as unknown as D1Database,
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({ 'operator@example.com': 'operator' }),
    };
    const res = await app.fetch(req('/api/session', {}, false), env);
    expect(res.status).toBe(401);
  });

  test('Access-only deployment rejects bearer credentials', async () => {
    const env: Env = {
      DB: new FakeD1() as unknown as D1Database,
      PANTRY_TOKEN: TOKEN,
      PANTRY_ACCESS_ONLY: 'true',
    };
    const res = await app.fetch(req('/recipes'), env);
    expect(res.status).toBe(401);
  });

  test('unknown Access identity is rejected', async () => {
    const env: Env = {
      DB: new FakeD1() as unknown as D1Database,
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({ 'operator@example.com': 'operator' }),
    };
    const res = await app.fetch(
      new Request('https://pantry.test/api/session', {
        headers: {
          origin: 'https://pantry.test',
          'cf-access-authenticated-user-email': 'intruder@example.com',
        },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test('authorized Access team member receives a stable session principal and is same-origin only', async () => {
    const db = new FakeD1();
    db.teamMembers.push({ team_id: 'workspace', principal: 'workspace-owner', role: 'owner' });
    const env: Env = {
      DB: db as unknown as D1Database,
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({ 'operator@example.com': 'workspace-owner' }),
      PANTRY_ACCESS_TEAMS: JSON.stringify({ 'workspace-owner': 'workspace' }),
    };
    const request = new Request('https://pantry.test/api/session', {
      headers: {
        origin: 'https://pantry.test',
        'cf-access-authenticated-user-email': 'operator@example.com',
      },
    });
    const session = await app.fetch(request, env);
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as {
      principal: string;
      team: string;
      role: string;
    };
    expect(sessionBody).toEqual({
      principal: 'workspace-owner',
      team: 'workspace',
      role: 'owner',
    });
    const crossOrigin = await app.fetch(
      new Request('https://pantry.test/api/session', {
        headers: {
          origin: 'https://other.test',
          'cf-access-authenticated-user-email': 'operator@example.com',
        },
      }),
      env,
    );
    expect(crossOrigin.status).toBe(403);
  });

  test('Access principals require a configured database team membership', async () => {
    const env: Env = {
      DB: new FakeD1() as unknown as D1Database,
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({ 'operator@example.com': 'workspace-owner' }),
      PANTRY_ACCESS_TEAMS: JSON.stringify({ 'workspace-owner': 'workspace' }),
    };
    const session = await app.fetch(
      new Request('https://pantry.test/api/session', {
        headers: {
          origin: 'https://pantry.test',
          'cf-access-authenticated-user-email': 'operator@example.com',
        },
      }),
      env,
    );
    expect(session.status).toBe(403);
  });

  test('agent credentials are hashed, scoped, and blocked from management routes', async () => {
    const db = new FakeD1();
    db.teamMembers.push({ team_id: 'workspace', principal: 'workspace-owner', role: 'owner' });
    const env: Env = {
      DB: db as unknown as D1Database,
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({ 'owner@example.com': 'workspace-owner' }),
      PANTRY_ACCESS_TEAMS: JSON.stringify({ 'workspace-owner': 'workspace' }),
    };
    const accessHeaders = {
      origin: 'https://pantry.test',
      'cf-access-authenticated-user-email': 'owner@example.com',
      'content-type': 'application/json',
    };
    const created = await app.fetch(
      new Request('https://pantry.test/api/agent-credentials', {
        method: 'POST',
        headers: accessHeaders,
        body: JSON.stringify({ principal: 'build-agent', scopes: ['recipes:read'] }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; credential: string };
    expect(db.agentCredentials).toHaveLength(1);
    expect(db.agentCredentials[0]?.credential_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.agentCredentials[0]?.credential_hash).not.toBe(body.credential);
    const agentHeaders = {
      authorization: `Bearer ${body.credential}`,
      origin: 'https://agent.test',
    };
    expect(
      (await app.fetch(new Request('https://pantry.test/recipes', { headers: agentHeaders }), env))
        .status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          new Request('https://pantry.test/api/session', { headers: agentHeaders }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          new Request('https://pantry.test/recipe/slugify/approval', {
            method: 'POST',
            headers: agentHeaders,
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const rotated = await app.fetch(
      new Request(`https://pantry.test/api/agent-credentials/${body.id}/rotate`, {
        method: 'POST',
        headers: accessHeaders,
      }),
      env,
    );
    expect(rotated.status).toBe(200);
    const replacement = (await rotated.json()) as { id: string; credential: string };
    expect(
      (await app.fetch(new Request('https://pantry.test/recipes', { headers: agentHeaders }), env))
        .status,
    ).toBe(401);
    const replacementHeaders = {
      authorization: `Bearer ${replacement.credential}`,
      origin: 'https://agent.test',
    };
    expect(
      (
        await app.fetch(
          new Request('https://pantry.test/recipes', { headers: replacementHeaders }),
          env,
        )
      ).status,
    ).toBe(200);
    const revoked = await app.fetch(
      new Request(`https://pantry.test/api/agent-credentials/${replacement.id}`, {
        method: 'DELETE',
        headers: {
          origin: 'https://pantry.test',
          'cf-access-authenticated-user-email': 'owner@example.com',
        },
      }),
      env,
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await app.fetch(
          new Request('https://pantry.test/recipes', { headers: replacementHeaders }),
          env,
        )
      ).status,
    ).toBe(401);
  });

  test('legacy bearer tokens cannot approve recipes', async () => {
    const response = await app.fetch(
      req('/recipe/slugify/approval', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
      makeEnv(),
    );
    expect(response.status).toBe(403);
  });

  test('team members may review approvals but only approvers and owners may decide', async () => {
    const db = new FakeD1();
    db.teamMembers.push(
      { team_id: 'workspace', principal: 'reviewer', role: 'member' },
      { team_id: 'workspace', principal: 'approver', role: 'approver' },
    );
    const env: Env = {
      ...makeEnvForDb(db, 'workspace-owner'),
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({
        'reviewer@example.com': 'reviewer',
        'approver@example.com': 'approver',
      }),
      PANTRY_ACCESS_TEAMS: JSON.stringify({ reviewer: 'workspace', approver: 'workspace' }),
    };
    await app.fetch(req('/recipes', { method: 'POST', body: JSON.stringify(sample) }), {
      ...env,
      PANTRY_OWNER: 'approver',
    });
    const reviewerHeaders = {
      origin: 'https://pantry.test',
      'cf-access-authenticated-user-email': 'reviewer@example.com',
    };
    const queue = await app.fetch(
      new Request('https://pantry.test/api/approvals', { headers: reviewerHeaders }),
      env,
    );
    expect(queue.status).toBe(200);
    const denied = await app.fetch(
      new Request('https://pantry.test/recipe/slugify/approval', {
        method: 'POST',
        headers: { ...reviewerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          version: db.rows[0]?.version,
          recipeDigest: db.rows[0]?.recipe_digest,
        }),
      }),
      env,
    );
    expect(denied.status).toBe(403);
    const approved = await app.fetch(
      new Request('https://pantry.test/recipe/slugify/approval', {
        method: 'POST',
        headers: {
          origin: 'https://pantry.test',
          'cf-access-authenticated-user-email': 'approver@example.com',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          version: db.rows[0]?.version,
          recipeDigest: db.rows[0]?.recipe_digest,
        }),
      }),
      env,
    );
    expect(approved.status).toBe(200);
    expect(db.approvalReceipts[0]?.actor).toBe('approver@example.com');
  });
});

describe('collaborative approval hardening', () => {
  function makeApprovalEnv(db: FakeD1): Env {
    db.teamMembers.push({ team_id: 'workspace', principal: 'workspace-owner', role: 'owner' });
    return {
      ...makeEnvForDb(db, 'workspace-owner'),
      PANTRY_ACCESS_PRINCIPALS: JSON.stringify({ 'owner@example.com': 'workspace-owner' }),
      PANTRY_ACCESS_TEAMS: JSON.stringify({ 'workspace-owner': 'workspace' }),
    };
  }

  function approvalRequest(name: string, body: Record<string, unknown>): Request {
    return new Request(`https://pantry.test/recipe/${encodeURIComponent(name)}/approval`, {
      method: 'POST',
      headers: {
        origin: 'https://pantry.test',
        'cf-access-authenticated-user-email': 'owner@example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  test('rejects approval requests with a stale version or digest before creating a receipt', async () => {
    const db = new FakeD1();
    const env = makeApprovalEnv(db);
    const first = await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      env,
    );
    const firstSubject = (await first.json()) as { version: number; recipeDigest: string };
    const second = await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, code: 'return { slug: ctx.input.text.toLowerCase() };' }),
      }),
      env,
    );
    const secondSubject = (await second.json()) as { version: number; recipeDigest: string };

    const staleVersion = await app.fetch(
      approvalRequest('slugify', {
        action: 'approve',
        version: firstSubject.version,
        recipeDigest: firstSubject.recipeDigest,
      }),
      env,
    );
    const staleDigest = await app.fetch(
      approvalRequest('slugify', {
        action: 'approve',
        version: secondSubject.version,
        recipeDigest: firstSubject.recipeDigest,
      }),
      env,
    );

    expect(staleVersion.status).toBe(409);
    expect(staleDigest.status).toBe(409);
    expect(db.approvalReceipts).toHaveLength(0);
    expect(db.rows[0]).toMatchObject({
      version: secondSubject.version,
      recipe_digest: secondSubject.recipeDigest,
      status: 'pending',
    });
  });

  test('records one exact approval receipt when concurrent decisions race', async () => {
    const db = new FakeD1();
    const env = makeApprovalEnv(db);
    const pushed = await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      env,
    );
    const subject = (await pushed.json()) as { version: number; recipeDigest: string };
    const body = {
      action: 'approve',
      version: subject.version,
      recipeDigest: subject.recipeDigest,
    };
    const decisions = await Promise.all([
      app.fetch(approvalRequest('slugify', body), env),
      app.fetch(approvalRequest('slugify', body), env),
    ]);

    expect(decisions.map((decision) => decision.status).sort()).toEqual([200, 409]);
    expect(db.approvalReceipts).toHaveLength(1);
    expect(db.approvalReceipts[0]).toMatchObject({
      recipe_version: subject.version,
      recipe_digest: subject.recipeDigest,
      action: 'approve',
    });
    expect(db.rows[0]).toMatchObject({
      status: 'enabled',
      approved_version: subject.version,
      approved_digest: subject.recipeDigest,
      reviewed_version: subject.version,
      reviewed_digest: subject.recipeDigest,
    });
  });

  test('preserves immutable version snapshots and approval receipts across revisions', async () => {
    const db = new FakeD1();
    const env = makeApprovalEnv(db);
    const first = await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      env,
    );
    const firstSubject = (await first.json()) as { version: number; recipeDigest: string };
    const approved = await app.fetch(
      approvalRequest('slugify', {
        action: 'approve',
        version: firstSubject.version,
        recipeDigest: firstSubject.recipeDigest,
      }),
      env,
    );
    expect(approved.status).toBe(200);

    const revisedCode = 'return { slug: ctx.input.text.toLowerCase() };';
    const second = await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({
          ...sample,
          description: 'turn text into a lowercase slug',
          code: revisedCode,
        }),
      }),
      env,
    );
    expect(second.status).toBe(200);

    expect(db.recipeVersions).toEqual([
      expect.objectContaining({
        recipe_version: 1,
        recipe_digest: firstSubject.recipeDigest,
        code: sample.code,
      }),
      expect.objectContaining({ recipe_version: 2, code: revisedCode }),
    ]);
    expect(db.approvalReceipts).toEqual([
      expect.objectContaining({
        recipe_version: 1,
        recipe_digest: firstSubject.recipeDigest,
        source_code: sample.code,
      }),
    ]);
    expect(db.rows[0]).toMatchObject({ version: 2, code: revisedCode, status: 'pending' });
  });

  test('attributes shared usage to the caller while preserving the recipe owner', async () => {
    const db = new FakeD1();
    const owner = makeEnvForDb(db, 'alice');
    const caller = makeEnvForDb(db, 'bob');
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'sharedUsageAttribution', visibility: 'shared' }),
      }),
      owner,
    );

    const usage = await app.fetch(
      req('/recipe/sharedUsageAttribution/usage', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'bob-shared-use', version: 1, outcome: 'success' }),
      }),
      caller,
    );

    expect(usage.status).toBe(200);
    expect(db.usageReports).toEqual([
      expect.objectContaining({
        id: 'bob-shared-use',
        owner: 'alice',
        recipe_name: 'sharedUsageAttribution',
        reporter: 'bob',
        version: 1,
      }),
    ]);
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
    expect(await post.json()).toMatchObject({
      name: 'slugify',
      version: 1,
      recipeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const list = await app.fetch(req('/recipes'), env);
    const listBody = (await list.json()) as { recipes: Array<Record<string, unknown>> };
    expect(listBody.recipes).toHaveLength(1);
    expect('code' in listBody.recipes[0]).toBe(false);
    expect(JSON.stringify(listBody)).not.toContain(sample.code);
    expect(JSON.stringify(listBody)).not.toContain(TOKEN);
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

  test('F1: ?q= filters by keyword and ?capability= filters by tag, code excluded', async () => {
    await app.fetch(req('/recipes', { method: 'POST', body: JSON.stringify(sample) }), env);
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({
          ...sample,
          name: 'deployWorker',
          description: 'deploy a worker',
          capabilities: ['machine.deploy'],
        }),
      }),
      env,
    );
    const byQ = (await (await app.fetch(req('/recipes?q=slug'), env)).json()) as {
      recipes: Array<{ name: string }>;
    };
    expect(byQ.recipes.map((r) => r.name)).toEqual(['slugify']);
    const byCap = (await (
      await app.fetch(req('/recipes?capability=machine.deploy'), env)
    ).json()) as { recipes: Array<{ name: string }> };
    expect(byCap.recipes.map((r) => r.name)).toEqual(['deployWorker']);
    const all = (await (await app.fetch(req('/recipes'), env)).json()) as {
      scope: string;
      recipes: Array<Record<string, unknown>>;
    };
    expect(all.scope).toBe('owner');
    expect(all.recipes).toHaveLength(2);
    expect('code' in all.recipes[0]).toBe(false);
  });

  test('F2: push lint warns on non-determinism and bad input-contract; pure recipe is clean', async () => {
    const rnd = await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({
          ...sample,
          name: 'randy',
          code: 'export default () => ({ v: Math.random() })',
        }),
      }),
      env,
    );
    const rndBody = (await rnd.json()) as { warnings?: string[] };
    expect(rndBody.warnings?.[0]).toContain('determinism');

    const bad = await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'badcontract', code: 'return { v: input.text };' }),
      }),
      env,
    );
    const badBody = (await bad.json()) as { warnings?: string[] };
    expect(badBody.warnings?.[0]).toContain('contract');

    const pure = await app.fetch(
      req('/recipes', { method: 'POST', body: JSON.stringify(sample) }),
      env,
    );
    expect('warnings' in ((await pure.json()) as object)).toBe(false);
  });

  test('F2: ?strict=1 rejects a recipe that fails the lint', async () => {
    const res = await app.fetch(
      req('/recipes?strict=1', {
        method: 'POST',
        body: JSON.stringify({
          ...sample,
          name: 'strictfail',
          code: 'export default () => ({ v: Math.random() })',
        }),
      }),
      env,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('LintFailed');
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
    const body = (await res.json()) as { scope: string; recipes: Array<Record<string, unknown>> };
    expect(body.scope).toBe('shared');
    expect(body.recipes.map((r) => r.name)).toEqual(['sharedOne']);
    expect(body.recipes[0].author).toBe('bob');
    expect(body.recipes[0].visibility).toBe('shared');
    expect('code' in body.recipes[0]).toBe(false);
  });

  test('tags, caller-reported usage, idempotency, and private share candidates are owner-safe', async () => {
    const db = new FakeD1();
    const alice = makeEnvForDb(db, 'alice');
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({
          ...sample,
          name: 'reviewGate',
          tags: ['mr/review', 'deploy/check'],
        }),
      }),
      alice,
    );
    for (let i = 0; i < 5; i++) {
      const usage = await app.fetch(
        req('/recipe/reviewGate/usage', {
          method: 'POST',
          body: JSON.stringify({ eventId: `alice-run-${i}`, version: 1, outcome: 'success' }),
        }),
        alice,
      );
      expect(usage.status).toBe(200);
    }
    const duplicate = await app.fetch(
      req('/recipe/reviewGate/usage', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'alice-run-0', version: 1, outcome: 'success' }),
      }),
      alice,
    );
    expect(await duplicate.json()).toMatchObject({ recorded: false, runCount: 5 });
    const list = (await (await app.fetch(req('/recipes?tag=mr/review'), alice)).json()) as {
      recipes: Array<Record<string, unknown>>;
    };
    expect(list.recipes[0]).toMatchObject({
      tags: ['deploy/check', 'mr/review'],
      runCount: 5,
      shareCandidate: true,
    });
    const bob = makeEnvForDb(db, 'bob');
    const bobPrivate = await app.fetch(req('/recipes?scope=shared'), bob);
    expect((await bobPrivate.json()) as { recipes: unknown[] }).toMatchObject({ recipes: [] });
  });

  test('shared usage is reportable by a recipient without exposing private candidates', async () => {
    const db = new FakeD1();
    const alice = makeEnvForDb(db, 'alice');
    const bob = makeEnvForDb(db, 'bob');
    await app.fetch(
      req('/recipes', {
        method: 'POST',
        body: JSON.stringify({
          ...sample,
          name: 'sharedUsage',
          visibility: 'shared',
          tags: ['team/review'],
        }),
      }),
      alice,
    );
    const usage = await app.fetch(
      req('/recipe/sharedUsage/usage', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'bob-run-1', version: 1, outcome: 'success' }),
      }),
      bob,
    );
    expect(await usage.json()).toMatchObject({ recorded: true, runCount: 1 });
    const shared = (await (
      await app.fetch(req('/recipes?scope=shared&tag=team/review'), bob)
    ).json()) as {
      recipes: Array<Record<string, unknown>>;
    };
    expect(shared.recipes[0]).toMatchObject({
      runCount: 1,
      shareCandidate: false,
      tags: ['team/review'],
    });
    expect('code' in shared.recipes[0]).toBe(false);
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
    expect(await again.json()).toMatchObject({
      name: 'slugify',
      version: 2,
      recipeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

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

  test('invalid list scope fails closed instead of silently falling back to owner', async () => {
    const res = await app.fetch(req('/recipes?scope=recipient'), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body).toEqual({
      error: 'scope must be owner or shared',
      code: 'InvalidInput',
    });
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
    expect((await list.json()) as { scope: string; recipes: unknown[] }).toEqual({
      scope: 'owner',
      recipes: [],
    });
    const sharedList = await app.fetch(req('/recipes?scope=shared'), otherEnv);
    expect((await sharedList.json()) as { scope: string; recipes: unknown[] }).toEqual({
      scope: 'shared',
      recipes: [],
    });
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

describe('F3: multi-owner trust (token -> owner) with cross-owner isolation', () => {
  const ALICE = 'alice-token-aaa';
  const BOB = 'bob-token-bbb';
  function multiEnv(db: FakeD1): Env {
    return {
      DB: db as unknown as D1Database,
      PANTRY_TOKEN: undefined,
      PANTRY_OWNER: undefined,
      PANTRY_TOKENS: JSON.stringify({ [ALICE]: 'alice', [BOB]: 'bob' }),
    } as Env;
  }
  const as = (token: string, path: string, init: { method?: string; body?: string } = {}) => {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${token}`);
    headers.set('origin', 'https://app.test');
    if (init.body) headers.set('content-type', 'application/json');
    return new Request(`https://pantry.test${path}`, { ...init, headers });
  };

  test('distinct tokens map to distinct owners; a bad token is 401', async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    const bad = await app.fetch(as('nope-token', '/recipes'), env);
    expect(bad.status).toBe(401);
    const ok = await app.fetch(as(ALICE, '/recipes'), env);
    expect(ok.status).toBe(200);
  });

  test("alice CANNOT see or fetch bob's PRIVATE recipe (isolation)", async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    // bob pushes a private recipe
    await app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'bobsecret' }),
      }),
      env,
    );
    // alice lists (owner scope) — must NOT include bob's private
    const aliceList = (await (await app.fetch(as(ALICE, '/recipes'), env)).json()) as {
      scope: string;
      recipes: Array<{ name: string }>;
    };
    expect(aliceList.scope).toBe('owner');
    expect(aliceList.recipes.map((r) => r.name)).not.toContain('bobsecret');
    // alice tries to GET bob's private by name — must 404 (not leak)
    const aliceGet = await app.fetch(as(ALICE, '/recipe/bobsecret'), env);
    expect(aliceGet.status).toBe(404);
  });

  test("alice CAN read+run bob's SHARED recipe and sees bob as author", async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    await app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'bobshared', visibility: 'shared' }),
      }),
      env,
    );
    const shared = (await (await app.fetch(as(ALICE, '/recipes?scope=shared'), env)).json()) as {
      recipes: Array<{ name: string; author: string }>;
    };
    const entry = shared.recipes.find((r) => r.name === 'bobshared');
    expect(entry).toBeTruthy();
    expect(entry?.author).toBe('bob');
    const full = (await (await app.fetch(as(ALICE, '/recipe/bobshared'), env)).json()) as {
      code: string;
      author: string;
    };
    expect(full.code).toBe(sample.code);
    expect(full.author).toBe('bob');
  });

  test("alice CANNOT delete bob's recipe (owner-scoped writes)", async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    await app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'bobowned' }),
      }),
      env,
    );
    const del = await app.fetch(as(ALICE, '/recipe/bobowned', { method: 'DELETE' }), env);
    expect(del.status).toBe(404); // alice has no such recipe to delete; bob's is untouched
    const bobStill = await app.fetch(as(BOB, '/recipe/bobowned'), env);
    expect(bobStill.status).toBe(200);
  });

  test('G5 legacy recipes without a canonical digest remain unattestable until re-pushed', async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    const created = await app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'g5legacy' }),
      }),
      env,
    );
    const body = (await created.json()) as { version: number; recipeDigest: string };
    db.rows[0].recipe_digest = null;

    const attestation = await app.fetch(
      as(BOB, '/recipe/g5legacy/attestations', {
        method: 'POST',
        body: JSON.stringify({
          version: body.version,
          recipeDigest: body.recipeDigest,
          witnessReceiptSha256: 'c'.repeat(64),
        }),
      }),
      env,
    );
    expect(attestation.status).toBe(409);
  });

  test('G5 attestations bind only Bob’s current private recipe subject and expose no code', async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    const receiptA = 'a'.repeat(64);
    const receiptB = 'b'.repeat(64);
    const created = await app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'g5private' }),
      }),
      env,
    );
    const createdBody = (await created.json()) as { version: number; recipeDigest?: string };
    expect(created.status).toBe(201);
    expect(createdBody.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
    const subject = {
      version: createdBody.version,
      recipeDigest: createdBody.recipeDigest,
      witnessReceiptSha256: receiptA,
    };

    const first = await app.fetch(
      as(BOB, '/recipe/g5private/attestations', { method: 'POST', body: JSON.stringify(subject) }),
      env,
    );
    expect(first.status).toBe(201);
    const retry = await app.fetch(
      as(BOB, '/recipe/g5private/attestations', { method: 'POST', body: JSON.stringify(subject) }),
      env,
    );
    expect(retry.status).toBe(200);
    const read = await app.fetch(
      as(
        BOB,
        `/recipe/g5private/attestations?version=${subject.version}&recipeDigest=${subject.recipeDigest}`,
      ),
      env,
    );
    expect(read.status).toBe(200);
    const readText = await read.text();
    expect(readText).not.toContain(sample.code);
    expect(readText).not.toContain('code');

    const malicious = await app.fetch(
      as(BOB, '/recipe/g5private/attestations', {
        method: 'POST',
        body: JSON.stringify({
          ...subject,
          code: 'leak',
          authority: 'release',
          issuer: 'x',
          signature: 'x',
        }),
      }),
      env,
    );
    expect(malicious.status).toBe(400);

    const update = await app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'g5private', description: 'changed' }),
      }),
      env,
    );
    const updateBody = (await update.json()) as { version: number; recipeDigest: string };
    expect(updateBody.version).toBe(2);
    expect(updateBody.recipeDigest).not.toBe(subject.recipeDigest);
    const stale = await app.fetch(
      as(BOB, '/recipe/g5private/attestations', { method: 'POST', body: JSON.stringify(subject) }),
      env,
    );
    expect(stale.status).toBe(409);
    const equivocated = await app.fetch(
      as(BOB, '/recipe/g5private/attestations', {
        method: 'POST',
        body: JSON.stringify({
          version: updateBody.version,
          recipeDigest: updateBody.recipeDigest,
          witnessReceiptSha256: receiptA,
        }),
      }),
      env,
    );
    expect(equivocated.status).toBe(409);
    const secondReceipt = await app.fetch(
      as(BOB, '/recipe/g5private/attestations', {
        method: 'POST',
        body: JSON.stringify({
          version: updateBody.version,
          recipeDigest: updateBody.recipeDigest,
          witnessReceiptSha256: receiptB,
        }),
      }),
      env,
    );
    expect(secondReceipt.status).toBe(201);

    const aliceWrite = await app.fetch(
      as(ALICE, '/recipe/g5private/attestations', {
        method: 'POST',
        body: JSON.stringify(subject),
      }),
      env,
    );
    const aliceRead = await app.fetch(
      as(
        ALICE,
        `/recipe/g5private/attestations?version=${subject.version}&recipeDigest=${subject.recipeDigest}`,
      ),
      env,
    );
    expect(aliceWrite.status).toBe(404);
    expect(aliceRead.status).toBe(404);

    const unauthenticated = await app.fetch(
      new Request('https://pantry.test/recipe/g5private/attestations', { method: 'POST' }),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    const attestationSelects = db.preparedSql.filter((sql) => sql.startsWith('SELECT'));
    expect(attestationSelects.every((sql) => !/\bcode\b/i.test(sql))).toBe(true);
    expect(attestationSelects.some((sql) => sql.startsWith('SELECT *'))).toBe(false);
  });

  test('concurrent pushes receive distinct versions and matching digests', async () => {
    const db = new FakeD1();
    const env = multiEnv(db);
    let entered = 0;
    let markReady: () => void = () => {};
    let releaseWrites: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    db.beforeRecipeUpsert = async () => {
      entered += 1;
      if (entered <= 2) {
        if (entered === 2) markReady();
        await writeGate;
      }
    };

    const first = app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'concurrentPush', description: 'first update' }),
      }),
      env,
    );
    const second = app.fetch(
      as(BOB, '/recipes', {
        method: 'POST',
        body: JSON.stringify({ ...sample, name: 'concurrentPush', description: 'second update' }),
      }),
      env,
    );
    await ready;
    releaseWrites();
    const responses = await Promise.all([first, second]);
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: (await response.json()) as { version: number; recipeDigest: string },
      })),
    );

    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(results.map((result) => result.body.version).sort()).toEqual([1, 2]);
    expect(new Set(results.map((result) => result.body.recipeDigest)).size).toBe(2);
    const latest = (await (await app.fetch(as(BOB, '/recipe/concurrentPush'), env)).json()) as {
      version: number;
      description: string;
    };
    const latestResult = results.find((result) => result.body.version === latest.version);
    expect(latest).toMatchObject({ version: 2, description: 'second update' });
    expect(latestResult?.body.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
