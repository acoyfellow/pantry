import { describe, expect, test } from 'bun:test';
import app, { type Env } from '../src/worker.ts';
import {
  type HumanAuthorization,
  hasFolderPermission,
  hasWorkspaceRole,
} from '../src/workspace-authorization.ts';
import { FakeD1 } from './fake-d1.ts';

function setup(subject: string): { db: FakeD1; env: Env } {
  const db = new FakeD1();
  db.workspaces.push({
    id: 'workspace-1',
    slug: 'cloudflare-employees',
    display_name: 'Cloudflare Employees',
    status: 'active',
  });
  return {
    db,
    env: {
      DB: db as unknown as D1Database,
      PANTRY_EMPLOYEE_WORKSPACE_ENABLED: 'true',
      PANTRY_EMPLOYEE_WORKSPACE_SLUG: 'cloudflare-employees',
      PANTRY_LOCAL_DEVELOPMENT: 'true',
      PANTRY_DEV_ACCESS_IDENTITY: subject,
    },
  };
}

function request(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set('origin', 'https://pantry.test');
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`https://pantry.test${path}`, { ...init, headers });
}

function authorization(actorId: string, role: HumanAuthorization['role']): HumanAuthorization {
  return {
    actor: { id: actorId, kind: 'human', displayEmail: null },
    workspace: {
      id: 'workspace-1',
      slug: 'cloudflare-employees',
      displayName: 'Cloudflare Employees',
    },
    role,
    accessSubject: 'subject',
  };
}

describe('employee workspace foundation', () => {
  test('uses configured verified Access subject, never caller-provided actor or email header', async () => {
    const { db, env } = setup('access-subject-alice|Alice@Cloudflare.com');
    const response = await app.fetch(
      request('/api/session', {
        headers: {
          'cf-access-authenticated-user-email': 'mallory@cloudflare.com',
          'x-actor-id': 'mallory',
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      actor: { id: expect.any(String), displayEmail: 'alice@cloudflare.com' },
      workspace: { slug: 'cloudflare-employees' },
      role: 'reader',
    });
    expect(db.actors).toEqual([
      expect.objectContaining({
        access_subject: 'access-subject-alice',
        display_email_normalized: 'alice@cloudflare.com',
      }),
    ]);
  });

  test('fails closed when employee mode conflicts with legacy Access share-all or lacks local verified identity', async () => {
    const { env } = setup('access-subject-alice');
    env.PANTRY_ACCESS_SHARE_ALL = 'true';
    expect((await app.fetch(request('/api/session'), env)).status).toBe(503);
    env.PANTRY_ACCESS_SHARE_ALL = undefined;
    env.PANTRY_DEV_ACCESS_IDENTITY = undefined;
    expect((await app.fetch(request('/api/session'), env)).status).toBe(401);
  });

  test('enforces workspace role boundaries', () => {
    expect(hasWorkspaceRole('reader', 'contributor')).toBe(false);
    expect(hasWorkspaceRole('contributor', 'reviewer')).toBe(false);
    expect(hasWorkspaceRole('reviewer', 'reviewer')).toBe(true);
    expect(hasWorkspaceRole('admin', 'admin')).toBe(true);
  });

  test('requires active grants at every restricted folder ancestor', async () => {
    const { db } = setup('subject');
    db.folders.push(
      {
        id: 'root',
        workspace_id: 'workspace-1',
        parent_id: null,
        slug: 'root',
        display_name: 'Root',
        archived_at: null,
      },
      {
        id: 'restricted',
        workspace_id: 'workspace-1',
        parent_id: 'root',
        slug: 'restricted',
        display_name: 'Restricted',
        archived_at: null,
      },
      {
        id: 'child',
        workspace_id: 'workspace-1',
        parent_id: 'restricted',
        slug: 'child',
        display_name: 'Child',
        archived_at: null,
      },
    );
    db.folderPermissions.push({
      id: 'restricted-other-reader',
      folder_id: 'restricted',
      subject_actor_id: 'other-reader',
      permission: 'read',
      revoked_at: null,
    });
    expect(
      await hasFolderPermission(
        db as unknown as D1Database,
        authorization('reader', 'reader'),
        'child',
        'read',
      ),
    ).toBe(false);
    db.folderPermissions.push({
      id: 'restricted-read',
      folder_id: 'restricted',
      subject_actor_id: 'reader',
      permission: 'read',
      revoked_at: null,
    });
    expect(
      await hasFolderPermission(
        db as unknown as D1Database,
        authorization('reader', 'reader'),
        'child',
        'read',
      ),
    ).toBe(true);
    expect(
      await hasFolderPermission(
        db as unknown as D1Database,
        authorization('reader', 'reader'),
        'child',
        'write',
      ),
    ).toBe(false);
  });

  test('invitation acceptance requires the invited Access subject and emits source-free audit fields', async () => {
    const { db, env } = setup('admin-subject|admin@cloudflare.com');
    const session = await app.fetch(request('/api/session'), env);
    const actor = (await session.json()) as { actor: { id: string } };
    db.workspaceMemberships.push({
      id: 'admin-membership',
      workspace_id: 'workspace-1',
      actor_id: actor.actor.id,
      role: 'admin',
      source: 'admin-grant',
      valid_from: '2000-01-01T00:00:00.000Z',
      valid_until: null,
      revoked_at: null,
    });
    const invitation = await app.fetch(
      request('/api/workspaces/cloudflare-employees/invitations', {
        method: 'POST',
        body: JSON.stringify({ targetAccessSubject: 'invitee-subject', role: 'reviewer' }),
      }),
      env,
    );
    expect(invitation.status).toBe(201);
    const invitationBody = (await invitation.json()) as { id: string; token: string };
    expect(invitationBody.token).toBeTruthy();
    expect(db.auditEvents[0]).toMatchObject({
      action: 'invitation.created',
      actor_id: actor.actor.id,
      actor_kind: 'human',
      workspace_id: 'workspace-1',
    });
    expect(JSON.stringify(db.auditEvents[0])).not.toContain('token');

    expect(
      (
        await app.fetch(
          request(`/api/workspaces/cloudflare-employees/invitations/${invitationBody.id}/accept`, {
            method: 'POST',
          }),
          env,
        )
      ).status,
    ).toBe(403);
    env.PANTRY_DEV_ACCESS_IDENTITY = 'invitee-subject|invitee@cloudflare.com';
    const accepted = await app.fetch(
      request(`/api/workspaces/cloudflare-employees/invitations/${invitationBody.id}/accept`, {
        method: 'POST',
      }),
      env,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true, role: 'reviewer' });
    expect(db.workspaceMemberships.some((membership) => membership.role === 'reviewer')).toBe(true);
  });
});
