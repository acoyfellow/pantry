// Track C: @pantry/runtime types compile and describe the real runner contract.
import { expect, test } from 'bun:test';
import { checkRecipe, runRecipe } from '../examples/run-recipe.ts';
import type { FullRecipe } from '../src/recipe.ts';
import {
  HOST_NAMESPACES,
  type HarnessBindings,
  type RecipeCtx,
  type ShellInterface,
} from '../src/runtime.ts';

test('HOST_NAMESPACES matches the runner concept', () => {
  expect(HOST_NAMESPACES).toEqual(['machine', 'workspace', 'cloudbox']);
});

test('a typed ShellInterface binding satisfies the real runner (types + runtime agree)', async () => {
  const shell: ShellInterface = async ({ command }) => ({ stdout: `ran: ${command}\n` });
  const bindings: HarnessBindings = { 'machine.shell': shell };
  const recipe = {
    name: 't',
    description: '',
    inputSchema: {},
    capabilities: ['machine.shell'],
    code: `export default async () => (await machine.shell({ command: "ls" })).stdout.trim()`,
    status: 'enabled',
    visibility: 'private',
    version: 1,
    sourceRunId: null,
    owner: 't',
    createdAt: '',
    updatedAt: '',
  } as unknown as FullRecipe;
  expect(checkRecipe(recipe, bindings).ok).toBe(true);
  const ctx: RecipeCtx = { input: {}, bindings };
  const out = await (runRecipe(recipe, ctx as any).output as Promise<unknown>);
  expect(out).toBe('ran: ls');
});
