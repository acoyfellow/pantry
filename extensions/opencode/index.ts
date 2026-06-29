import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { runRecipe } from '../../examples/run-recipe.ts';
import { RUN_CAVEAT, describeError, makeClient } from '../../src/surface.ts';

export const PantryPlugin: Plugin = async () => ({
  tool: {
    pantry: tool({
      description: [
        'Reuse pantry recipes: list/get/run/push.',
        'Backed by PantryClient; pantry stores and hands back scripts, it never runs them.',
        RUN_CAVEAT,
        'Config: PANTRY_URL default https://pantry.coey.dev, PANTRY_TOKEN env or ~/.terrarium/pantry-token.secret, PANTRY_RESOLVE host:ip for stale DNS.',
      ].join('\n'),
      args: {
        action: tool.schema
          .enum(['list', 'get', 'run', 'push'])
          .describe('list, get, run, or push'),
        name: tool.schema.string().optional().describe('Recipe name for get and run'),
        input: tool.schema.any().optional().describe('Input object passed to ctx.input for run'),
        recipe: tool.schema.any().optional().describe('Recipe object for push'),
        guard: tool.schema
          .boolean()
          .optional()
          .describe('run only: apply best-effort tripwire, default true. Not a sandbox.'),
      },
      async execute(args) {
        const { client, url } = makeClient();
        try {
          if (args.action === 'list') return JSON.stringify(await client.list(), null, 2);
          if (args.action === 'get') {
            if (!args.name) throw new Error('pantry get requires name');
            const recipe = await client.get(args.name);
            return recipe ? JSON.stringify(recipe, null, 2) : `Recipe '${args.name}' not found.`;
          }
          if (args.action === 'run') {
            if (!args.name) throw new Error('pantry run requires name');
            const recipe = await client.get(args.name);
            if (!recipe) throw new Error(`Recipe '${args.name}' not found; cannot run.`);
            return JSON.stringify(
              {
                caveat: RUN_CAVEAT,
                result: runRecipe(recipe, { input: args.input }, { guard: args.guard !== false }),
              },
              null,
              2,
            );
          }
          if (args.action === 'push') {
            if (!args.recipe || typeof args.recipe !== 'object')
              throw new Error('pantry push requires recipe object');
            const saved = await client.push(args.recipe as Parameters<typeof client.push>[0]);
            return JSON.stringify({ saved, url }, null, 2);
          }
          throw new Error(`unknown pantry action: ${String(args.action)}`);
        } catch (err) {
          throw new Error(describeError(err, url));
        }
      },
    }),
  },
});

export default PantryPlugin;
