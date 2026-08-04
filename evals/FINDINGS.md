# Experiment: is recipe reuse better than regeneration?

Live runs through the Cloudflare gateway at `gateway.opencode.cloudflare.dev`, 5 trials per task, provider-reported token usage.

```sh
EVAL_MODEL=gpt-4.1-mini    EVAL_TRIALS=5 bun run evals:experiment
EVAL_MODEL=claude-opus-4-8 EVAL_TRIALS=5 bun run evals:experiment
bun evals/retrieval-filtered.ts
```

Correctness is scored by executing code against held-out cases the generator never sees. The same comparator scores every arm. The harness refuses to run if a saved reference implementation fails its own cases.

## Hypotheses

- **H1** Reuse means fewer tokens than generation.
- **H2** Retrieving saved code is more reliable than re-deriving it.
- **H3** Value compounds with reuse count.

## Result 1: a frontier model erases the correctness gap

| model | generation pass rate | mean tokens | distinct implementations |
|---|---|---|---|
| `gpt-4.1-mini` | 0.90 (27/30) | 233 | 28/30 |
| `claude-opus-4-8` | **1.00 (30/30)** | 337 | 21/30 |

`gpt-4.1-mini` failed `csv_parse_quoted` on 3 of 5 trials, each time returning `{"fields":[""]}` for the trivial `a,b,c` row. `claude-opus-4-8` never failed a task.

**H2 is model-dependent, and weakening over time.** On a weak model, saved code is meaningfully more reliable. On a frontier model, these tasks are simply solved. Any correctness argument for reuse must be made about work harder than a pure function, or about models cheap enough to still get it wrong.

The determinism finding survives: even at 30/30, `claude-opus-4-8` produced 21 distinct implementations for 6 specs. Behavior was correct, but the artifact was different nearly every time. Saved code is variance-zero by construction.

### A methodology note worth keeping

The first `claude-opus-4-8` run scored 0/5 on `semver_compare` and 0.833 overall. The cause was **the specification, not the model**: the test expected `v1.2 == 1.2.0` while the spec never said a leading `v` was allowed. After making the spec explicit, the same model scored 5/5.

An ambiguous spec reads as a model failure. This is the most common way an eval flatters or maligns the thing it measures, and it is why every failure here is inspected rather than tallied.

## Result 2: naive retrieval degrades badly as the catalog grows

Full catalog listed in the prompt, mean total tokens per lookup:

| catalog size | `gpt-4.1-mini` | `claude-opus-4-8` |
|---|---|---|
| 8 | 486 | 715 |
| 32 | 825 | 1308 |
| 128 | **2263** | **3440** |

Generating from scratch costs 233 and 337 respectively. At 128 recipes, listing the catalog to find one costs **roughly 10x more than just writing the code**. In an earlier `gpt-4.1-mini` run it also produced a false hit, answering `durable_object_census` for `kubernetes_pod_evictor`.

**H1 is false as stated.** Reuse is not automatically cheaper. Naive discovery is more expensive than regeneration and gets worse with scale.

## Result 3: filtered retrieval fixes it

Keyword search shortlist (top 5) against the same 128-recipe catalog:

| metric | full listing (n=128) | keyword shortlist |
|---|---|---|
| matched correct | 6/6 | 6/6 |
| false hits | 1/3 | **0/3** |
| mean total tokens | 2263 | **196** |

Shortlist recall was 6/6, so search never dropped the correct recipe. Tokens fall **11x**, below the cost of generating the code.

## Conclusion

Not a dud, but the naive framing is wrong on two counts.

- **Discovery must be filtered or the bet inverts.** Pantry's `?q=` and `?capability=` filters are not conveniences; they are the mechanism that makes reuse economical. Unfiltered, a growing catalog is a liability.
- **Correctness is the weaker argument, and it decays as models improve.** A frontier model solved every task. The durable claims are determinism, auditability, and the fact that a reviewed artifact is not re-gambled on each call.
- **H3 holds only with filtered discovery.** With it, retrieval cost is roughly flat in catalog size; without it, cost grows linearly and false hits appear.

The honest pitch is not "fewer tokens." It is *the same reviewed artifact every time, found cheaply*.

## Honest limits

- Two models, six short pure-function tasks, 5 trials. No statistical significance testing.
- Tasks are deterministic and side-effect free. Real recipes touching auth, network, or infrastructure are not represented, and those are exactly where reuse should matter most.
- Distractor entries are synthetic one-line descriptions. A catalog of genuinely similar recipes would make retrieval harder and false hits likelier.
- Keyword search is the caller-side implementation in `evals/retrieval-filtered.ts`, not yet Pantry's server-side `?q=` ranking.
- Latency and dollar cost are not measured, only tokens and correctness.
- `claude-opus-5` could not be measured: it returns `stop_reason: refusal` with empty content for these code-generation prompts through this gateway, at every phrasing and token budget tried. `claude-opus-4-8` is the strongest model that ran cleanly.
