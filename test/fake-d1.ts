// A tiny in-memory D1 stand-in for the exact subset of SQL the worker uses.
// Not a general SQL engine: it pattern-matches the handful of statements in
// src/worker.ts so route tests run with `bun test` and no real D1.

import type { RecipeRow } from '../src/recipe.ts';

type Row = RecipeRow;

export class FakeD1 {
  rows: Row[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql.replace(/\s+/g, ' ').trim());
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
      this.sql.startsWith('SELECT version, created_at FROM recipes WHERE owner = ? AND name = ?')
    ) {
      const [owner, name] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.owner === owner && r.name === name);
      return row ? ({ version: row.version, created_at: row.created_at } as T) : null;
    }
    if (this.sql.startsWith('SELECT * FROM recipes WHERE owner = ? AND name = ?')) {
      const [owner, name] = this.args as [string, string];
      const row = this.db.rows.find((r) => r.owner === owner && r.name === name);
      return (row ?? null) as T | null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
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
    if (this.sql.startsWith('INSERT INTO recipes')) {
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
        created_at,
        updated_at,
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
        string,
        string,
      ];
      const existing = this.db.rows.find((r) => r.owner === owner && r.name === name);
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
        created_at,
        updated_at,
      };
      if (existing) Object.assign(existing, next);
      else this.db.rows.push(next);
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
