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
  // Set when the interface pre-flight refused because a required host binding
  // was missing. Carries the honest requires/missing breakdown (E-WIDEN-3).
  missingBindings?: string[];
};

export type RunOptions = {
  // Run the best-effort parse-time guard before executing. Default: true.
  // This is a tripwire, not a sandbox — see the file header.
  guard?: boolean;
  // Pre-flight the recipe's required host interfaces against the bindings the
  // caller provides (ctx.bindings). Default: true. When a required interface is
  // missing, `runRecipe` refuses HONESTLY instead of failing with a late,
  // opaque TypeError. Proven in E-WIDEN-3. Set false to skip the pre-flight.
  check?: boolean;
};

// The result of pre-flighting a recipe against a set of provided bindings.
// `requires` is the set of host interfaces the code calls (best-effort scan);
// `missing` is those not satisfied by the provided bindings.
export type CheckResult = {
  ok: boolean;
  requires: string[];
  missing: string[];
};

// Host namespaces a recipe may call. A recipe that calls e.g. `shell({...})` or
// `machine.shell({...})` declares an INTERFACE the CONSUMING harness satisfies
// by passing an implementation in `ctx.bindings`. Binding is the consumer's
// authority: pantry never executes, and providing a binding is the harness's
// explicit choice. Proven portable across harnesses in E-WIDEN-2.
// A binding value is either a function (`{'machine.shell': fn}` or `{shell: fn}`)
// or a namespace object (`{machine: {shell: fn}}`) — both forms are accepted.
type BindingValue = ((...args: unknown[]) => unknown) | Record<string, (...args: unknown[]) => unknown>;
export type Bindings = Record<string, BindingValue>;

// The host interfaces a recipe requires are its DECLARED capabilities — the
// authoritative list my-ax already infers from the recipe's actual bridge calls
// (`machine.shell`, `workspace.read`). We do NOT re-infer them from a greedy
// code scan: a scan cannot tell a host call (`machine.shell(...)`) from a local
// method call (`out.stdout.trim()`) or a keyword (`export default (...)`). The
// declared capabilities ARE the contract; a code scan is only used to sanity
// them (kody steal #3, an acorn AST pass, is the future precise upgrade).
//
// A capability is a HOST INTERFACE if it names a known host namespace
// (`machine.*`, `workspace.*`, `cloudbox.*`) or is a bare interface name the
// caller can bind. Purely descriptive capabilities without a host namespace are
// treated as non-binding and never block a run.
const HOST_NAMESPACES = new Set(['machine', 'workspace', 'cloudbox']);
export function requiredInterfaces(recipe: FullRecipe): string[] {
  return [...new Set(recipe.capabilities.filter((cap) => {
    const [ns, method] = cap.split('.');
    // `<ns>.none` is the explicit "pure, needs no host binding" sentinel; never
    // a requirement. Bare capability names (no namespace) are descriptive tags,
    // not host interfaces, so they don't demand a binding either.
    if (!cap.includes('.')) return false;
    if (method === 'none') return false;
    return HOST_NAMESPACES.has(ns);
  }))].sort();
}

// Pre-flight a recipe against the provided bindings. A binding key may be a bare
// name (`shell`) or a namespaced one (`machine.shell`); a `machine.shell`
// requirement is satisfied by either a `machine.shell` binding or a `machine`
// namespace object exposing `shell`. Missing required interfaces are reported
// honestly, using the recipe's DECLARED capabilities as the contract.
export function checkRecipe(recipe: FullRecipe, bindings: Bindings = {}): CheckResult {
  const provided = new Set(Object.keys(bindings));
  const requires = requiredInterfaces(recipe);
  const missing = requires.filter((iface) => {
    if (provided.has(iface)) return false;
    const [ns] = iface.split('.');
    // A namespace object binding (e.g. `machine`) satisfies `machine.*` calls.
    if (iface.includes('.') && provided.has(ns)) return false;
    return true;
  });
  return { ok: missing.length === 0, requires, missing };
}

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

import { parse as acornParse } from 'acorn';

// Classify a recipe's code shape with a real AST parse (kody steal #3) instead
// of brittle regexes. Shapes:
//   - 'callable': the code EXPORTS or IS a single callable expression
//     (`export default (input,ctx)=>...`, `export default function...`,
//     `module.exports = ...`, or a bare arrow/function EXPRESSION `async ()=>{}`).
//     runRecipe calls it with (ctx.input, ctx). A bare arrow expression used to
//     be silently discarded and return undefined — the AST catches it and runs it.
//   - 'body': a bare function body (statements that `return` the output),
//     run as `(ctx, ...) => { <code> }`.
//   - 'invalid': does not parse, or an export/module form whose value is not a
//     function — rejected HONESTLY, never silently.
type RecipeShape =
  | { kind: 'callable'; source: string }
  | { kind: 'body' }
  | { kind: 'invalid'; reason: string };

function isCallableNode(node: { type: string }): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration';
}

// Strip leading line/block comments + whitespace so shape detection sees the
// first real token (recipes commonly open with a description comment).
function stripLeadingTrivia(code: string): string {
  let s = code.trimStart();
  for (;;) {
    if (s.startsWith('//')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1).trimStart();
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trimStart();
    } else {
      return s;
    }
  }
}

