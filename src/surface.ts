import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PantryClient } from './client.ts';

export const DEFAULT_URL = 'https://pantry.coey.dev';
export function tokenFile(): string {
  const home = process.env.TERRARIUM_HOME || homedir();
  return join(home, '.terrarium', 'pantry-token.secret');
}

export function loadToken(): string | undefined {
  const fromEnv = process.env.PANTRY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(tokenFile(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolvedUrl(): string {
  return (process.env.PANTRY_URL?.trim() || DEFAULT_URL).replace(/\/$/, '');
}

export function makeFetch(): typeof fetch {
  const pin = process.env.PANTRY_RESOLVE?.trim();
  if (!pin) return fetch;
  const [host, ip] = pin.split(':');
  if (!host || !ip) throw new Error(`PANTRY_RESOLVE must be "host:ip" (got "${pin}")`);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const original = new URL(typeof input === 'string' ? input : input.toString());
    if (original.hostname !== host) return fetch(input, init);
    const pinned = new URL(original);
    pinned.hostname = ip;
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    headers.set('host', host);
    return fetch(pinned, { ...init, headers, tls: { serverName: host } } as RequestInit);
  }) as typeof fetch;
}

export function describeError(err: unknown, url: string): string {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (
    !/ConnectionRefused|connection refused|unable to connect|failed to fetch|ENOTFOUND|EAI_AGAIN/i.test(
      `${code} ${message}`,
    )
  )
    return message;
  return [
    `Could not reach pantry at ${url} (${code || 'connect failure'}).`,
    '',
    'A stale local DNS resolver can make plain fetch fail even when pantry is live.',
    'Workarounds:',
    '  PANTRY_RESOLVE="pantry.coey.dev:<ip>" with a fresh IP from dig +short pantry.coey.dev A',
    '  PANTRY_URL="https://<reachable-host-or-ip>"',
  ].join('\n');
}

export function makeClient(fetchImpl = makeFetch()): { client: PantryClient; url: string } {
  const url = resolvedUrl();
  const token = loadToken();
  if (!token)
    throw new Error(
      `PANTRY_TOKEN is not set and ${tokenFile()} is empty/unreadable. Set PANTRY_TOKEN or write the token file. The token is never printed.`,
    );
  return { client: new PantryClient({ url, token, fetch: fetchImpl }), url };
}

export const RUN_CAVEAT =
  "pantry run is NOT a security sandbox; running fetched code is the caller's decision and risk. Untrusted recipes need a real isolate.";
