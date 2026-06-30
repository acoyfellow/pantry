# pantry evals

This is a small, reproducible harness for the structural pantry claim on recurring work.

The claim is not that not-writing code is a fair contest against writing code. The claim is that a model may re-derive a recurring procedure every time and may be wrong; pantry hands back exact saved code and improves determinism. Discovery still costs tokens. Novel work still needs reasoning, and total-token savings are not broadly demonstrated.

It compares four real recurring recipes:

- `slugify` from `examples/sample-recipe.ts`
- `verify_live_worker` from `examples/recipes/verify-live-worker.ts`
- `deploy_coey_worker` from `examples/recipes/deploy-coey-worker.ts`
- `json_project_rename`, a deterministic JSON transform defined in the harness

For each task it records three techniques:

1. `prompt-from-scratch`: ask a model to produce the JSON result from the task description.
2. `inline-tool-def-each-time`: include the full procedure in the prompt and ask for the JSON result.
3. `pantry-reuse`: run the saved recipe deterministically.

## Default mode

```sh
bun run evals
```

Default mode is cheap and deterministic. It does not call a model. Prompt payloads and pantry discovery payloads are counted with `gpt-tokenizer` and labeled as tokenizer estimates. Pantry recipe execution time and correctness are measured locally. Prompt-from-scratch and inline correctness stay `not-measured-without-live-model`.

## Live mode

```sh
LIVE_MODEL=1 bun run evals
```

Live mode tries a real small model for the prompt-from-scratch and inline-tool-def arms, captures provider-reported input and output tokens, stores only compact output previews plus hashes, and scores all three arms against the same deterministic oracle.

Provider order is intentionally conservative:

1. `OPENAI_API_KEY`, default model `gpt-4o-mini`, override with `OPENAI_MODEL`
2. `ANTHROPIC_API_KEY`, default model `claude-3-haiku-20240307`, override with `ANTHROPIC_MODEL`

If no provider is reachable, the harness does not fabricate a live result. It writes honest-estimate mode with an explicit note.

## Output

The command writes compact `evals/results.json`: summary totals plus rows, not full model completions.

## Limits

This applies to recurring tasks that already have saved recipes. Pantry still has discovery cost: the agent has to learn a recipe exists and decide it fits. Local deterministic wall-clock is not network latency. Model versions, prompts, and provider usage accounting will change live results.
