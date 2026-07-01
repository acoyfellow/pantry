// E2E for the widening slice: checkRecipe + ctx.bindings in the REAL runRecipe.
// Proves (E-WIDEN-2/3) that a host-interface recipe runs when bound, refuses
// honestly when unbound, and that pure recipes are unaffected (no regression).
import { test, expect } from 'bun:test';
import { runRecipe, checkRecipe, requiredInterfaces, type Bindings } from '../examples/run-recipe.ts';
import type { FullRecipe } from '../src/recipe.ts';

function recipe(code: string, capabilities: string[] = []): FullRecipe {
  return {
    name: 't', description: '', inputSchema: { type: 'object' }, code, capabilities,
    status: 'enabled', visibility: 'private', version: 1, sourceRunId: null,
    owner: 'test', createdAt: '', updatedAt: '',
  } as unknown as FullRecipe;
}

// A realistic machine.shell recipe: parse `df -h` output into a compact object.
// Exported callable shape: `export default (input, ctx) => ...` so runRecipe
// calls it and returns its promise (a bare `async () => {}` body would only
// DEFINE the arrow and discard it).
const dfRecipe = recipe(
  `export default async () => {
     const out = await machine.shell({ command: "df -h /" });
     const cols = out.stdout.trim().split("\\n").at(-1).split(/\\s+/);
     return { size: cols[1], usePct: parseInt(cols[4], 10), mount: cols.at(-1) };
   }`,
  ['machine.shell'],
);

test('requiredInterfaces derives host interfaces from declared capabilities', () => {
  expect(requiredInterfaces(dfRecipe)).toContain('machine.shell');
});

test('checkRecipe refuses when the required binding is missing', () => {
  const c = checkRecipe(dfRecipe, {});
  expect(c.ok).toBe(false);
  expect(c.missing).toContain('machine.shell');
});

test('checkRecipe passes when a namespace binding is provided', () => {
  const c = checkRecipe(dfRecipe, { 'machine.shell': (() => {}) as any });
  expect(c.ok).toBe(true);
  expect(c.missing).toEqual([]);
});

test('runRecipe refuses honestly (not a late TypeError) when unbound', () => {
  const r = runRecipe(dfRecipe, { input: {} });
  expect(r.ok).toBe(false);
  expect(r.missingBindings).toContain('machine.shell');
  expect(r.error).toContain('missing [machine.shell]');
});

test('runRecipe runs the shell recipe when the harness binds shell (E-WIDEN-2)', async () => {
  const canned = 'Filesystem Size Used Avail Use% Mounted on\n/dev/disk3 460G 380G 72G 85% /\n';
  const bindings: Bindings = { 'machine.shell': async () => ({ stdout: canned }) };
  const r = runRecipe(dfRecipe, { input: {}, bindings });
  expect(r.ok).toBe(true);
  const out = await (r.output as Promise<unknown>);
  expect(out).toEqual({ size: '460G', usePct: 85, mount: '/' });
});

test('two harnesses with DIFFERENT shell internals produce byte-identical output (E-WIDEN-2)', async () => {
  const harnessA: Bindings = {
    'machine.shell': async () => ({ stdout: 'H Size U A Use% M\n/d 460G 380G 72G 85% /\n' }),
  };
  const harnessB: Bindings = {
    'machine.shell': async () => {
      const rows = [['H', 'Size', 'U', 'A', 'Use%', 'M'], ['/d', '460G', '380G', '72G', '85%', '/']];
      return { stdout: rows.map((r) => r.join(' ')).join('\n') + '\n' };
    },
  };
  const a = await (runRecipe(dfRecipe, { input: {}, bindings: harnessA }).output as Promise<unknown>);
  const b = await (runRecipe(dfRecipe, { input: {}, bindings: harnessB }).output as Promise<unknown>);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test('namespace.method binding resolves via a rebuilt namespace object', async () => {
  const r = recipe(`export default async () => { const o = await machine.shell({ command: "echo hi" }); return o.stdout.trim(); }`, ['machine.shell']);
  const out = await (runRecipe(r, { input: {}, bindings: { 'machine.shell': async () => ({ stdout: 'hi\n' }) } }).output as Promise<unknown>);
  expect(out).toBe('hi');
});

test('REGRESSION: a pure recipe with no bindings still runs unchanged', () => {
  const pure = recipe(`return { n: (ctx.input.x || 0) + 1 };`);
  const r = runRecipe(pure, { input: { x: 41 } });
  expect(r.ok).toBe(true);
  expect(r.output).toEqual({ n: 42 });
});

test('REGRESSION: export default (input, ctx) shape still runs', () => {
  const exp = recipe(`export default (input) => ({ doubled: input.x * 2 });`);
  const r = runRecipe(exp, { input: { x: 21 } });
  expect(r.ok).toBe(true);
  expect(r.output).toEqual({ doubled: 42 });
});

test('DANE: namespace-object binding { machine: { shell } } resolves', async () => {
  const r = recipe(`export default async () => (await machine.shell({ command: "ls" })).stdout`, ['machine.shell']);
  const out = await (runRecipe(r, { input: {}, bindings: { machine: { shell: async () => ({ stdout: 'ok' }) } } as any }).output as Promise<unknown>);
  expect(out).toBe('ok');
});
