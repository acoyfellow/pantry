# pantry evals

This is a small, reproducible harness for the cost-savings claim on recurring work.

It compares four real recurring recipes:

- `slugify` from `examples/sample-recipe.ts`
- `verify_live_worker` from `examples/recipes/verify-live-worker.ts`
- `deploy_coey_worker` from `examples/recipes/deploy-coey-worker.ts`
- `json_project_rename`, a deterministic JSON transform defined in the harness

For each task it records three techniques:

1. `prompt-from-scratch`: a model would re-derive the procedure each call.
2. `inline-tool-def-each-time`: the whole procedure is included in the prompt each call.
3. `pantry-reuse`: fetch a saved recipe and run it deterministically.

## What is measured

`pantry-reuse` executes the actual recipe code locally and records real wall-clock milliseconds and correctness. The saved code path uses 0 model reasoning tokens because no model is asked to re-derive the procedure.

## What is estimated

This harness does not call a live model API. That is intentional unless you wire one in later with usage accounting. Therefore:

- `prompt-from-scratch` token counts are estimates from the actual prompt plus the actual procedure text.
- `inline-tool-def-each-time` token counts are estimates from the actual prompt containing the procedure.
- `pantry-reuse` discovery tokens are estimates from the actual list-entry text: name, description, and input schema.

The estimator is deliberately simple and labeled: `ceil(characters / 4)`. It is not a model tokenizer and should be read as an approximate size comparison, not a benchmark.

## Reproduce

```sh
bun run evals
# or
bun evals/run.ts
```

The command writes `evals/results.json`.

## Limits

The results are about recurring tasks that already have saved recipes. Novel work still needs reasoning. Pantry also has a per-call discovery cost: the agent has to learn a recipe exists and decide it fits. Model versions, prompts, and real provider latency will change live results.
