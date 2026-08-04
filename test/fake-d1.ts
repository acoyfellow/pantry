// A tiny in-memory D1 stand-in for the exact subset of SQL the worker uses.
// Not a general SQL engine: it pattern-matches the handful of statements in
// src/worker.ts so route tests run with `bun test` and no real D1.

import type { RecipeRow } from '../src/recipe.ts';

type Row = RecipeRow;
type TeamMember = {
  team_id: string;
  principal: string;
  role: 'owner' | 'approver' | 'member';
};

type AgentIdentity = {
  id: string;
  team_id: string;
  principal: string;
  owner_principal: string;
  created_at: string;
  revoked_at: string | null;
};

type AgentCredential = {
  id: string;
  agent_identity_id: string;
  team_id: string;
  credential_hash: string;
  scopes_json: string;
  created_at: string;
  revoked_at: string | null;
  rotated_at: string | null;
};

type AttestationRow = {
  owner: string;
  recipe_name: string;
  recipe_version: number;
  recipe_digest: string;
  witness_receipt_sha256: string;
  created_at: string;
};

type RecipeVersionRow = {
  owner: string;
  recipe_name: string;
  recipe_version: number;
  recipe_digest: string;
  description: string;
  input_schema_json: string;
  code: string;
  capabilities_json: string;
  source_run_id: string | null;
  visibility: NonNullable<RecipeRow['visibility']>;
  tags_json: string;
  created_at: string;
};

type UsageReport = {
  id: string;
  owner: string;
  recipe_name: string;
  reporter: string;
  version: number;
  reported_at: string;
};

