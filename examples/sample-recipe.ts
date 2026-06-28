// A real sample recipe: a deterministic text transform (slugify).
//
// The `code` field is a function body. It receives the bounded `ctx` from the
// runner and returns a plain value. It touches no network, no credentials, no
// environment. It is exactly the kind of recurring pattern pantry exists for:
// instead of re-deriving "how do I slugify a title" each time, an agent fetches
// this recipe and runs it.

import type { RecipeInput } from '../src/recipe.ts';

// The script a caller fetches and runs in its own sandbox.
const SLUGIFY_CODE = `
const text = String((ctx.input && ctx.input.text) || '');
const slug = text
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);
return { slug };
`.trim();

export const sampleRecipe: RecipeInput = {
  name: 'slugify',
  description: 'Turn arbitrary text into a URL-safe slug. Deterministic, no I/O.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 500 } },
    required: ['text'],
  },
  code: SLUGIFY_CODE,
  capabilities: ['text.transform'],
  status: 'enabled',
  sourceRunId: null,
};

// Push the sample recipe to pantry.
// Usage: PANTRY_URL=... PANTRY_TOKEN=... bun examples/sample-recipe.ts
async function main(): Promise<void> {
  const { pantry } = await import('../src/client.ts');
  if (!pantry.configured) {
    console.error('set PANTRY_URL and PANTRY_TOKEN to push the sample recipe');
    process.exit(1);
  }
  const result = await pantry.push(sampleRecipe);
  console.log(`pushed '${result.name}' as version ${result.version}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
