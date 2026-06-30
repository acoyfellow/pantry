import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer';
import { deployCoeyWorkerRecipe } from '../examples/recipes/deploy-coey-worker.ts';
import { verifyLiveWorkerRecipe } from '../examples/recipes/verify-live-worker.ts';
import { sampleRecipe } from '../examples/sample-recipe.ts';
import type { RecipeInput } from '../src/recipe.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'evals', 'results.json');
const live = process.env.LIVE_MODEL === '1';

type Technique = 'prompt-from-scratch' | 'inline-tool-def-each-time' | 'pantry-reuse';

const jsonTransformRecipe: RecipeInput = {
  name: 'json_project_rename',
  description: 'Project selected JSON fields and rename them deterministically. No I/O.',
  inputSchema: {
    type: 'object',
    properties: { records: { type: 'array' }, fields: { type: 'object' } },
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
  {
    recipe: sampleRecipe,
    input: { text: 'Pantry Cost Savings: Measure, Measure, Share!' },
    expect: (v: any) => v.slug === 'pantry-cost-savings-measure-measure-share',
  },
  {
    recipe: verifyLiveWorkerRecipe,
    input: { subdomain: 'pantry', gatedPath: '/recipes' },
    expect: (v: any) =>
      v.resolve?.command && Array.isArray(v.checks) && v.expect?.gatedWithoutToken === 401,
  },
  {
    recipe: deployCoeyWorkerRecipe,
    input: {
      workerName: 'pantry',
      subdomain: 'pantry',
      dbName: 'pantry-db',
      accountId: 'example-account',
    },
    expect: (v: any) => Array.isArray(v.steps) && v.steps.length >= 6,
  },
  {
    recipe: jsonTransformRecipe,
    input: {
      records: [{ id: 1, name: 'Ada', ignore: true }],
      fields: { id: 'userId', name: 'label' },
    },
    expect: (v: any) => v.records?.[0]?.userId === 1 && v.records?.[0]?.label === 'Ada',
  },
];

function tokens(text: string): number {
  return encode(text).length;
}
function compact(value: unknown) {
  const s = JSON.stringify(value) ?? String(value);
  return {
    sha256: createHash('sha256').update(s).digest('hex').slice(0, 16),
    preview: s.slice(0, 180),
  };
}
function parseJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
function runRecipe(recipe: RecipeInput, input: unknown): { ms: number; result: unknown } {
  const fn = new Function('ctx', recipe.code);
  const start = performance.now();
  const result = fn({ input });
  return { ms: Math.round(performance.now() - start), result };
}

async function callOpenAI(prompt: string) {
  if (!process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const j: any = await r.json();
  return {
    provider: 'openai',
    model,
    text: j.choices?.[0]?.message?.content ?? '',
    usage: {
      input: j.usage?.prompt_tokens ?? null,
      output: j.usage?.completion_tokens ?? null,
      total: j.usage?.total_tokens ?? null,
      basis: 'provider-reported',
    },
  };
}

async function callAnthropic(prompt: string) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const j: any = await r.json();
  return {
    provider: 'anthropic',
    model,
    text: j.content?.map((c: any) => c.text ?? '').join('\n') ?? '',
    usage: {
      input: j.usage?.input_tokens ?? null,
      output: j.usage?.output_tokens ?? null,
      total: (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0),
      basis: 'provider-reported',
    },
  };
}

async function modelCall(prompt: string) {
  return (await callOpenAI(prompt)) ?? (await callAnthropic(prompt));
}

const rows: any[] = [];
let liveModel: any = null;
let liveNote = live
  ? 'LIVE_MODEL=1 set, but no reachable provider was found. Workers AI Access text route is not configured in this repo; OpenAI and Anthropic env keys were absent or failed.'
  : null;

for (const { recipe, input, expect } of tasks) {
  const procedure = `${recipe.description}\ninput schema:\n${JSON.stringify(recipe.inputSchema, null, 2)}\ncode:\n${recipe.code}`;
  const scratchPrompt = `Return only JSON output for this recurring task. Do not explain. Task: ${recipe.description}. Input: ${JSON.stringify(input)}.`;
  const inlinePrompt = `Return only JSON output. Use this saved procedure exactly.\n${procedure}\nInput: ${JSON.stringify(input)}.`;
  const discovery = `${recipe.name} ${recipe.description} ${JSON.stringify(recipe.inputSchema)}`;
  const pantry = runRecipe(recipe, input);
  for (const [technique, prompt] of [
    ['prompt-from-scratch', scratchPrompt],
    ['inline-tool-def-each-time', inlinePrompt],
  ] as const) {
    let row: any = {
      task: recipe.name,
      technique,
      tokens: {
        input: tokens(prompt),
        output: 0,
        total: tokens(prompt),
        basis: 'tokenizer-estimated',
        tokenizer: 'gpt-tokenizer cl100k_base',
      },
      wallClockMs: { value: null, basis: 'not-measured' },
      correct: { value: null, basis: 'not-measured-without-live-model' },
    };
    if (live) {
      try {
        const start = performance.now();
        const res = await modelCall(prompt);
        if (res) {
          liveModel = { provider: res.provider, model: res.model };
          liveNote = null;
          const parsed = parseJson(res.text);
          row = {
            ...row,
            tokens: res.usage,
            wallClockMs: {
              value: Math.round(performance.now() - start),
              basis: 'measured-provider-call',
            },
            correct: { value: expect(parsed), basis: 'deterministic-oracle-on-model-json' },
            output: compact(res.text),
          };
        }
      } catch (e) {
        liveNote = `LIVE_MODEL=1 attempted, provider failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    rows.push(row);
  }
  const ok = expect(pantry.result);
  rows.push({
    task: recipe.name,
    technique: 'pantry-reuse' as Technique,
    tokens: {
      input: tokens(discovery),
      output: 0,
      total: tokens(discovery),
      basis: 'tokenizer-estimated-discovery-only',
      tokenizer: 'gpt-tokenizer cl100k_base',
      note: 'exact saved-code execution; discovery text still has a model-readable payload and total-token savings are not implied.',
    },
    wallClockMs: { value: pantry.ms, basis: 'measured-local-deterministic' },
    correct: { value: ok, basis: 'deterministic-oracle-on-recipe-output' },
    output: compact(pantry.result),
  });
}

const summary: Record<string, any> = {};
for (const technique of ['prompt-from-scratch', 'inline-tool-def-each-time', 'pantry-reuse']) {
  const set = rows.filter((r) => r.technique === technique);
  summary[technique] = {
    totalTokens: set.reduce((s, r) => s + (r.tokens.total ?? 0), 0),
    tokenBasis: set[0].tokens.basis,
    measuredMsTotal: set.every((r) => typeof r.wallClockMs.value === 'number')
      ? set.reduce((s, r) => s + r.wallClockMs.value, 0)
      : null,
    correct: set.filter((r) => r.correct.value === true).length,
    tasks: set.length,
  };
}

const results = {
  generatedAt: new Date().toISOString(),
  mode: liveModel ? 'live-model' : 'honest-estimate',
  claim:
    'A model may re-derive a recurring procedure each time and may be wrong. Pantry hands back exact saved code, improving determinism. It can reduce output tokens, but total-token savings are not broadly demonstrated.',
  model: liveModel,
  note: liveNote,
  tokenizer: 'gpt-tokenizer cl100k_base for non-provider estimates',
  summary,
  rows,
};
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(
  JSON.stringify(
    { mode: results.mode, model: results.model, note: results.note, summary },
    null,
    2,
  ),
);
