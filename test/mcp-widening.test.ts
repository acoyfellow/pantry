// Track B: the real MCP pantry_run pre-flights host interfaces and refuses
// honestly for recipes this server can't satisfy (no host bindings), while
// pure recipes still run. Uses checkRecipe directly against the runner contract.
import { expect, test } from 'bun:test';
import { checkRecipe } from '../examples/run-recipe.ts';
import type { FullRecipe } from '../src/recipe.ts';
const mk = (caps: string[]): FullRecipe =>
  ({
    name: 't',
    description: '',
    inputSchema: {},
    code: 'export default async () => (await machine.shell({command:"ls"})).stdout',
    capabilities: caps,
    status: 'enabled',
    visibility: 'private',
    version: 1,
    sourceRunId: null,
    owner: 't',
    createdAt: '',
    updatedAt: '',
  }) as unknown as FullRecipe;

test('a machine.shell recipe is refused by a harness with no bindings', () => {
  const c = checkRecipe(mk(['machine.shell']), {});
  expect(c.ok).toBe(false);
  expect(c.missing).toContain('machine.shell');
});
test('a pure recipe (workspace.none) passes pre-flight with no bindings', () => {
  const c = checkRecipe(mk(['workspace.none']), {});
  expect(c.ok).toBe(true);
});
