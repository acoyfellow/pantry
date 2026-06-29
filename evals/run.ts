import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { sampleRecipe } from '../examples/sample-recipe.ts';
import { deployCoeyWorkerRecipe } from '../examples/recipes/deploy-coey-worker.ts';
import { verifyLiveWorkerRecipe } from '../examples/recipes/verify-live-worker.ts';
import type { RecipeInput } from '../src/recipe.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'evals', 'results.json');

type Technique = 'prompt-from-scratch' | 'inline-tool-def-each-time' | 'pantry-reuse';

const jsonTransformRecipe: RecipeInput = {
  name: 'json_project_rename',
  description: 'Project selected JSON fields and rename them deterministically. No I/O.',
  inputSchema: {
    type: 'object',
    properties: {
      records: { type: 'array' },
      fields: { type: 'object' },
    },
    required: ['records', 'fields'],
  },
  code: `
const records = Array.isArray(ctx.input.records) ? ctx.input.records : [];
const fields = ctx.input.fields && typeof ctx.input.fields === 'object' ? ctx.input.fields : {};
return {
  records: records.map((record) => {
    const out = {};
    for (const [from, to] of Object.entries(fields)) out[String(to)] = record ? record[from] : undefined;
    return out;
  }),
};
`.trim(),
  capabilities: ['json.transform'],
  status: 'enabled',
  sourceRunId: null,
};

const tasks = [
  { recipe: sampleRecipe, input: { text: 'Pantry Cost Savings: Measure, Measure, Share!' }, expect: (v: any) => v.slug === 'pantry-cost-savings-measure-measure-share' },
  { recipe: verifyLiveWorkerRecipe, input: { subdomain: 'pantry', gatedPath: '/recipes' }, expect: (v: any) => v.resolve?.command && Array.isArray(v.checks) && v.expect?.gatedWithoutToken === 401 },
  { recipe: deployCoeyWorkerRecipe, input: { workerName: 'pantry', subdomain: 'pantry', dbName: 'pantry-db', accountId: 'example-account' }, expect: (v: any) => Array.isArray(v.steps) && v.steps.length >= 6 },
  { recipe: jsonTransformRecipe, input: { records: [{ id: 1, name: 'Ada', ignore: true }], fields: { id: 'userId', name: 'label' } }, expect: (v: any) => v.records?.[0]?.userId === 1 && v.records?.[0]?.label === 'Ada' },
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function runRecipe(recipe: RecipeInput, input: unknown): { ms: number; result: unknown } {
  const fn = new Function('ctx', recipe.code);
  const start = performance.now();
  const result = fn({ input });
  return { ms: Math.round(performance.now() - start), result };
}

const rows = tasks.flatMap(({ recipe, input, expect }) => {
  const procedure = `${recipe.description}\ninput schema:\n${JSON.stringify(recipe.inputSchema, null, 2)}\ncode:\n${recipe.code}`;
  const scratchPrompt = `Write and execute the procedure for this recurring task without using a saved recipe. Task: ${recipe.description}. Input: ${JSON.stringify(input)}.`;
  const inlinePrompt = `Use this procedure exactly for the recurring task.\n${procedure}\nInput: ${JSON.stringify(input)}.`;
  const { ms, result } = runRecipe(recipe, input);
  const correct = expect(result);
  return ([
    {
      task: recipe.name,
      technique: 'prompt-from-scratch' as Technique,
      tokens: { input: estimateTokens(scratchPrompt), output: estimateTokens(procedure), total: estimateTokens(scratchPrompt) + estimateTokens(procedure), basis: 'estimated' },
      wallClockMs: { value: null, basis: 'not-measured', note: 'No live model call is made by this harness.' },
      correct: { value: null, basis: 'not-measured' },
    },
    {
      task: recipe.name,
      technique: 'inline-tool-def-each-time' as Technique,
      tokens: { input: estimateTokens(inlinePrompt), output: 0, total: estimateTokens(inlinePrompt), basis: 'estimated' },
      wallClockMs: { value: null, basis: 'not-measured', note: 'No live model call is made by this harness.' },
      correct: { value: null, basis: 'not-measured' },
    },
    {
      task: recipe.name,
      technique: 'pantry-reuse' as Technique,
      tokens: { input: estimateTokens(`${recipe.name} ${recipe.description} ${JSON.stringify(recipe.inputSchema)}`), output: 0, total: estimateTokens(`${recipe.name} ${recipe.description} ${JSON.stringify(recipe.inputSchema)}`), basis: 'estimated-discovery-only', note: 'Saved code path uses 0 model tokens; discovery text is estimated from the actual recipe list entry.' },
      wallClockMs: { value: ms, basis: 'measured-local-deterministic' },
      correct: { value: correct, basis: 'measured-local-deterministic' },
    },
  ]);
});

const byTechnique: Record<string, any> = {};
for (const technique of ['prompt-from-scratch', 'inline-tool-def-each-time', 'pantry-reuse']) {
  const set = rows.filter((r) => r.technique === technique);
  byTechnique[technique] = {
    totalTokens: set.reduce((sum, r) => sum + r.tokens.total, 0),
    tokenBasis: set[0].tokens.basis,
    measuredMsTotal: set.every((r) => typeof r.wallClockMs.value === 'number') ? set.reduce((sum, r) => sum + (r.wallClockMs.value ?? 0), 0) : null,
    correctMeasured: set.filter((r) => r.correct.value === true).length,
    tasks: set.length,
  };
}

const results = {
  generatedAt: new Date().toISOString(),
  honesty: 'No live model API was called. Prompt-from-scratch and inline-tool tokens are transparent estimates from actual prompt/procedure text using ceil(chars/4). Pantry deterministic recipe execution wall-clock and correctness are measured locally. Pantry discovery tokens are an estimate from actual list-entry text; saved code execution uses 0 model tokens.',
  modelCalls: false,
  tokenizer: 'ceil(characters/4), approximate and labeled',
  rows,
  summary: byTechnique,
};

writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(JSON.stringify(results.summary, null, 2));