export class FakeD1 {
  rows: Row[] = [];
  usageReports: UsageReport[] = [];
  recipeVersions: RecipeVersionRow[] = [];
  attestations: AttestationRow[] = [];
  approvalReceipts: Record<string, unknown>[] = [];
  teamMembers: TeamMember[] = [];
  agentIdentities: AgentIdentity[] = [];
  agentCredentials: AgentCredential[] = [];
  preparedSql: string[] = [];
  beforeRecipeUpsert?: () => Promise<void>;

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.preparedSql.push(normalized);
    return new FakeStatement(this, normalized);
  }

  async batch(statements: FakeStatement[]) {
    const results: Array<{ meta: { changes: number } }> = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (
      this.sql.startsWith(
        'SELECT c.id, c.team_id, i.principal, i.owner_principal, c.scopes_json FROM agent_credentials c JOIN agent_identities i',
      )
    ) {
      const [value, teamId] = this.args as [string, string | undefined];
      const credential = this.db.agentCredentials.find(
        (candidate) =>
          (candidate.credential_hash === value || candidate.id === value) &&
          candidate.revoked_at === null &&
          (!teamId || candidate.team_id === teamId),
      );
      if (!credential) return null;
      const identity = this.db.agentIdentities.find(
        (candidate) =>
          candidate.id === credential.agent_identity_id && candidate.revoked_at === null,
      );
      return identity
        ? ({
            id: credential.id,
            team_id: credential.team_id,
            principal: identity.principal,
            owner_principal: identity.owner_principal,
            scopes_json: credential.scopes_json,
          } as T)
        : null;
    }
    if (
      this.sql.startsWith(
        'SELECT team_id, role FROM team_members WHERE team_id = ? AND principal = ?',
      )
    ) {
      const [teamId, principal] = this.args as [string, string];
      return (this.db.teamMembers.find(
        (member) => member.team_id === teamId && member.principal === principal,
      ) ?? null) as T | null;
    }
    if (
      this.sql.startsWith(
        'SELECT version, created_at, capabilities_json FROM recipes WHERE owner = ? AND name = ?',
      )
    ) {
      const [owner, name] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.owner === owner && r.name === name);
      return row
        ? ({
            version: row.version,
            created_at: row.created_at,
            capabilities_json: row.capabilities_json,
          } as T)
        : null;
    }
    if (
      this.sql.startsWith(
        'SELECT owner, name, version, recipe_digest FROM recipes WHERE owner = ? AND name = ? AND version = ? AND recipe_digest = ?',
      )
    ) {
      const [owner, name, version, digest] = this.args as [string, string, number, string];
      const row = this.db.rows.find(
        (candidate) =>
          candidate.owner === owner &&
          candidate.name === name &&
          candidate.version === version &&
          candidate.recipe_digest === digest,
      );
      return (row ?? null) as T | null;
    }
    if (
      this.sql.startsWith(
        'SELECT owner, name, version, recipe_digest FROM recipes WHERE owner = ? AND name = ?',
      )
    ) {
      const [owner, name] = this.args as [string, string];
      const row = this.db.rows.find(
        (candidate) => candidate.owner === owner && candidate.name === name,
      );
      return (row ?? null) as T | null;
    }
    if (this.sql.startsWith('SELECT * FROM recipes WHERE owner = ? AND name = ?')) {
      const [owner, name] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.owner === owner && r.name === name);
      return (row ?? null) as T | null;
    }
    if (
      this.sql.startsWith(
        'SELECT owner, recipe_name, recipe_version, recipe_digest, witness_receipt_sha256, created_at FROM recipe_attestations WHERE witness_receipt_sha256 = ?',
      )
    ) {
      const [receipt] = this.args as [string];
      return (this.db.attestations.find((row) => row.witness_receipt_sha256 === receipt) ??
        null) as T | null;
    }
    if (this.sql.startsWith("SELECT * FROM recipes WHERE visibility = 'shared' AND name = ?")) {
      const [name] = this.args as [string];
      const row = this.db.rows
        .filter((r) => r.visibility === 'shared' && r.name === name)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
      return (row ?? null) as T | null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (
      this.sql.startsWith(
        "SELECT * FROM recipes WHERE owner = ? AND status = 'pending' AND reviewed_version IS NULL AND reviewed_digest IS NULL ORDER BY updated_at DESC",
      )
    ) {
      const [owner] = this.args as [string];
      return {
        results: this.db.rows
          .filter(
            (row) =>
              row.owner === owner &&
              row.status === 'pending' &&
              row.reviewed_version == null &&
              row.reviewed_digest == null,
          )
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)) as T[],
      };
    }
    if (
      this.sql.startsWith(
        "SELECT * FROM recipes WHERE visibility = 'shared' ORDER BY updated_at DESC",
      )
    ) {
      const results = this.db.rows
        .filter((r) => r.visibility === 'shared')
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return { results: results as T[] };
    }
    if (
      this.sql.startsWith(
        'SELECT owner, recipe_name, recipe_version, recipe_digest, witness_receipt_sha256, created_at FROM recipe_attestations WHERE owner = ? AND recipe_name = ?',
      )
    ) {
      const [owner, name, version, digest] = this.args as [string, string, number, string];
      return {
        results: this.db.attestations.filter(
          (row) =>
            row.owner === owner &&
            row.recipe_name === name &&
            row.recipe_version === version &&
            row.recipe_digest === digest,
        ) as T[],
      };
    }
    if (this.sql.startsWith('SELECT * FROM recipes WHERE owner = ? ORDER BY updated_at DESC')) {
      const [owner] = this.args as [string];
      const results = this.db.rows
        .filter((r) => r.owner === owner)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return { results: results as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.startsWith('INSERT INTO agent_identities')) {
      const [id, team_id, principal, owner_principal, created_at] = this.args as [
        string,
        string,
        string,
        string,
        string,
      ];
      this.db.agentIdentities.push({
        id,
        team_id,
        principal,
        owner_principal,
        created_at,
        revoked_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT INTO agent_credentials') && !this.sql.includes(' SELECT ')) {
      const [id, agent_identity_id, team_id, credential_hash, scopes_json, created_at] = this
        .args as [string, string, string, string, string, string];
      this.db.agentCredentials.push({
        id,
        agent_identity_id,
        team_id,
        credential_hash,
        scopes_json,
        created_at,
        revoked_at: null,
        rotated_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE agent_credentials SET revoked_at = ?, rotated_at = ?')) {
      const [revoked_at, rotated_at, id, teamId] = this.args as [string, string, string, string];
      const credential = this.db.agentCredentials.find(
        (candidate) =>
          candidate.id === id && candidate.team_id === teamId && candidate.revoked_at === null,
      );
      if (!credential) return { meta: { changes: 0 } };
      credential.revoked_at = revoked_at;
      credential.rotated_at = rotated_at;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE agent_credentials SET revoked_at = ?')) {
      const [revoked_at, id, teamId] = this.args as [string, string, string];
      const credential = this.db.agentCredentials.find(
        (candidate) =>
          candidate.id === id && candidate.team_id === teamId && candidate.revoked_at === null,
      );
      if (!credential) return { meta: { changes: 0 } };
      credential.revoked_at = revoked_at;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT INTO agent_credentials') && this.sql.includes(' SELECT ')) {
      const [id, credential_hash, created_at, sourceId] = this.args as [
        string,
        string,
        string,
        string,
      ];
      const source = this.db.agentCredentials.find((candidate) => candidate.id === sourceId);
      if (!source) return { meta: { changes: 0 } };
      this.db.agentCredentials.push({
        ...source,
        id,
        credential_hash,
        created_at,
        revoked_at: null,
        rotated_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT INTO recipe_approval_receipts')) {
      if (this.sql.includes('WHERE EXISTS')) {
        const [owner, name, version, digest] = this.args.slice(12) as [
          string,
          string,
          number,
          string,
        ];
        const current = this.db.rows.find(
          (row) =>
            row.owner === owner &&
            row.name === name &&
            row.version === version &&
            row.recipe_digest === digest &&
            row.status === 'pending' &&
            row.reviewed_version == null &&
            row.reviewed_digest == null,
        );
        if (!current) return { meta: { changes: 0 } };
      }
      this.db.approvalReceipts.push(
        Object.fromEntries(
          [
            'id',
            'owner',
            'recipe_name',
            'recipe_version',
            'recipe_digest',
            'action',
            'reason',
            'actor',
            'source_code',
            'capabilities_json',
            'created_at',
            'receipt_digest',
          ].map((key, index) => [key, this.args[index]]),
        ),
      );
      return { meta: { changes: 1 } };
    }
    if (
      this.sql.startsWith(
        'UPDATE recipes SET status = ?, approved_version = ?, approved_digest = ?, reviewed_version = ?, reviewed_digest = ?',
      )
    ) {
      const [
        status,
        approvedVersion,
        approvedDigest,
        reviewedVersion,
        reviewedDigest,
        owner,
        name,
        version,
        digest,
      ] = this.args as [
        RecipeRow['status'],
        number | null,
        string | null,
        number,
        string,
        string,
        string,
        number,
        string,
      ];
      const row = this.db.rows.find(
        (candidate) =>
          candidate.owner === owner &&
          candidate.name === name &&
          candidate.version === version &&
          candidate.recipe_digest === digest &&
          candidate.status === 'pending' &&
          candidate.reviewed_version == null &&
          candidate.reviewed_digest == null,
      );
      if (!row) return { meta: { changes: 0 } };
      row.status = status;
      row.approved_version = approvedVersion;
      row.approved_digest = approvedDigest;
      row.reviewed_version = reviewedVersion;
      row.reviewed_digest = reviewedDigest;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT INTO recipe_versions')) {
      const [createdAt, owner, name, version, digest] = this.args as [
        string,
        string,
        string,
        number,
        string,
      ];
      const source = this.db.rows.find(
        (row) =>
          row.owner === owner &&
          row.name === name &&
          row.version === version &&
          row.recipe_digest === digest,
      );
      if (
        !source ||
        this.db.recipeVersions.some(
          (row) =>
            row.owner === owner && row.recipe_name === name && row.recipe_version === version,
        )
      ) {
        return { meta: { changes: 0 } };
      }
      this.db.recipeVersions.push({
        owner,
        recipe_name: name,
        recipe_version: version,
        recipe_digest: digest,
        description: source.description,
        input_schema_json: source.input_schema_json,
        code: source.code,
        capabilities_json: source.capabilities_json,
        source_run_id: source.source_run_id,
        visibility: source.visibility ?? 'private',
        tags_json: source.tags_json ?? '[]',
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT INTO recipes')) {
      await this.db.beforeRecipeUpsert?.();
      const [
        id,
        owner,
        name,
        description,
        input_schema_json,
        code,
        capabilities_json,
        status,
        version,
        source_run_id,
        visibility,
        tags_json,
        run_count,
        last_run_at,
        recipe_digest,
        created_at,
        updated_at,
        expected_version,
      ] = this.args as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        RecipeRow['status'],
        number,
        string | null,
        RecipeRow['visibility'],
        string,
        number,
        string | null,
        string | null,
        string,
        string,
        number,
      ];
      const existing = this.db.rows.find((r) => r.owner === owner && r.name === name);
      if (existing && existing.version !== expected_version) return { meta: { changes: 0 } };
      const next: Row = {
        id: existing?.id ?? id,
        owner,
        name,
        description,
        input_schema_json,
        code,
        capabilities_json,
        status,
        version,
        source_run_id,
        visibility,
        tags_json,
        run_count: existing?.run_count ?? run_count,
        last_run_at: existing?.last_run_at ?? last_run_at,
        recipe_digest,
        approved_version:
          existing?.approved_version === undefined
            ? undefined
            : status === 'pending'
              ? null
              : existing.approved_version,
        approved_digest:
          existing?.approved_digest === undefined
            ? undefined
            : status === 'pending'
              ? null
              : existing.approved_digest,
        reviewed_version:
          existing?.reviewed_version === undefined
            ? undefined
            : status === 'pending'
              ? null
              : existing.reviewed_version,
        reviewed_digest:
          existing?.reviewed_digest === undefined
            ? undefined
            : status === 'pending'
              ? null
              : existing.reviewed_digest,
        created_at,
        updated_at,
      };
      if (existing) Object.assign(existing, next);
      else this.db.rows.push(next);
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT OR IGNORE INTO recipe_attestations')) {
      const [
        id,
        witness_receipt_sha256,
        created_at,
        owner,
        recipe_name,
        recipe_version,
        recipe_digest,
      ] = this.args as [string, string, string, string, string, number, string];
      const subject = this.db.rows.find(
        (row) =>
          row.owner === owner &&
          row.name === recipe_name &&
          row.version === recipe_version &&
          row.recipe_digest === recipe_digest,
      );
      if (
        !subject ||
        !id ||
        this.db.attestations.some((row) => row.witness_receipt_sha256 === witness_receipt_sha256)
      ) {
        return { meta: { changes: 0 } };
      }
      this.db.attestations.push({
        owner,
        recipe_name,
        recipe_version,
        recipe_digest,
        witness_receipt_sha256,
        created_at,
      });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('INSERT OR IGNORE INTO recipe_usage_reports')) {
      const [id, owner, recipe_name, reporter, version, reported_at] = this.args as [
        string,
        string,
        string,
        string,
        number,
        string,
      ];
      if (this.db.usageReports.some((report) => report.id === id)) return { meta: { changes: 0 } };
      this.db.usageReports.push({ id, owner, recipe_name, reporter, version, reported_at });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('UPDATE recipes SET run_count = run_count + 1')) {
      const [, owner, name] = this.args as [string, string, string];
      const row = this.db.rows.find((r) => r.owner === owner && r.name === name);
      if (!row) return { meta: { changes: 0 } };
      row.run_count = (row.run_count ?? 0) + 1;
      row.last_run_at = this.args[0] as string;
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith('DELETE FROM recipes WHERE owner = ? AND name = ?')) {
      const [owner, name] = this.args as [string, string];
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter((r) => !(r.owner === owner && r.name === name));
      return { meta: { changes: before - this.db.rows.length } };
    }
    return { meta: { changes: 0 } };
  }
}
