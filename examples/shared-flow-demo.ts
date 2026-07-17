// Local-only cross-agent shared-recipe proof.
//
// This demo drives the real Worker routes over FakeD1, with fixture-only
// credentials. Pantry stores and returns code; the second agent runs the
// fetched recipe in the caller-side demo runner. Nothing here contacts the
// deployed Pantry service or performs a live push.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { PantryClient } from '../src/client.ts';
import type { FullRecipe, RecipeInput } from '../src/recipe.ts';
import app, { type Env } from '../src/worker.ts';
import { FakeD1 } from '../test/fake-d1.ts';
import { runRecipe } from './run-recipe.ts';

const RECEIPT_PATH = '.terraloop/shared-flow-receipt.json';
const ALICE_FIXTURE_CREDENTIAL = 'fixture-alice-token';
const BOB_FIXTURE_CREDENTIAL = 'fixture-bob-token';
const INVALID_FIXTURE_CREDENTIAL = 'fixture-invalid-token';

const sharedRecipe: RecipeInput = {
  name: 'shared_title_case',
  description: 'Convert words to title case without host access.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  code: `export default (input) => ({
  value: String(input.text || '')
    .trim()
    .split(/\\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
});`,
  capabilities: ['workspace.none', 'text.transform'],
  sourceRunId: null,
  status: 'enabled',
  visibility: 'shared',
};

const privateRecipe: RecipeInput = {
  ...sharedRecipe,
  name: 'alice_private_check',
  description: 'A private owner-only fixture recipe.',
  code: `export default () => ({ value: 'private' });`,
  visibility: 'private',
};

type Assertion = {
  id: string;
  pass: boolean;
  details?: Record<string, unknown>;
  error?: string;
};

type FlowReceipt = {
  run: number;
  assertions: Assertion[];
  deterministicRuns: {
    first: string | null;
    second: string | null;
    firstSha256: string | null;
    secondSha256: string | null;
    byteIdentical: boolean;
  };
};

function workerFetch(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(String(input), init);
    return app.fetch(request, env);
  }) as unknown as typeof fetch;
}

function makeClient(env: Env, token: string): PantryClient {
  return new PantryClient({
    url: 'https://pantry.fixture',
    token,
    fetch: workerFetch(env),
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputBytes(value: unknown): string {
  return JSON.stringify(value);
}

async function runFlow(run: number): Promise<FlowReceipt> {
  const db = new FakeD1();
  const env: Env = {
    DB: db as unknown as D1Database,
    PANTRY_TOKENS: JSON.stringify({
      [ALICE_FIXTURE_CREDENTIAL]: 'alice',
      [BOB_FIXTURE_CREDENTIAL]: 'bob',
    }),
  };
  const alice = makeClient(env, ALICE_FIXTURE_CREDENTIAL);
  const bob = makeClient(env, BOB_FIXTURE_CREDENTIAL);
  const invalid = makeClient(env, INVALID_FIXTURE_CREDENTIAL);
  const assertions: Assertion[] = [];
  let fetchedShared: FullRecipe | null = null;
  let firstRun: string | null = null;
  let secondRun: string | null = null;

  async function check(
    id: string,
    operation: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    try {
      assertions.push({ id, pass: true, details: await operation() });
    } catch (error) {
      assertions.push({
        id,
        pass: false,
        error: error instanceof Error ? error.message : 'assertion failed',
      });
    }
  }

  await check('alice_shared_create', async () => {
    const pushed = await alice.push(sharedRecipe);
    await alice.push(privateRecipe);
    const stored = await alice.get(sharedRecipe.name);
    if (pushed.name !== sharedRecipe.name || pushed.version !== 1) {
      throw new Error('Alice shared POST did not create version 1');
    }
    if (stored?.visibility !== 'shared') throw new Error('shared visibility was not stored');
    return { name: pushed.name, version: pushed.version, visibility: stored.visibility };
  });

  let bobSharedList: Awaited<ReturnType<PantryClient['listShared']>> = [];
  await check('bob_shared_metadata', async () => {
    bobSharedList = await bob.listShared();
    const entry = bobSharedList.find((recipe) => recipe.name === sharedRecipe.name);
    if (!entry) throw new Error('Bob shared list did not include the shared recipe');
    if (entry.author !== 'alice' || entry.visibility !== 'shared') {
      throw new Error('shared metadata did not preserve author and visibility');
    }
    return { author: entry.author, visibility: entry.visibility, version: entry.version };
  });

  await check('bob_list_has_no_code', async () => {
    const serialized = JSON.stringify(bobSharedList);
    if (bobSharedList.some((recipe) => Object.prototype.hasOwnProperty.call(recipe, 'code'))) {
      throw new Error('Bob shared list exposed a code field');
    }
    if (serialized.includes(sharedRecipe.code)) throw new Error('Bob shared list exposed source');
    return { entries: bobSharedList.length, codeFields: 0 };
  });

  await check('bob_fetches_shared_source', async () => {
    fetchedShared = await bob.get(sharedRecipe.name);
    if (!fetchedShared || fetchedShared.code !== sharedRecipe.code) {
      throw new Error('Bob could not explicitly fetch the shared source');
    }
    const bytes = Buffer.byteLength(fetchedShared.code, 'utf8');
    return { sourceFetched: true, sourceBytes: bytes, sourceSha256: digest(fetchedShared.code) };
  });

  await check('bob_caller_run_expected', async () => {
    if (!fetchedShared) throw new Error('shared source was not available to the caller');
    const result = runRecipe(fetchedShared, { input: { text: 'sHaReD pAnTrY dEmO' } });
    firstRun = outputBytes(result.output);
    if (!result.ok || firstRun !== '{"value":"Shared Pantry Demo"}') {
      throw new Error('caller-side run returned an unexpected result');
    }
    if (!result.capabilities.includes('workspace.none')) {
      throw new Error('workspace.none trust signal was lost');
    }
    return { output: firstRun, capabilities: result.capabilities };
  });

  await check('same_input_is_byte_identical', async () => {
    if (!fetchedShared) throw new Error('shared source was not available to the caller');
    const input = { text: 'sHaReD pAnTrY dEmO' };
    const first = runRecipe(fetchedShared, { input });
    const second = runRecipe(fetchedShared, { input });
    firstRun = outputBytes(first.output);
    secondRun = outputBytes(second.output);
    if (firstRun !== secondRun) throw new Error('same input produced different bytes');
    return {
      firstSha256: digest(firstRun),
      secondSha256: digest(secondRun),
      byteIdentical: true,
    };
  });

  await check('alice_private_absent_from_bob_list', async () => {
    if (bobSharedList.some((recipe) => recipe.name === privateRecipe.name)) {
      throw new Error('Alice private recipe appeared in Bob shared list');
    }
    return { privateNameVisibleToBob: false };
  });

  await check('bob_cannot_fetch_alice_private', async () => {
    const privateFetch = await bob.get(privateRecipe.name);
    if (privateFetch !== null) throw new Error('Bob fetched Alice private recipe');
    return { status: 404, privateNameVisibleToBob: false };
  });

  await check('invalid_credentials_are_401', async () => {
    try {
      await invalid.listShared();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('401')) throw new Error('invalid credential did not return 401');
      return { status: 401 };
    }
    throw new Error('invalid credential unexpectedly succeeded');
  });

  return {
    run,
    assertions,
    deterministicRuns: {
      first: firstRun,
      second: secondRun,
      firstSha256: firstRun ? digest(firstRun) : null,
      secondSha256: secondRun ? digest(secondRun) : null,
      byteIdentical: firstRun !== null && firstRun === secondRun,
    },
  };
}

async function main(): Promise<void> {
  await mkdir('.terraloop', { recursive: true });
  const runs = [await runFlow(1), await runFlow(2)];
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    localOnly: true,
    fixtureCredentialsOnly: true,
    sourceIncluded: false,
    runs,
    overallPass: runs.every(
      (flow) =>
        flow.assertions.length === 9 &&
        flow.assertions.every((assertion) => assertion.pass) &&
        flow.deterministicRuns.byteIdentical,
    ),
  };
  await Bun.write(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  for (const flow of runs) {
    const passed = flow.assertions.filter((assertion) => assertion.pass).length;
    console.log(
      `run_${flow.run}: ${passed}/9 assertions passed; deterministic=${flow.deterministicRuns.byteIdentical}`,
    );
  }
  console.log(`receipt=${RECEIPT_PATH}`);
  console.log(`overall=${receipt.overallPass ? 'PASS' : 'FAIL'}`);
  if (!receipt.overallPass) process.exitCode = 1;
}

if (import.meta.main) main();
