// pantry — a Pi custom tool that lets a Pi/terrarium session reuse pantry
// recipes without curl. It is a thin shell over the EXISTING pantry client
// (src/client.ts, PantryClient) and the EXISTING demo runner
// (examples/run-recipe.ts, runRecipe). It does NOT reimplement the HTTP, and it
// does NOT add a security boundary.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ RUNNING A FETCHED RECIPE IS NOT SANDBOXED. `pantry run` executes recipe     │
// │ code over an explicit, restricted `ctx` using the demo runner's bounded     │
// │ posture (shadowed ambient names + a best-effort parse-time tripwire). That  │
// │ is a CONVENIENCE for code you already trust, NOT containment: `import()`,   │
// │ the Function-constructor climb, and string-built names all escape it.       │
// │ Deciding to run a recipe is the CALLER'S decision and the caller's risk.    │
// │ Untrusted recipes need a real isolate (a Worker Loader, a separate Worker,  │
// │ a child process, or a vetted JS sandbox) — this tool does not provide one.  │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Config (read at call time, never printed):
//   PANTRY_URL     default https://pantry.coey.dev. Override to point at a
//                  reachable host/IP when local DNS is stale (see below).
//   PANTRY_TOKEN   from env, else read from the secret file
//                  ~/.terrarium/pantry-token.secret. Never logged or returned.
//   PANTRY_RESOLVE optional "host:ip" pin (curl --resolve style). When set, the
//                  tool fetches the IP with the real Host header + TLS SNI so a
//                  stale local resolver cannot break a live pantry. This is the
//                  in-process equivalent of `curl --resolve host:443:ip`.
//
// KNOWN ISSUE (handled honestly here): a stale local DNS resolver can make
// plain `fetch("https://pantry.coey.dev/...")` throw ConnectionRefused even
// though pantry is live (curl reproduces it; `curl --resolve` fixes it). This
// tool does NOT silently auto-resolve; it surfaces a clear error naming the
// stale-DNS possibility and the two documented workarounds, and supports
// PANTRY_RESOLVE / PANTRY_URL overrides so the caller can recover deliberately.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

// Reuse the existing client + runner from the pantry repo. This extension lives
// at <repo>/.pi/extensions/pantry/index.ts, so the repo root is three dirs up.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Imported lazily inside execute() so a load-time import failure never breaks
// the whole extension runtime; surfaced as a tool error instead.
type ClientModule = typeof import('../../../src/client.ts');
type RunnerModule = typeof import('../../../examples/run-recipe.ts');

const DEFAULT_URL = 'https://pantry.coey.dev';
const TOKEN_FILE = join(homedir(), '.terrarium', 'pantry-token.secret');

function loadToken(): string | undefined {
  const fromEnv = process.env.PANTRY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(TOKEN_FILE, 'utf8').trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}

function resolvedUrl(): string {
  return (process.env.PANTRY_URL?.trim() || DEFAULT_URL).replace(/\/$/, '');
}

// Build a fetch that honours a `host:ip` pin (PANTRY_RESOLVE), the in-process
// twin of `curl --resolve host:443:ip`: it rewrites the request URL to the IP
// while keeping the real Host header and TLS server name. This is the documented
// escape hatch for the stale-DNS ConnectionRefused case. When PANTRY_RESOLVE is
// unset, the plain global fetch is used unchanged.
function makeFetch(): typeof fetch {
  const pin = process.env.PANTRY_RESOLVE?.trim();
  if (!pin) return fetch;
  const [host, ip] = pin.split(':');
  if (!host || !ip) {
    throw new Error(`PANTRY_RESOLVE must be "host:ip" (got "${pin}")`);
  }
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const original = new URL(typeof input === 'string' ? input : input.toString());
    if (original.hostname !== host) {
      // Pin only applies to the named host; pass everything else through.
      return fetch(input, init);
    }
    const pinned = new URL(original);
    pinned.hostname = ip;
    const headers = new Headers(init?.headers);
    headers.set('host', host);
    // Bun honours `tls.serverName`; on platforms that ignore it the Host header
    // still routes correctly through Cloudflare's edge.
    const extended = { ...init, headers, tls: { serverName: host } } as RequestInit;
    return fetch(pinned, extended);
  }) as typeof fetch;
}

