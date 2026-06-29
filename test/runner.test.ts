import { describe, expect, test } from 'bun:test';
import { runRecipe, scanRecipeCode } from '../examples/run-recipe.ts';
import { sampleRecipe } from '../examples/sample-recipe.ts';
import type { FullRecipe } from '../src/recipe.ts';

function asFull(code: string, capabilities = ['text.transform']): FullRecipe {
  return {
    name: 'test',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    capabilities,
    status: 'enabled',
    version: 1,
    sourceRunId: null,
    updatedAt: '',
    createdAt: '',
    code,
  };
}

describe('bounded runner', () => {
  test('runs the sample slugify recipe over a restricted ctx', () => {
    const recipe = asFull(sampleRecipe.code, sampleRecipe.capabilities);
    const result = runRecipe(recipe, { input: { text: 'Hello, Pantry World!' } });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ slug: 'hello-pantry-world' });
    expect(result.capabilities).toEqual(['text.transform']);
  });

  // The shadowed names are a CONVENIENCE that hides ambient globals from a
  // casual `typeof` lookup. These tests assert that convenience holds for
  // NON-escaping code. They do NOT claim containment — see the adversarial
  // suite below, which shows the shadow is escapable.
  test('a casual `typeof fetch` lookup sees undefined (convenience shadow)', () => {
    const result = runRecipe(asFull('return typeof fetch;'), {});
    expect(result.ok).toBe(true);
    expect(result.output).toBe('undefined');
  });

  test('a casual `typeof process` lookup sees undefined (convenience shadow)', () => {
    const result = runRecipe(asFull('return typeof process;'), {});
    expect(result.output).toBe('undefined');
  });

  test('a casual `typeof globalThis` lookup sees undefined (convenience shadow)', () => {
    const result = runRecipe(asFull('return typeof globalThis;'), {});
    expect(result.output).toBe('undefined');
  });

  test('the recipe only sees the explicit ctx', () => {
    const result = runRecipe(asFull('return ctx.input.n * 2;'), { input: { n: 21 } });
    expect(result.output).toBe(42);
  });

  test('runs export default callable recipes with input and ctx', () => {
    const result = runRecipe(
      asFull('export default (input, ctx) => `${input.text}:${ctx.input.text.length}`;'),
      { input: { text: 'pantry' } },
    );
    expect(result).toMatchObject({ ok: true, output: 'pantry:6' });
  });

  test('runs module.exports callable recipes with input and ctx', () => {
    const result = runRecipe(asFull('module.exports = (input, ctx) => input.n + ctx.input.n;'), {
      input: { n: 7 },
    });
    expect(result).toMatchObject({ ok: true, output: 14 });
  });

  test('a throwing recipe is captured, not propagated', () => {
    const result = runRecipe(asFull('throw new Error("boom");'), {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  test('ctx is frozen: a recipe cannot mutate the caller-supplied context', () => {
    const ctx = { input: { n: 1 } };
    runRecipe(asFull('try { ctx.input = { n: 999 }; } catch (e) {} return ctx.input.n;'), ctx);
    expect(ctx.input.n).toBe(1);
  });
});

// The honest counterpart to the convenience-shadow tests above. The runner is
// NOT a sandbox; the shadow is escapable. These tests assert what ACTUALLY
// happens — they match the truthful docstring, not a false safety claim.
describe('runner is NOT a sandbox: escape vectors and the best-effort guard', () => {
  const IMPORT_FS = `return import('node:fs').then((m) => typeof m.readFileSync);`;
  const FUNCTION_CLIMB = `return (function(){}).constructor('return typeof process')();`;

  describe('best-effort guard (default) REJECTS the textbook escapes', () => {
    test("`import('node:fs')` is rejected by the guard before running", () => {
      const result = runRecipe(asFull(IMPORT_FS), {});
      expect(result.ok).toBe(false);
      expect(result.rejectedByGuard).toBe(true);
      expect(result.error).toContain("forbidden token 'import'");
      // The error itself reminds the caller the guard is not containment.
      expect(result.error).toContain('NOT a sandbox');
    });

    test('the Function-constructor climb is rejected by the guard before running', () => {
      const result = runRecipe(asFull(FUNCTION_CLIMB), {});
      expect(result.ok).toBe(false);
      expect(result.rejectedByGuard).toBe(true);
      // `constructor` is hit first in the word scan; either escape token is fine.
      expect(result.error).toMatch(/forbidden token '(constructor|Function)'/);
    });

    test('scanRecipeCode flags each escape token and import.meta', () => {
      expect(scanRecipeCode(IMPORT_FS)).toBe('import');
      expect(scanRecipeCode(FUNCTION_CLIMB)).toBe('constructor');
      expect(scanRecipeCode('return eval("1+1");')).toBe('eval');
      expect(scanRecipeCode('return require("node:fs");')).toBe('require');
      expect(scanRecipeCode('return import.meta.url;')).toBe('import.meta');
      // A clean recipe passes the scan — which proves nothing about safety.
      expect(scanRecipeCode('return ctx.input.n * 2;')).toBeNull();
    });
  });

  // With the guard OFF, the runner executes the raw code. These tests DOCUMENT
  // the escapes: this is precisely why callers must use a real isolate. The
  // shadowed `process`/`import` parameters do NOT contain hostile code.
  describe('with guard disabled, the escapes SUCCEED (this is why you need a real isolate)', () => {
    test('the Function-constructor climb reaches the REAL process, defeating the shadow', () => {
      const result = runRecipe(asFull(FUNCTION_CLIMB), {}, { guard: false });
      expect(result.ok).toBe(true);
      // Despite `process: undefined` being shadowed, the climb reaches the real
      // global `process` object. The shadow is a convenience, not containment.
      expect(result.output).toBe('object');
    });

    test('dynamic import() resolves the REAL node:fs, defeating the shadow', async () => {
      const result = runRecipe(asFull(IMPORT_FS), {}, { guard: false });
      expect(result.ok).toBe(true);
      // `import()` is syntax, not a shadowable binding: it resolves the real
      // module. `readFileSync` is a function => the recipe reached the FS API.
      expect(result.output).toBeInstanceOf(Promise);
      expect(await result.output).toBe('function');
    });
  });
});
