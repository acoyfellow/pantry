// verify-live-worker — the VERIFY step, extracted into its own recipe.
//
// Every time we put a Worker on <name>.coey.dev we run the SAME two checks by
// hand: health must be 200, and a gated route must be 401 without a token
// (proving the auth gate is fail-closed, not partial). deploy_coey_worker bakes
// this in as its step 6, but we also need it OUTSIDE a full deploy: a post-incident
// smoke test, a CI gate, "is prod still up + still gated?" — without re-running
// create/migrate/deploy. So it lives as its own pure planner.
//
// The two traps it encodes, both learned the hard way:
//   - a stale LOCAL DNS resolver makes plain `curl https://<name>.coey.dev` fail
//     "could not resolve host" even when the Worker is live. So every command
//     resolves the IP first (dig +short) and pins it with `curl --resolve`.
//   - "the route returns 200" is NOT enough. A gate that 200s an unauthenticated
//     request is broken. The gated-path check asserts 401 with NO token, which
//     is the actual fail-closed property guardrail cares about.
//
// Like the other recipes here, `code` is a PURE planner: given an input it
// returns the exact `curl --resolve` commands + expected codes. It runs no
// shell, makes no request, deploys nothing. The caller runs the printed
// commands in a real shell, eyes open.

import type { RecipeInput } from '../../src/recipe.ts';

// Pure planner. Reads ctx.input, returns { checks: [...] }. No I/O. The guard in
// run-recipe.ts permits it (no import/Function/eval/require/constructor).
const VERIFY_LIVE_WORKER_CODE = `
const input = (ctx && ctx.input) || {};
const subdomain = String(input.subdomain || 'my-worker');
const healthPath = String(input.healthPath || '/health');
const gatedPath = input.gatedPath != null ? String(input.gatedPath) : '';
const fqdn = subdomain + '.coey.dev';

// dig must run first: a stale local resolver makes plain curl fail to resolve a
// live Worker. --resolve pins the real edge IP and bypasses the bad cache.
const resolveStep = {
  n: 1,
  title: 'Resolve the real edge IP (defeats stale local DNS)',
  why: 'A stale local resolver makes plain curl "could not resolve host" even when the Worker is live. Capture the IP and pin it with --resolve on every check below.',
  command: 'IP=$(dig +short ' + fqdn + ' | head -1)',
  capture: 'IP',
};

const base = function (path, expect, note) {
  return {
    path: path,
    expect: expect,
    note: note,
    command:
      'curl -s -o /dev/null -w "%{http_code}" --resolve ' +
      fqdn + ':443:$IP https://' + fqdn + path + '   # expect ' + expect,
  };
};

const checks = [];
checks.push(base(healthPath, 200, 'Worker is up and serving the health route.'));
if (gatedPath) {
  checks.push(
    base(
      gatedPath,
      401,
      'Gate is FAIL-CLOSED: an unauthenticated request to the gated route must be rejected. A 200 here means the gate is broken (open or partial).',
    ),
  );
}

return {
  worker: fqdn,
  note: 'Verify-only plan. Runs nothing — print the commands and run them in a real shell. A 200 on the gated path is a FAILURE, not a pass.',
  resolve: resolveStep,
  checks: checks,
  expect: {
    health: 200,
    gatedWithoutToken: gatedPath ? 401 : 'n/a (no gatedPath given)',
  },
};
`.trim();

export const verifyLiveWorkerRecipe: RecipeInput = {
  name: 'verify_live_worker',
  description:
    'Plan the two standard live-Worker checks for a <name>.coey.dev domain: health path == 200, gated path == 401 without a token (fail-closed). Returns exact curl --resolve commands; runs nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      subdomain: {
        type: 'string',
        description: 'subdomain under coey.dev, e.g. "pantry" -> pantry.coey.dev',
      },
      healthPath: {
        type: 'string',
        description: 'unauthenticated health path expected to return 200. Default "/health".',
      },
      gatedPath: {
        type: 'string',
        description:
          'optional gated path expected to return 401 with no token (proves fail-closed). Omit to skip the gate check.',
      },
    },
    required: ['subdomain'],
  },
  code: VERIFY_LIVE_WORKER_CODE,
  // The plan's commands run a shell (dig, curl). The code is a pure planner, but
  // what it tells you to DO is machine.shell. Honest tag, same as deploy_coey_worker.
  capabilities: ['machine.shell'],
  status: 'enabled',
  sourceRunId: null,
};

// Push to the live pantry via the existing PantryClient (no reimplemented HTTP).
// Usage: PANTRY_URL=... PANTRY_TOKEN=... bun examples/recipes/verify-live-worker.ts
async function main(): Promise<void> {
  const { pantry } = await import('../../src/client.ts');
  if (!pantry.configured) {
    console.error('set PANTRY_URL and PANTRY_TOKEN to push verify_live_worker');
    process.exit(1);
  }
  const result = await pantry.push(verifyLiveWorkerRecipe);
  console.log(`pushed '${result.name}' as version ${result.version}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
