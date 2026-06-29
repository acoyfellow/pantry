// deploy-coey-worker — the FIRST real recurring-pattern recipe.
//
// This encodes, step for step, the procedure we ran BY HAND this session to put
// the pantry Worker on pantry.coey.dev with D1, guardrail-compliant. It is a
// GUIDED PROCEDURE recipe: its `code` is a pure function that, given an input,
// returns the ordered, parameterized plan. It does NOT itself run wrangler or
// any destructive command — the caller reads the plan and runs the steps in a
// real shell, with eyes open. The traps we actually hit are baked in:
//   - `wrangler d1 create` can print a PHANTOM database_id that never persists
//     (we got code 10181 / 7404 until we read the REAL id from `wrangler d1
//     list`). So the plan creates, then re-reads the id from `d1 list`.
//   - a public custom route + a sensitive binding (D1) is a guardrail concern:
//     the wrangler shim warns-and-passes WITH code auth before every route, and
//     blocks a CRITICAL binding with no auth. Pantry's bearer auth is what makes
//     the D1 (WARNING) deploy pass cleanly.
//   - a stale local DNS resolver can make plain `curl https://<name>.coey.dev`
//     fail to resolve even when the Worker is live; verify with `curl --resolve`.
//
// Because the steps are derived from the live wrangler.jsonc in this repo
// (account_id, the real database_id, the custom_domain route, workers_dev:false),
// they match reality and not an invented ideal.

import type { RecipeInput } from '../../src/recipe.ts';

// The script a caller fetches and runs over the bounded `ctx`. It is a PURE
// planner: it reads ctx.input and returns { steps: [...] }. No I/O, no wrangler,
// no deploy. The guard in run-recipe.ts permits it (no import/Function/eval).
const DEPLOY_COEY_WORKER_CODE = `
const input = (ctx && ctx.input) || {};
const workerName = String(input.workerName || 'my-worker');
const subdomain = String(input.subdomain || workerName);
const dbName = String(input.dbName || (workerName + '-db'));
const accountId = String(input.accountId || '<your-account-id>');
const fqdn = subdomain + '.coey.dev';

const steps = [
  {
    n: 1,
    title: 'Create the D1 database, then read its REAL id',
    why: 'wrangler d1 create can print a PHANTOM database_id that never persists (we hit code 10181 / 7404 trusting it). The id that actually works is the one d1 list reports.',
    commands: [
      'wrangler d1 create ' + dbName,
      "wrangler d1 list --json | jq -r '.[] | select(.name==\\"" + dbName + "\\") | .uuid'",
    ],
    capture: 'database_id (from d1 list, NOT from the create output)',
  },
  {
    n: 2,
    title: 'Wire wrangler.jsonc to the gated custom domain',
    why: 'The only public surface must be the gated custom domain: no workers.dev URL. Bind the REAL database_id captured in step 1.',
    edit: 'wrangler.jsonc',
    set: {
      account_id: accountId,
      'd1_databases[0].database_id': '<REAL id from step 1>',
      'd1_databases[0].database_name': dbName,
      routes: [{ pattern: fqdn, custom_domain: true }],
      workers_dev: false,
    },
  },
  {
    n: 3,
    title: 'Apply migrations to the REMOTE database',
    why: 'The remote D1 must have the schema before the deployed Worker queries it.',
    commands: ['wrangler d1 migrations apply ' + dbName + ' --remote'],
  },
  {
    n: 4,
    title: 'GUARDRAIL: a public route + a sensitive binding needs code auth',
    why: 'Per guardrail/docs/DEPLOYMENT-RULES.md: a public custom route plus a sensitive binding (D1 is a WARNING binding) means the wrangler shim warn-and-passes ONLY WITH non-partial code auth before EVERY route, and BLOCKS a CRITICAL binding (ai/secret_text/vectorize) with no auth. Auth must be fail-closed: a bearer token checked against an env secret, with a 401 branch, applied before any route can touch the binding. Partial auth counts as unauthenticated.',
    check: [
      'read guardrail/docs/DEPLOYMENT-RULES.md',
      'confirm bearer auth runs before every route (fail-closed 401, not partial)',
      'confirm workers_dev:false so there is no ungated workers.dev URL',
    ],
  },
  {
    n: 5,
    title: 'Deploy (guardrail-mediated)',
    why: 'With code auth in place the shim warns-and-passes the D1 (WARNING) deploy; without it, a CRITICAL binding would be blocked.',
    commands: ['wrangler deploy'],
  },
  {
    n: 6,
    title: 'Verify the live route AND the fail-closed gate',
    why: 'Prove the Worker is up (health 200) AND that an unauthenticated request to a gated route is rejected (401). A stale local DNS resolver can make plain curl "could not resolve host" even when live — use --resolve to bypass it.',
    commands: [
      'IP=$(dig +short ' + fqdn + ' | head -1)',
      'curl -s -o /dev/null -w "%{http_code}" --resolve ' + fqdn + ':443:$IP https://' + fqdn + '/health   # expect 200',
      'curl -s -o /dev/null -w "%{http_code}" --resolve ' + fqdn + ':443:$IP https://' + fqdn + '/recipes   # expect 401 (no token = fail-closed)',
    ],
    expect: { health: 200, gatedWithoutToken: 401 },
  },
];

return {
  worker: workerName,
  domain: fqdn,
  database: dbName,
  accountId: accountId,
  note: 'Guided plan only. This recipe does NOT run wrangler or deploy. Run the steps yourself, reading each why/trap.',
  steps: steps,
};
`.trim();

export const deployCoeyWorkerRecipe: RecipeInput = {
  name: 'deploy_coey_worker',
  description:
    'Guided steps to deploy a Cloudflare Worker to a <name>.coey.dev custom domain with D1, guardrail-compliant. Returns an ordered plan; does not execute destructive commands.',
  inputSchema: {
    type: 'object',
    properties: {
      workerName: { type: 'string', description: 'Worker name, e.g. pantry-worker' },
      subdomain: { type: 'string', description: 'subdomain under coey.dev, e.g. "pantry" -> pantry.coey.dev' },
      dbName: { type: 'string', description: 'D1 database name, e.g. pantry-db' },
      accountId: { type: 'string', description: 'Cloudflare account id' },
    },
    required: ['workerName', 'subdomain', 'dbName', 'accountId'],
  },
  code: DEPLOY_COEY_WORKER_CODE,
  // Honest: the plan's steps run a shell (wrangler, curl, dig). The recipe code
  // is a pure planner, but what it tells you to DO is machine.shell + wrangler.
  // Not workspace.none — that would imply no shell, which is false.
  capabilities: ['machine.shell', 'machine.wrangler'],
  status: 'enabled',
  sourceRunId: null,
};

// Push to the live pantry via the existing PantryClient (no reimplemented HTTP).
// Usage: PANTRY_URL=... PANTRY_TOKEN=... bun examples/recipes/deploy-coey-worker.ts
async function main(): Promise<void> {
  const { pantry } = await import('../../src/client.ts');
  if (!pantry.configured) {
    console.error('set PANTRY_URL and PANTRY_TOKEN to push deploy_coey_worker');
    process.exit(1);
  }
  const result = await pantry.push(deployCoeyWorkerRecipe);
  console.log(`pushed '${result.name}' as version ${result.version}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