export function classifyRecipe(code: string): RecipeShape {
  const trimmed = code.trim();
  const lead = stripLeadingTrivia(trimmed);
  // export default / module.exports need module parsing; a bare body is not a
  // valid module/script on its own (top-level return), so try shapes in order.
  if (/^export\s+default\b/.test(lead)) {
    let program: any;
    try {
      program = acornParse(lead, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (e) {
      return { kind: 'invalid', reason: `export default did not parse: ${(e as Error).message}` };
    }
    const decl = program.body.find((n: any) => n.type === 'ExportDefaultDeclaration');
    const value = decl?.declaration;
    if (value && (isCallableNode(value) || value.type === 'Identifier' || value.type === 'CallExpression')) {
      return { kind: 'callable', source: `return ${lead.replace(/^export\s+default\s*/, '')}` };
    }
    return { kind: 'invalid', reason: 'export default value is not a function' };
  }
  if (/^module\s*\.\s*exports\s*=/.test(lead)) {
    return {
      kind: 'callable',
      source: `const module = { exports: undefined }; const exports = module.exports;\n${trimmed}\nreturn module.exports;`,
    };
  }
  // A bare arrow/function EXPRESSION (e.g. `async () => {...}`) as the whole
  // recipe: parse as an expression statement; if the sole statement is a
  // function expression, treat it as a callable (call it), not a discarded body.
  try {
    const asScript = acornParse(trimmed, { ecmaVersion: 'latest', sourceType: 'script' });
    if (
      asScript.body.length === 1 &&
      (asScript.body[0] as any).type === 'ExpressionStatement' &&
      isCallableNode((asScript.body[0] as any).expression)
    ) {
      return { kind: 'callable', source: `return (${trimmed})` };
    }
  } catch {
    // not a standalone expression — fall through to body treatment.
  }
  return { kind: 'body' };
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

  // The consuming harness supplies host-interface implementations in
  // ctx.bindings. Binding is the consumer's authority (pantry never executes).
  const bindings = (ctx as { bindings?: Bindings }).bindings ?? {};

  // Interface pre-flight (E-WIDEN-3): refuse honestly BEFORE running if the
  // recipe calls a host interface the caller did not bind, instead of failing
  // later with an opaque `x is not a function` TypeError.
  if (options.check !== false) {
    const preflight = checkRecipe(recipe, bindings);
    if (!preflight.ok) {
      return {
        ok: false,
        error: `recipe requires host interface(s) [${preflight.requires.join(', ')}]; missing [${preflight.missing.join(', ')}]. Provide them via ctx.bindings, or pass { check: false } to run anyway.`,
        capabilities: recipe.capabilities,
        missingBindings: preflight.missing,
      };
    }
  }

  // Expose each provided binding as a callable name AND rebuild namespace
  // objects (a `machine.shell` binding becomes `machine.shell`). The recipe
  // reads these by name; the harness chose the implementations.
  const boundCtx: Record<string, unknown> = { ...ctx };
  const nsObjects: Record<string, Record<string, unknown>> = {};
  const bareFns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (key.includes('.')) {
      // Dotted key: `machine.shell` -> nsObjects.machine.shell.
      const [ns, method] = key.split('.');
      (nsObjects[ns] ??= {})[method] = value;
    } else if (typeof value === 'function') {
      // Bare function: `shell` -> a callable name.
      bareFns[key] = value;
    } else if (value && typeof value === 'object') {
      // Namespace object: `{ machine: { shell: fn } }` -> merge into nsObjects.
      nsObjects[key] = { ...(nsObjects[key] ?? {}), ...(value as Record<string, unknown>) };
    }
  }
  for (const [name, fn] of Object.entries(bareFns)) boundCtx[name] = fn;
  for (const [ns, methods] of Object.entries(nsObjects)) boundCtx[ns] = methods;

  const bareNames = Object.keys(bareFns);
  const namespaceNames = Object.keys(nsObjects);
  const injected = [...bareNames, ...namespaceNames];
  const injectedValues = [
    ...bareNames.map((k) => bareFns[k]),
    ...namespaceNames.map((ns) => nsObjects[ns]),
  ];

  const argNames = ['ctx', ...SHADOWED_PARAMS, ...injected];
  const argValues: unknown[] = [
    Object.freeze({ ...boundCtx }),
    ...SHADOWED_PARAMS.map(() => undefined),
    ...injectedValues,
  ];

  try {
    // Classify the code shape with the AST. Callable shapes (export/module/bare
    // function expression) are normalized then CALLED with (ctx.input, ctx).
    // Bare bodies run as a factory. Invalid shapes fail honestly, not silently.
    const shape = classifyRecipe(recipe.code);
    if (shape.kind === 'invalid') {
      return { ok: false, error: `recipe code shape invalid: ${shape.reason}`, capabilities: recipe.capabilities };
    }
    if (shape.kind === 'callable') {
      const loader = new Function(...argNames, `'use strict';\n${shape.source}`);
      const callable = loader(...argValues);
      if (typeof callable !== 'function') throw new Error('recipe export is not callable');
      const output = callable((ctx as { input?: unknown }).input, Object.freeze({ ...boundCtx }));
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
