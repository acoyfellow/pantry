// MCP server e2e: drive the four tools through the SDK client over an in-memory
// transport, against a PantryClient backed by a stub fetch. Hermetic: no
// network, no token.

import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PantryClient } from '../src/client.ts';
import { createPantryMcpServer } from '../src/mcp.ts';

const FULL = {
  name: 'slugify',
  description: 'slugify a title',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  capabilities: ['workspace.none'],
  code: 'export default (input) => ({ slug: String(input.title).toLowerCase().replace(/[^a-z0-9]+/g, "-") })',
  status: 'enabled',
  version: 1,
  visibility: 'private',
};

const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method ?? 'GET';
  if (url.endsWith('/recipes') && method === 'GET')
    return new Response(JSON.stringify({ recipes: [{ ...FULL, code: undefined }] }), {
      status: 200,
    });
  if (url.endsWith('/recipe/slugify') && method === 'GET')
    return new Response(JSON.stringify(FULL), { status: 200 });
  if (url.endsWith('/recipes') && method === 'POST')
    return new Response(JSON.stringify({ name: 'tmp', version: 1 }), { status: 201 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

async function connect() {
  const client = new PantryClient({ url: 'https://pantry.test', token: 't', fetch: stubFetch });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createPantryMcpServer({ client });
  await server.connect(serverT);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientT);
  return mcp;
}

const textOf = (res: unknown) => (res as { content: Array<{ text: string }> }).content[0].text;

test('exposes the four pantry tools', async () => {
  const mcp = await connect();
  const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(['pantry_get', 'pantry_list', 'pantry_push', 'pantry_run']);
});

test('pantry_list returns recipes without code', async () => {
  const mcp = await connect();
  const res = await mcp.callTool({ name: 'pantry_list', arguments: {} });
  expect(res.isError).toBeFalsy();
  const text = textOf(res);
  expect(text).toContain('slugify');
  expect(text).not.toContain('export default');
});

test('pantry_get returns the exact code', async () => {
  const mcp = await connect();
  const res = await mcp.callTool({ name: 'pantry_get', arguments: { name: 'slugify' } });
  expect(textOf(res)).toContain('export default');
});

test('pantry_run executes the recipe caller-side and returns the caveat', async () => {
  const mcp = await connect();
  const res = await mcp.callTool({
    name: 'pantry_run',
    arguments: { name: 'slugify', input: { title: 'Hello MCP World' } },
  });
  const text = textOf(res);
  expect(text).toContain('hello-mcp-world');
  expect(text).toContain('NOT a security sandbox');
});

test('pantry_push upserts and returns a version', async () => {
  const mcp = await connect();
  const res = await mcp.callTool({
    name: 'pantry_push',
    arguments: {
      recipe: {
        name: 'tmp',
        description: 'a temp recipe',
        inputSchema: { type: 'object', properties: {} },
        code: 'export default () => ({})',
        capabilities: ['workspace.none'],
      },
    },
  });
  expect(res.isError).toBeFalsy();
  expect(textOf(res)).toContain('version');
});
