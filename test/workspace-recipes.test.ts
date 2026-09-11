import { describe, expect, test } from 'bun:test';
import app, { type Env } from '../src/worker.ts';
import { FakeD1 } from './fake-d1.ts';

const workspaceSlug = 'cloudflare-employees';

function request(path: string, init: { method?: string; body?: string } = {}): Request {
  const headers = new Headers({ origin: 'https://pantry.test' });
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`https://pantry.test${path}`, { ...init, headers });
}

function environment(db: FakeD1, subject: string): Env {
  return {
    DB: db as unknown as D1Database,
    PANTRY_EMPLOYEE_WORKSPACE_ENABLED: 'true',
    PANTRY_EMPLOYEE_WORKSPACE_SLUG: workspaceSlug,
    PANTRY_LOCAL_DEVELOPMENT: 'true',
    PANTRY_DEV_ACCESS_IDENTITY: subject,
  };
}

const recipe = {
  name: 'slugify',
  description: 'turn text into a slug',
  inputSchema: { type: 'object', properties: {} },
  code: 'return { slug: ctx.input.text };',
  capabilities: ['text.transform'],
};

async function makeAdmin(db: FakeD1, env: Env): Promise<string> {
  const session = await app.fetch(request('/api/session'), env);
  const body = (await session.json()) as { actor: { id: string } };
  db.workspaceMemberships.push({
    id: `admin-${body.actor.id}`,
    workspace_id: 'workspace-1',
    actor_id: body.actor.id,
    role: 'admin',
    source: 'admin-grant',
    valid_from: '2000-01-01T00:00:00.000Z',
    valid_until: null,
    revoked_at: null,
  });
  return body.actor.id;
}

function setup(): { db: FakeD1; env: Env } {
  const db = new FakeD1();
  db.workspaces.push({
    id: 'workspace-1',
    slug: workspaceSlug,
    display_name: 'Cloudflare Employees',
    status: 'active',
  });
  db.folders.push({
    id: 'root',
    workspace_id: 'workspace-1',
    parent_id: null,
    slug: 'root',
    display_name: 'Root',
    archived_at: null,
  });
  return { db, env: environment(db, 'admin-subject|admin@cloudflare.com') };
}

describe('workspace recipe inventory', () => {
  test('filters inaccessible folders and returns creator and last-editor attribution', async () => {
    const { db, env } = setup();
    const adminId = await makeAdmin(db, env);
    const created = await app.fetch(
      request(`/api/workspaces/${workspaceSlug}/recipes`, {
        method: 'POST',
        body: JSON.stringify({ folderId: 'root', recipe }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    expect((await created.json()) as unknown).toMatchObject({
      recipe: {
        recipeKey: 'slugify',
        createdBy: { id: adminId, displayEmail: 'admin@cloudflare.com' },
        updatedBy: { id: adminId, displayEmail: 'admin@cloudflare.com' },
        folder: { id: 'root' },
      },
    });

    const contributorEnv = environment(db, 'editor-subject|editor@cloudflare.com');
    const contributorSession = await app.fetch(request('/api/session'), contributorEnv);
    const contributor = (await contributorSession.json()) as { actor: { id: string } };
    db.workspaceMemberships.push({
      id: 'contributor',
      workspace_id: 'workspace-1',
      actor_id: contributor.actor.id,
      role: 'contributor',
      source: 'admin-grant',
      valid_from: '2000-01-01T00:00:00.000Z',
      valid_until: null,
      revoked_at: null,
    });
    const revised = await app.fetch(
      request(`/api/workspaces/${workspaceSlug}/recipes/slugify/revisions`, {
        method: 'POST',
        body: JSON.stringify({ recipe: { ...recipe, code: 'return { slug: ctx.input.text };' } }),
      }),
      contributorEnv,
    );
    expect(revised.status).toBe(200);

    const inventory = await app.fetch(request(`/api/workspaces/${workspaceSlug}/recipes`), env);
    expect(inventory.status).toBe(200);
    expect((await inventory.json()) as unknown).toMatchObject({
      recipes: [
        {
          recipeKey: 'slugify',
          createdBy: { id: adminId },
          updatedBy: { id: contributor.actor.id, displayEmail: 'editor@cloudflare.com' },
        },
      ],
    });

    db.folders.push({
      id: 'restricted',
      workspace_id: 'workspace-1',
      parent_id: 'root',
      slug: 'restricted',
      display_name: 'Restricted',
      archived_at: null,
    });
    const firstRow = db.rows[0];
    expect(firstRow).toBeDefined();
    firstRow.folder_id = 'restricted';
    db.folderPermissions.push({
      id: 'restricted-admin',
      folder_id: 'restricted',
      subject_actor_id: adminId,
      permission: 'read',
      revoked_at: null,
    });
    const readerEnv = environment(db, 'reader-subject|reader@cloudflare.com');
    expect(
      (await app.fetch(request(`/api/workspaces/${workspaceSlug}/recipes`), readerEnv)).status,
    ).toBe(200);
    expect(
      await (
        await app.fetch(request(`/api/workspaces/${workspaceSlug}/recipes`), readerEnv)
      ).json(),
    ).toEqual({
      recipes: [],
    });
  });

  test('returns only approved pinned source and records source-free activity', async () => {
    const { db, env } = setup();
    await makeAdmin(db, env);
    const created = await app.fetch(
      request(`/api/workspaces/${workspaceSlug}/recipes`, {
        method: 'POST',
        body: JSON.stringify({ folderId: 'root', recipe }),
      }),
      env,
    );
    const createdBody = (await created.json()) as {
      recipe: { version: number; recipeDigest: string };
    };
    const unapproved = await app.fetch(
      request(`/api/workspaces/${workspaceSlug}/recipes/slugify/versions/1/source`),
      env,
    );
    expect(unapproved.status).toBe(409);

    const reviewed = await app.fetch(
      request(`/api/workspaces/${workspaceSlug}/recipes/slugify/versions/1/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'approve',
          recipeDigest: createdBody.recipe.recipeDigest,
        }),
      }),
      env,
    );
    expect(reviewed.status).toBe(200);
    const source = await app.fetch(
      request(`/api/workspaces/${workspaceSlug}/recipes/slugify/versions/1/source`),
      env,
    );
    expect(source.status).toBe(200);
    expect((await source.json()) as unknown).toMatchObject({
      recipeKey: 'slugify',
      version: 1,
      code: recipe.code,
    });

    const activity = await app.fetch(request(`/api/workspaces/${workspaceSlug}/audit-events`), env);
    expect(activity.status).toBe(200);
    const body = (await activity.json()) as { events: Array<Record<string, unknown>> };
    expect(body.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['recipe.created', 'recipe.reviewed', 'recipe.retrieved']),
    );
    expect(JSON.stringify(body.events)).not.toContain(recipe.code);
  });

  test('leaves owner-scoped recipes unchanged while the workspace flag is disabled', async () => {
    const db = new FakeD1();
    const token = ['legacy', 'token'].join('-');
    const env: Env = { DB: db as unknown as D1Database, PANTRY_TOKEN: token };
    const created = await app.fetch(
      new Request('https://pantry.test/recipes', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(recipe),
      }),
      env,
    );
    expect(created.status).toBe(201);
    expect(db.rows[0]?.owner).toBe('default');
    expect(db.rows[0]).not.toHaveProperty('workspace_id');
    expect(
      (
        await app.fetch(
          new Request(`https://pantry.test/api/workspaces/${workspaceSlug}/recipes`, {
            headers: { authorization: `Bearer ${token}` },
          }),
          env,
        )
      ).status,
    ).toBe(403);
  });
});
