// Track A: AST-driven recipe-shape classification (kody steal #3).
// Every code shape runs correctly, INCLUDING the bare arrow expression that
// used to be silently discarded (returned undefined). Malformed shapes fail
// honestly, never silently.
import { test, expect } from 'bun:test';
import { runRecipe, classifyRecipe } from '../examples/run-recipe.ts';
import type { FullRecipe } from '../src/recipe.ts';

const mk = (code: string): FullRecipe => ({
  name: 't', description: '', inputSchema: { type: 'object' }, code, capabilities: [],
  status: 'enabled', visibility: 'private', version: 1, sourceRunId: null,
  owner: 't', createdAt: '', updatedAt: '',
} as unknown as FullRecipe);

test('bare body returns via return statement', () => {
  expect(classifyRecipe('return { n: ctx.input.x + 1 };').kind).toBe('body');
  const r = runRecipe(mk('return { n: ctx.input.x + 1 };'), { input: { x: 41 } });
  expect(r.output).toEqual({ n: 42 });
});

test('export default arrow is a callable and RUNS', () => {
  expect(classifyRecipe('export default (input) => ({ y: input.x * 2 })').kind).toBe('callable');
  const r = runRecipe(mk('export default (input) => ({ y: input.x * 2 })'), { input: { x: 21 } });
  expect(r.output).toEqual({ y: 42 });
});

test('export default function is a callable and RUNS', () => {
  const code = 'export default function (input) { return { y: input.x + 1 }; }';
  expect(classifyRecipe(code).kind).toBe('callable');
  expect(runRecipe(mk(code), { input: { x: 41 } }).output).toEqual({ y: 42 });
});

test('module.exports is a callable and RUNS', () => {
  const code = 'module.exports = (input) => ({ y: input.x - 1 })';
  expect(classifyRecipe(code).kind).toBe('callable');
  expect(runRecipe(mk(code), { input: { x: 43 } }).output).toEqual({ y: 42 });
});

test('THE FIX: a bare arrow EXPRESSION runs (used to be silently discarded -> undefined)', async () => {
  const code = 'async (input) => ({ y: input.x + 1 })';
  expect(classifyRecipe(code).kind).toBe('callable');
  const out = await (runRecipe(mk(code), { input: { x: 41 } }).output as Promise<unknown>);
  expect(out).toEqual({ y: 42 });
});

test('bare arrow with no params still runs and reads ctx via second arg', async () => {
  const code = 'async () => ({ ok: true })';
  const out = await (runRecipe(mk(code), { input: {} }).output as Promise<unknown>);
  expect(out).toEqual({ ok: true });
});

test('HONEST failure: unparseable code is rejected, not run silently', () => {
  const r = runRecipe(mk('export default (input) => {{{ this is not valid'), { input: {} });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('invalid');
});

test('HONEST failure: export default of a non-function is rejected', () => {
  const r = runRecipe(mk('export default 42'), { input: {} });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('not a function');
});
