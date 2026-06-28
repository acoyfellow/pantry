import { describe, expect, test } from 'bun:test';
import {
  RecipeError,
  type RecipeRow,
  fullRecipe,
  listEntry,
  validateRecipeInput,
} from '../src/recipe.ts';

const base = {
  name: 'slugify',
  description: 'turn text into a slug',
  inputSchema: { type: 'object', properties: {} },
  code: 'return { slug: ctx.input.text };',
  capabilities: ['text.transform'],
};

describe('validateRecipeInput', () => {
  test('accepts a valid recipe and sorts/dedupes capabilities', () => {
    const r = validateRecipeInput({
      ...base,
      capabilities: ['z.b', 'text.transform', 'text.transform'],
    });
    expect(r.name).toBe('slugify');
    expect(r.capabilities).toEqual(['text.transform', 'z.b']);
    expect(r.status).toBe('enabled');
    expect(r.sourceRunId).toBeNull();
  });

  test('rejects a bad name', () => {
    expect(() => validateRecipeInput({ ...base, name: '9bad' })).toThrow(RecipeError);
    expect(() => validateRecipeInput({ ...base, name: 'has space' })).toThrow(/name must match/);
  });

  test('rejects description out of 5-500 range', () => {
    expect(() => validateRecipeInput({ ...base, description: 'no' })).toThrow(/5-500/);
    expect(() => validateRecipeInput({ ...base, description: 'x'.repeat(501) })).toThrow(/5-500/);
  });

  test('requires inputSchema.type to be object', () => {
    expect(() => validateRecipeInput({ ...base, inputSchema: { type: 'array' } })).toThrow(
      /inputSchema.type/,
    );
  });

  test('requires code and enforces 32000 byte cap', () => {
    expect(() => validateRecipeInput({ ...base, code: '' })).toThrow(/code is required/);
    expect(() => validateRecipeInput({ ...base, code: 'a'.repeat(32_001) })).toThrow(/32000 bytes/);
  });

  test('requires at least one capability and validates the tag shape', () => {
    expect(() => validateRecipeInput({ ...base, capabilities: [] })).toThrow(/at least one/);
    expect(() => validateRecipeInput({ ...base, capabilities: ['NOPE'] })).toThrow(
      /invalid capabilities/,
    );
  });

  test('accepts scoped capability namespaces', () => {
    const r = validateRecipeInput({ ...base, capabilities: ['workspace.read', 'machine.exec'] });
    expect(r.capabilities).toEqual(['machine.exec', 'workspace.read']);
  });
});

describe('projection helpers', () => {
  const row: RecipeRow = {
    id: 'id-1',
    owner: 'default',
    name: 'slugify',
    description: 'turn text into a slug',
    input_schema_json: JSON.stringify({ type: 'object', properties: {} }),
    code: 'return { slug: 1 };',
    capabilities_json: JSON.stringify(['text.transform']),
    status: 'enabled',
    version: 3,
    source_run_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };

  test('listEntry never includes code', () => {
    const entry = listEntry(row) as Record<string, unknown>;
    expect('code' in entry).toBe(false);
    expect(entry.version).toBe(3);
    expect(entry.capabilities).toEqual(['text.transform']);
  });

  test('fullRecipe includes code', () => {
    const full = fullRecipe(row);
    expect(full.code).toBe('return { slug: 1 };');
    expect(full.name).toBe('slugify');
  });
});
