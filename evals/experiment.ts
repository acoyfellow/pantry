import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer';
import { distractorNames, tasks, unmatchedTasks } from './tasks.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const slug = (process.env.EVAL_MODEL || 'gpt-4.1-mini').replace(/[^a-zA-Z0-9.-]/g, '-');
const out = join(root, 'evals', `experiment-results.${slug}.json`);

const OPENAI_GATEWAY = 'https://gateway.opencode.cloudflare.dev/openai/chat/completions';
const ANTHROPIC_GATEWAY = 'https://gateway.opencode.cloudflare.dev/anthropic/v1/messages';
const MODEL = process.env.EVAL_MODEL || 'gpt-4.1-mini';
const isAnthropic = MODEL.startsWith('claude');
const usesReasoningBudget = /^(gpt-5|o1|o3|o4)/.test(MODEL);
const supportsTemperature = process.env.EVAL_NO_TEMPERATURE !== '1';
const TRIALS = Number(process.env.EVAL_TRIALS || 3);
const TEMPERATURE = Number(process.env.EVAL_TEMPERATURE ?? 1);
const CATALOG_SIZES = [8, 32, 128];

function accessToken(): string {
  const token = process.env.CF_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'CF_ACCESS_TOKEN is required. Mint your own with: ' +
        'CF_ACCESS_TOKEN=$(cloudflared access login --no-verbose -app=https://opencode.cloudflare.dev)',
    );
  }
  return token;
}

const token = accessToken();

type Usage = { input: number; output: number; total: number };
type Completion = { text: string; usage: Usage };

function requestFor(prompt: string, maxTokens: number) {
  if (isAnthropic) {
    return {
      url: ANTHROPIC_GATEWAY,
      headers: {
        'cf-access-token': token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: MODEL,
        max_tokens: maxTokens,
        ...(supportsTemperature ? { temperature: TEMPERATURE } : {}),
        messages: [{ role: 'user', content: prompt }],
      },
    };
  }
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
  };
  if (usesReasoningBudget) {
    body.max_completion_tokens = maxTokens + 2000;
  } else {
    body.max_tokens = maxTokens;
    if (supportsTemperature) body.temperature = TEMPERATURE;
  }
  return {
    url: OPENAI_GATEWAY,
    headers: { 'cf-access-token': token, 'content-type': 'application/json' },
    body,
  };
}

async function complete(prompt: string, maxTokens: number): Promise<Completion> {
  const spec = requestFor(prompt, maxTokens);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(spec.url, {
      method: 'POST',
      headers: spec.headers,
      body: JSON.stringify(spec.body),
    });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`gateway ${response.status}: ${await response.text()}`);
    if (isAnthropic) {
      const body = (await response.json()) as {
        content?: { type?: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const input = body.usage?.input_tokens ?? 0;
      const output = body.usage?.output_tokens ?? 0;
      return {
        text: (body.content ?? [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n'),
        usage: { input, output, total: input + output },
      };
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      usage: {
        input: body.usage?.prompt_tokens ?? 0,
        output: body.usage?.completion_tokens ?? 0,
        total: body.usage?.total_tokens ?? 0,
      },
    };
  }
  throw new Error('gateway retries exhausted');
}

function extractCode(text: string): string {
  const fenced = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

function normalize(value: unknown): string {
  const seen = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(seen);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, seen(val)]),
      );
    }
    return input;
  };
  return JSON.stringify(seen(value));
}

function scoreCode(code: string, cases: { input: unknown; expected: unknown }[]) {
  let passed = 0;
  const failures: string[] = [];
  for (const testCase of cases) {
    try {
      const fn = new Function('ctx', code);
      const actual = fn({ input: testCase.input });
      if (normalize(actual) === normalize(testCase.expected)) passed += 1;
      else failures.push(`${normalize(testCase.input)} -> ${normalize(actual)}`);
    } catch (error) {
      failures.push(`${normalize(testCase.input)} threw ${(error as Error).message}`);
    }
  }
  return { passed, total: cases.length, allPassed: passed === cases.length, failures };
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function buildCatalog(size: number, includeNames: string[]): string {
  const entries = includeNames.map((name) => {
    const task = tasks.find((candidate) => candidate.name === name);
    return `- ${name}: ${task ? task.spec : 'saved operational procedure'}`;
  });
  for (const name of distractorNames) {
    if (entries.length >= size) break;
    entries.push(`- ${name}: saved operational procedure for ${name.replace(/_/g, ' ')}`);
  }
  let filler = 0;
  while (entries.length < size) {
    filler += 1;
    entries.push(`- helper_procedure_${filler}: saved helper for internal routine ${filler}`);
  }
  return entries.slice(0, size).join('\n');
}

const generation: Record<string, unknown>[] = [];
const retrieval: Record<string, unknown>[] = [];

console.log(`model=${MODEL} trials=${TRIALS} temperature=${TEMPERATURE}`);

for (const task of tasks) {
  const referenceScore = scoreCode(task.referenceCode, task.cases);
  if (!referenceScore.allPassed) {
    throw new Error(
      `reference code for ${task.name} fails its own cases: ${referenceScore.failures.join('; ')}`,
    );
  }

  const prompt = `Write a JavaScript function body that reads input from \`ctx.input\` and returns the result object.
Return only code in a single fenced block. No explanation, no function wrapper, no imports.

Specification: ${task.spec}`;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const completion = await complete(prompt, 700);
    const code = extractCode(completion.text);
    const score = scoreCode(code, task.cases);
    generation.push({
      task: task.name,
      trial,
      usage: completion.usage,
      codeDigest: digest(code),
      codeChars: code.length,
      passed: score.passed,
      total: score.total,
      allPassed: score.allPassed,
      failures: score.failures.slice(0, 3),
    });
    console.log(
      `generate ${task.name} trial=${trial} pass=${score.passed}/${score.total} out=${completion.usage.output}`,
    );
  }
}