// Turn a raw transport failure into an actionable message. The stale-DNS case
// throws a ConnectionRefused-style error even though pantry is live; name it
// explicitly and point at both documented workarounds.
function describeError(err: unknown, url: string): string {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  const looksLikeDns =
    code === 'ConnectionRefused' ||
    /connection refused|unable to connect|failed to fetch|ENOTFOUND|EAI_AGAIN/i.test(message);
  if (!looksLikeDns) return message;
  return [
    `Could not reach pantry at ${url} (${code || 'connect failure'}).`,
    '',
    'KNOWN ISSUE: a stale local DNS resolver can make plain fetch throw',
    'ConnectionRefused for pantry.coey.dev even when pantry is LIVE (curl',
    'reproduces it; `curl --resolve` fixes it). pantry has not necessarily',
    'gone down.',
    '',
    'Documented workarounds (pick one, then re-run):',
    '  1. PANTRY_RESOLVE="pantry.coey.dev:104.21.69.22" — pins the host to a',
    '     resolved IP with the real Host header + TLS SNI, the in-process twin',
    '     of: curl --resolve pantry.coey.dev:443:104.21.69.22 ...',
    '     (get a fresh IP with: dig +short pantry.coey.dev A)',
    '  2. PANTRY_URL="https://<reachable-host-or-ip>" — point at any host you',
    '     can actually reach.',
  ].join('\n');
}

async function makeClient(): Promise<{
  client: InstanceType<ClientModule['PantryClient']>;
  url: string;
}> {
  const url = resolvedUrl();
  const token = loadToken();
  if (!token) {
    throw new Error(
      `PANTRY_TOKEN is not set and ${TOKEN_FILE} is empty/unreadable. Set PANTRY_TOKEN or write the token file. (The token is never printed.)`,
    );
  }
  const { PantryClient } = (await import(join(REPO_ROOT, 'src', 'client.ts'))) as ClientModule;
  const client = new PantryClient({ url, token, fetch: makeFetch() });
  return { client, url };
}

const PARAMS = Type.Object({
  action: StringEnum(['list', 'get', 'run', 'push'] as const),
  name: Type.Optional(Type.String({ description: 'Recipe name. Required for get and run.' })),
  input: Type.Optional(
    Type.Unknown({
      description: 'Input object passed to the recipe as ctx.input. Used by run.',
    }),
  ),
  scope: Type.Optional(
    StringEnum(['owner', 'shared'] as const, {
      description: "list only: 'owner' (default) or 'shared' shared read pool.",
    }),
  ),
  shared: Type.Optional(
    Type.Boolean({ description: 'push only: set recipe.visibility to shared.' }),
  ),
  recipe: Type.Optional(
    Type.Unknown({
      description:
        'Full recipe object to upsert: { name, description, inputSchema, code, capabilities[], visibility?, status?, sourceRunId? }. Used by push.',
    }),
  ),
  guard: Type.Optional(
    Type.Boolean({
      description:
        'run only: apply the best-effort parse-time tripwire before executing (default true). It is NOT a sandbox.',
    }),
  ),
});

export type PantryToolInput = {
  action: 'list' | 'get' | 'run' | 'push';
  name?: string;
  input?: unknown;
  scope?: 'owner' | 'shared';
  shared?: boolean;
  recipe?: unknown;
  guard?: boolean;
};

