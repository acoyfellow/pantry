# Security

## The Core Boundary

pantry stores and hands back a script. It never executes a recipe. The `code` field is returned verbatim from D1.

Running a fetched recipe is the caller's decision and the caller's risk. If you do not already trust a recipe's author, run the recipe in a real isolate: a Cloudflare Worker Loader, a separate Worker, a child process, or a vetted JS sandbox. Real isolation is the caller's job. pantry does not do it.

`examples/run-recipe.ts` is a demo runner, not a trust boundary. It shadows a few ambient names and runs a best-effort token scan. Both are tripwires that hostile code can defeat, as the file header documents. A passing scan proves nothing about safety. Do not treat that runner as a sandbox.

## What The Server Enforces

- Bearer-token gate, fail-closed. No `PANTRY_TOKEN` configured returns `503`. Wrong or missing token returns `401`. The compare is constant-time.
- Owner scoping. A token maps to one owner. Every query filters by owner.
- CORS echoes the request origin and never pairs the wildcard with credentials. Preflight is answered before the auth gate.
- `PANTRY_TOKEN` is a wrangler/alchemy secret. It is never hardcoded and never shipped to a client.

## Reporting A Vulnerability

This is a `0.0.1` experiment and is not a production service. If you find a security issue, open an issue describing the problem and how to reproduce it, or contact the author at https://coey.dev. Please do not include working exploit payloads against any live deployment in a public issue.

## Supported Versions

Only the current `main` is supported. There are no backported fixes.