for (const size of CATALOG_SIZES) {
  const catalog = buildCatalog(
    size,
    tasks.map((task) => task.name),
  );
  const catalogTokens = encode(catalog).length;

  for (const task of tasks) {
    const prompt = `You have a catalog of saved procedures. Choose the one that already solves the request exactly, or answer NONE if no saved procedure fits.
Answer with only the procedure name or NONE.

Catalog:
${catalog}

Request: ${task.spec}`;
    const completion = await complete(prompt, 20);
    const answer = completion.text.trim().replace(/[^a-zA-Z0-9_]/g, '');
    retrieval.push({
      catalogSize: size,
      catalogTokens,
      task: task.name,
      expected: task.name,
      answer,
      correct: answer === task.name,
      kind: 'matched',
      usage: completion.usage,
    });
    console.log(
      `retrieve n=${size} ${task.name} -> ${answer} ${answer === task.name ? 'OK' : 'MISS'}`,
    );
  }

  for (const task of unmatchedTasks) {
    const prompt = `You have a catalog of saved procedures. Choose the one that already solves the request exactly, or answer NONE if no saved procedure fits.
Answer with only the procedure name or NONE.

Catalog:
${catalog}

Request: ${task.spec}`;
    const completion = await complete(prompt, 20);
    const answer = completion.text.trim().replace(/[^a-zA-Z0-9_]/g, '');
    retrieval.push({
      catalogSize: size,
      catalogTokens,
      task: task.name,
      expected: 'NONE',
      answer,
      correct: answer.toUpperCase() === 'NONE',
      kind: 'unmatched',
      usage: completion.usage,
    });
    console.log(
      `retrieve n=${size} ${task.name} -> ${answer} ${answer.toUpperCase() === 'NONE' ? 'OK' : 'FALSE-HIT'}`,
    );
  }
}

const perTask = tasks.map((task) => {
  const rows = generation.filter((row) => row.task === task.name);
  const distinct = new Set(rows.map((row) => row.codeDigest as string));
  const passes = rows.filter((row) => row.allPassed).length;
  const outputTokens = rows.map((row) => (row.usage as Usage).output);
  return {
    task: task.name,
    trials: rows.length,
    trialsFullyCorrect: passes,
    generationPassRate: rows.length ? passes / rows.length : 0,
    distinctImplementations: distinct.size,
    meanOutputTokens: outputTokens.length
      ? Math.round(outputTokens.reduce((a, b) => a + b, 0) / outputTokens.length)
      : 0,
    meanTotalTokens: rows.length
      ? Math.round(rows.reduce((sum, row) => sum + (row.usage as Usage).total, 0) / rows.length)
      : 0,
    referenceCodeTokens: encode(task.referenceCode).length,
  };
});

const retrievalSummary = CATALOG_SIZES.map((size) => {
  const rows = retrieval.filter((row) => row.catalogSize === size);
  const matched = rows.filter((row) => row.kind === 'matched');
  const unmatched = rows.filter((row) => row.kind === 'unmatched');
  return {
    catalogSize: size,
    catalogTokens: rows[0]?.catalogTokens ?? 0,
    matchedCorrect: matched.filter((row) => row.correct).length,
    matchedTotal: matched.length,
    falseHits: unmatched.filter((row) => !row.correct).length,
    unmatchedTotal: unmatched.length,
    meanRetrievalTotalTokens: rows.length
      ? Math.round(rows.reduce((sum, row) => sum + (row.usage as Usage).total, 0) / rows.length)
      : 0,
  };
});

const generationMeanTotal = perTask.length
  ? Math.round(perTask.reduce((sum, row) => sum + row.meanTotalTokens, 0) / perTask.length)
  : 0;
const generationPassRate = generation.length
  ? generation.filter((row) => row.allPassed).length / generation.length
  : 0;

const results = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  temperature: TEMPERATURE,
  trials: TRIALS,
  tokenBasis: 'provider-reported',
  oracle: 'held-out cases executed against generated and saved code with the same comparator',
  arms: {
    generate: {
      meanTotalTokensPerTask: generationMeanTotal,
      passRate: generationPassRate,
      note: 'model writes the procedure from the specification each time',
    },
    'pantry-reuse': {
      passRate: 1,
      passRateBasis:
        'saved reference code is verified against the same held-out cases before the run',
      note: 'execution is deterministic; the model cost is retrieval only, reported in retrieval[]',
    },
  },
  perTask,
  retrieval: retrievalSummary,
  rows: { generation, retrieval },
};

writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\nwrote ${out}`);
console.log(JSON.stringify({ perTask, retrieval: retrievalSummary }, null, 2));
