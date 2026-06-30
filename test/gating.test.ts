import { expect, test } from 'bun:test';
import { validateRecipeInput } from '../src/recipe.ts';

test('recipe status accepts pending for owner-gated writes', () => {
  const parsed = validateRecipeInput({
    name: 'PendingRecipe',
    description: 'Pending recipe for owner approval.',
    inputSchema: { type: 'object', properties: {} },
    code: 'return ctx.input;',
    capabilities: ['text.transform'],
    status: 'pending',
  });
  expect(parsed.status).toBe('pending');
});