export default function pantryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pantry',
    label: 'Pantry',
    description: [
      'Reuse pantry recipes (a capability-scoped recipe store) without curl.',
      'Backed by the repo PantryClient; pantry stores and hands back scripts, it never runs them.',
      '',
      'Actions:',
      '- list: recipe names + descriptions + inputSchema + capabilities (NO code). Cheap discovery. Pass scope="shared" for shared recipes with author provenance.',
      '- get(name): the full recipe INCLUDING code + capabilities. Read before you run.',
      '- run(name, input): fetch the recipe then execute its code over an explicit restricted ctx.',
      "  THIS IS NOT A SECURITY SANDBOX. Running fetched code is the caller's decision and risk;",
      '  the runner shadows ambient names and runs a best-effort tripwire, but import()/the',
      '  Function-constructor climb/string-built names all escape it. Untrusted recipes need a',
      '  real isolate (Worker Loader, separate Worker, child process, vetted sandbox).',
      '- push(recipe): upsert a recipe ({name,description,inputSchema,code,capabilities[],visibility?}). Pass shared=true to publish your own recipe to the shared read pool.',
      '',
      'Config: PANTRY_URL (default https://pantry.coey.dev), PANTRY_TOKEN (env or',
      '~/.terrarium/pantry-token.secret; never printed). Stale local DNS can make plain fetch throw',
      'ConnectionRefused even when pantry is live; on that failure the tool returns the stale-DNS',
      'workarounds (PANTRY_RESOLVE="host:ip" — like curl --resolve — or a PANTRY_URL override).',
    ].join('\n'),
    promptSnippet:
      'Reuse pantry recipes: list/get/run/push (run executes fetched code, not sandboxed)',
    promptGuidelines: [
      'Use the pantry tool to list/get a saved recipe before re-reasoning a recurring pattern from scratch.',
      'Before calling pantry run, get the recipe and read its code and capabilities; pantry run is not a security sandbox.',
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params) {
      const { action } = params as PantryToolInput;

      if (action === 'list') {
        const { client, url } = await makeClient();
        try {
          const scope = (params as PantryToolInput).scope === 'shared' ? 'shared' : undefined;
          const recipes = await client.list(scope ? { scope } : undefined);
          return {
            content: [
              {
                type: 'text',
                text:
                  recipes.length === 0
                    ? 'No recipes (or client unconfigured).'
                    : JSON.stringify(recipes, null, 2),
              },
            ],
            details: { action, url, count: recipes.length },
          };
        } catch (err) {
          throw new Error(describeError(err, url));
        }
      }

      if (action === 'get') {
        const name = (params as PantryToolInput).name?.trim();
        if (!name) throw new Error('pantry get requires `name`');
        const { client, url } = await makeClient();
        try {
          const recipe = await client.get(name);
          if (!recipe) {
            return {
              content: [{ type: 'text', text: `Recipe '${name}' not found.` }],
              details: { action, url, found: false },
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(recipe, null, 2) }],
            details: { action, url, name: recipe.name, version: recipe.version },
          };
        } catch (err) {
          throw new Error(describeError(err, url));
        }
      }

      if (action === 'run') {
        const name = (params as PantryToolInput).name?.trim();
        if (!name) throw new Error('pantry run requires `name`');
        const input = (params as PantryToolInput).input;
        const guard = (params as PantryToolInput).guard !== false;
        const { client, url } = await makeClient();
        let recipe: Awaited<ReturnType<InstanceType<ClientModule['PantryClient']>['get']>>;
        try {
          recipe = await client.get(name);
        } catch (err) {
          throw new Error(describeError(err, url));
        }
        if (!recipe) throw new Error(`Recipe '${name}' not found; cannot run.`);
        const { runRecipe } = (await import(
          join(REPO_ROOT, 'examples', 'run-recipe.ts')
        )) as RunnerModule;
        // Explicit, restricted ctx. NOT a trust boundary — see the file header.
        const result = runRecipe(recipe, { input }, { guard });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: {
            action,
            url,
            name: recipe.name,
            version: recipe.version,
            ok: result.ok,
            rejectedByGuard: result.rejectedByGuard ?? false,
            note: "pantry run is NOT a sandbox; running fetched code was the caller's decision.",
          },
        };
      }

      if (action === 'push') {
        const recipe = (params as PantryToolInput).recipe;
        if (!recipe || typeof recipe !== 'object') {
          throw new Error('pantry push requires a `recipe` object');
        }
        const { client, url } = await makeClient();
        try {
          const pushed = { ...(recipe as Record<string, unknown>) };
          if ((params as PantryToolInput).shared) pushed.visibility = 'shared';
          const saved = await client.push(pushed as Parameters<typeof client.push>[0]);
          return {
            content: [
              {
                type: 'text',
                text: `Pushed '${saved.name}' v${saved.version} to ${url}.`,
              },
            ],
            details: { action, url, name: saved.name, version: saved.version },
          };
        } catch (err) {
          throw new Error(describeError(err, url));
        }
      }

      throw new Error(`unknown pantry action: ${String(action)}`);
    },
  });
}
