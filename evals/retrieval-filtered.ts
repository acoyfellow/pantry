import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer';
import { distractorNames, tasks, unmatchedTasks } from './tasks.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'evals', 'retrieval-filtered-results.json');
const GATEWAY = 'https://gateway.opencode.cloudflare.dev/openai/chat/completions';
const MODEL = process.env.EVAL_MODEL || 'gpt-4.1-mini';
const SHORTLIST = 5;
const CATALOG_SIZE = 128;

const token = process.env.CF_ACCESS_TOKEN;
if (!token) {
  throw new Error(
    'CF_ACCESS_TOKEN is required. Mint your own with: ' +
      'CF_ACCESS_TOKEN=$(cloudflared access login --no-verbose -app=https://opencode.cloudflare.dev)',
  );
}

type Entry = { name: string; spec: string };

const catalog: Entry[] = [
  ...tasks.map((task) => ({ name: task.name, spec: task.spec })),
  ...distractorNames.map((name) => ({
    name,
    spec: `saved operational procedure for ${name.replace(/_/g, ' ')}`,
  })),
];
let filler = 0;
while (catalog.length < CATALOG_SIZE) {
  filler += 1;
  catalog.push({
    name: `helper_procedure_${filler}`,
    spec: `saved helper for internal routine ${filler}`,
  });
}

const STOP = new Set([
  'given',
  'return',
  'the',
  'and',
  'a',
  'an',
  'of',
  'as',
  'with',
  'for',
  'from',
  'into',
  'where',
  'that',
  'each',
  'is',
  'are',
  'be',
  'only',
  'every',
  'their',
  'it',
  'its',
  'no',
  'not',
  'if',
  'then',
  'else',
  'by',
  'to',
  'in',
  'on',
  'or',
  'value',
  'values',
  'string',
  'strings',
  'object',
  'array',
  'number',
  'result',
  'output',
  'input',
  'counts',
  'count',
  'single',
  'one',
  'two',
  'three',
  'use',
  'using',
  'which',
  'what',
  'when',
  'all',
  'any',
  'more',
  'than',
]);

function keywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9_\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP.has(word)),
    ),
  ];
}

function search(query: string, limit: number): Entry[] {
  const terms = keywords(query);
  return catalog
    .map((entry) => {
      const haystack = `${entry.name.replace(/_/g, ' ')} ${entry.spec}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      return { entry, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}

async function complete(prompt: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'cf-access-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 1,
        max_tokens: 20,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`gateway ${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      total: body.usage?.total_tokens ?? 0,
    };
  }
  throw new Error('retries exhausted');
}

const rows: Record<string, unknown>[] = [];
const probes = [
  ...tasks.map((task) => ({ name: task.name, spec: task.spec, expected: task.name })),
  ...unmatchedTasks.map((task) => ({ name: task.name, spec: task.spec, expected: 'NONE' })),
];

for (const probe of probes) {
  const shortlist = search(probe.spec, SHORTLIST);
  const rendered = shortlist.length
    ? shortlist.map((entry) => `- ${entry.name}: ${entry.spec}`).join('\n')
    : '- (no candidates matched the query)';
  const prompt = `You have a shortlist of saved procedures returned by a keyword search. Choose the one that already solves the request exactly, or answer NONE if no saved procedure fits.
Answer with only the procedure name or NONE.

Shortlist:
${rendered}

Request: ${probe.spec}`;
  const completion = await complete(prompt);
  const answer = completion.text.trim().replace(/[^a-zA-Z0-9_]/g, '');
  const correct =
    probe.expected === 'NONE' ? answer.toUpperCase() === 'NONE' : answer === probe.expected;
  rows.push({
    task: probe.name,
    expected: probe.expected,
    answer,
    correct,
    kind: probe.expected === 'NONE' ? 'unmatched' : 'matched',
    shortlistSize: shortlist.length,
    shortlistRecalled: shortlist.some((entry) => entry.name === probe.expected),
    promptTokens: encode(prompt).length,
    totalTokens: completion.total,
  });
  console.log(
    `filtered ${probe.name} -> ${answer} ${correct ? 'OK' : 'MISS'} shortlist=${shortlist.length} tok=${completion.total}`,
  );
}

const matched = rows.filter((row) => row.kind === 'matched');
const unmatched = rows.filter((row) => row.kind === 'unmatched');
const summary = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  catalogSize: CATALOG_SIZE,
  shortlistLimit: SHORTLIST,
  strategy: 'keyword search shortlist instead of full catalog listing',
  matchedCorrect: matched.filter((row) => row.correct).length,
  matchedTotal: matched.length,
  shortlistRecall: matched.filter((row) => row.shortlistRecalled).length,
  falseHits: unmatched.filter((row) => !row.correct).length,
  unmatchedTotal: unmatched.length,
  meanTotalTokens: rows.length
    ? Math.round(rows.reduce((sum, row) => sum + (row.totalTokens as number), 0) / rows.length)
    : 0,
  rows,
};

writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nwrote ${out}`);
console.log(
  JSON.stringify(
    {
      matchedCorrect: summary.matchedCorrect,
      matchedTotal: summary.matchedTotal,
      shortlistRecall: summary.shortlistRecall,
      falseHits: summary.falseHits,
      meanTotalTokens: summary.meanTotalTokens,
    },
    null,
    2,
  ),
);
