// A DEMO runner for a fetched pantry recipe. This is NOT a security sandbox.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ THIS IS NOT A TRUST BOUNDARY. Running a fetched recipe in this runner is  │
// │ NOT safe execution of untrusted code. If you do not already trust the     │
// │ recipe's author, you MUST run it in a real isolate — a Cloudflare Worker  │
// │ Loader, a separate Worker, a child process, or a vetted JS sandbox — not  │
// │ here. Real isolation is the CALLER'S job; this runner does not do it.     │
// └─────────────────────────────────────────────────────────────────────────┘
//
// pantry stores and hands back a script; it never runs it. Executing a fetched
// recipe is the caller's decision and the caller's risk. This runner exists to
// make ONE pattern legible: "fetch a recipe, run it over an explicit `ctx`".
// That is all it is — a convenience for code you already trust.
//
// What this runner does:
//   - Accepts the common authoring shapes: a bare function body using `ctx`,
//     `export default (input, ctx) => ...`, or `module.exports = ...`.
//     Exported callables receive `(ctx.input, ctx)`.
//   - Binds a handful of ambient names (`fetch`, `process`, `globalThis`, ...)
//     to `undefined` as function parameters. This is a CONVENIENCE that trips
//     up casual `typeof process` lookups. It is NOT containment.
//
// Why it is NOT containment (the shadowing is escapable):
//   - `import('node:fs')` resolves to the REAL module. `import()` is syntax,
//     not a binding, so it cannot be shadowed by a parameter named `import`.
//   - `(function(){}).constructor('return process')()` climbs back to the
//     Function constructor and evaluates in the global scope, reaching the
//     REAL `process` despite the `process: undefined` parameter.
//   - `eval`, `require`, and any reflective trick that recovers the global
//     `Function` similarly defeat the shadow.
//
// As a courtesy, `runRecipe` runs a BEST-EFFORT parse-time guard
// (`scanRecipeCode`) that rejects code mentioning the obvious escape tokens
// (`import`, `Function`, `constructor`, `eval`, `require`, `import.meta`). This
// guard is a tripwire, NOT a sandbox: it is a coarse substring/word scan, it
// can be bypassed (e.g. by building those names from string fragments), and a
// passing scan proves nothing about safety. Pass `{ guard: false }` to run the
// raw code and observe the escapes directly (the adversarial tests do this).

import type { FullRecipe } from '../src/recipe.ts';

export type RunResult = {
  ok: boolean;
  output?: unknown;
  error?: string;
  capabilities: string[];
  // Set when the best-effort parse-time guard rejected the code before running.
  rejectedByGuard?: boolean;
};

export type RunOptions = {
  // Run the best-effort parse-time guard before executing. Default: true.
  // This is a tripwire, not a sandbox — see the file header.
  guard?: boolean;
};

// Ambient names we shadow as a CONVENIENCE so a casual `typeof process` lookup
// returns undefined. These are passed as function parameters bound to
// `undefined`. This does NOT contain hostile code — see the file header for the
// escapes (`import()`, the Function-constructor climb) that defeat it.
const SHADOWED_PARAMS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'Bun',
  'Deno',
  'globalThis',
  'global',
  'require',
];

// Tokens whose presence in recipe code most commonly indicates an attempt to
// escape the shadowed scope. Matched as whole words; `import.meta` is matched
// separately because `.` is not a word boundary on the left of `meta`.
const FORBIDDEN_TOKENS = ['import', 'Function', 'constructor', 'eval', 'require'];

// A BEST-EFFORT, NOT-AIRTIGHT scan for the obvious escape vectors. Returns the
// first offending token, or null if none are found. A null result does NOT mean
// the code is safe: this is a coarse word scan that string-built names and
// other reflection tricks slip past. It exists only to fail loudly on the
// textbook escapes, never as a substitute for a real isolate.
export function scanRecipeCode(code: string): string | null {
  if (/\bimport\s*\.\s*meta\b/.test(code)) return 'import.meta';
  for (const token of FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) return token;
  }
  return null;
}

function callableSource(code: string): string | null {
  const trimmed = code.trim();
  if (/^export\s+default\b/.test(trimmed)) {
    return `return ${trimmed.replace(/^export\s+default\s*/, '')}`;
  }
  if (/^module\.exports\s*=/.test(trimmed)) {
    return `const module = { exports: undefined }; const exports = module.exports;\n${trimmed}\nreturn module.exports;`;
  }
  return null;
}

// Run a fetched recipe over an explicit `ctx`. NOT a security boundary — see
// the file header. Accepted code shapes are:
//   - a bare function body that can read `ctx` and returns the output;
//   - `export default (input, ctx) => ...` or `export default function ...`;
//   - `module.exports = (input, ctx) => ...`.
// Exported callables receive `(ctx.input, ctx)`. By default the best-effort
// guard runs first; pass `{ guard: false }` to execute the raw code unguarded.
export function runRecipe(
  recipe: FullRecipe,
  ctx: Record<string, unknown>,
  options: RunOptions = {},
): RunResult {
  const guard = options.guard !== false;
  if (guard) {
    const offending = scanRecipeCode(recipe.code);
    if (offending) {
      return {
        ok: false,
        error: `recipe rejected by best-effort guard: forbidden token '${offending}'. This guard is NOT a sandbox; run untrusted recipes in a real isolate.`,
        capabilities: recipe.capabilities,
        rejectedByGuard: true,
      };
    }
  }

  const argNames = ['ctx', ...SHADOWED_PARAMS];
  const argValues: unknown[] = [Object.freeze({ ...ctx }), ...SHADOWED_PARAMS.map(() => undefined)];

  try {
    // Bare recipes are treated as a function body. Export/module recipes are
    // normalized into a callable, then called with (ctx.input, ctx). `'use strict'`
    // and shadowed names shape the convenient case; they do not contain hostile code.
    const source = callableSource(recipe.code);
    if (source) {
      const loader = new Function(...argNames, `'use strict';\n${source}`);
      const callable = loader(...argValues);
      if (typeof callable !== 'function') throw new Error('recipe export is not callable');
      const output = callable((ctx as { input?: unknown }).input, Object.freeze({ ...ctx }));
      return { ok: true, output, capabilities: recipe.capabilities };
    }
    const factory = new Function(...argNames, `'use strict';\n${recipe.code}`);
    const output = factory(...argValues);
    return { ok: true, output, capabilities: recipe.capabilities };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      capabilities: recipe.capabilities,
    };
  }
}

// Demo: fetch a recipe by name via the client, then run it bounded.
// Usage: PANTRY_URL=... PANTRY_TOKEN=... bun examples/run-recipe.ts <name>
async function main(): Promise<void> {
  const { pantry } = await import('../src/client.ts');
  const name = process.argv[2] ?? 'slugify';
  const recipe = await pantry.get(name);
  if (!recipe) {
    console.error(`recipe '${name}' not found in pantry`);
    process.exit(1);
  }
  console.log(
    `fetched '${recipe.name}' v${recipe.version}; capabilities: ${recipe.capabilities.join(', ')}`,
  );
  const result = runRecipe(recipe, { input: { text: 'Hello, Pantry World!' } });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
