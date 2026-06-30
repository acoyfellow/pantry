# Cross-Harness Dogfood, 2026-06-30

I used one local pantry recipe named `TitleCaseDemo` against `http://127.0.0.1:8787`.

Recipe fields visible before execution:

```json
{
  "name": "TitleCaseDemo",
  "description": "Title-case a short text string for cross-harness pantry dogfood.",
  "capabilities": ["text.transform"],
  "status": "enabled",
  "version": 1,
  "sourceRunId": "crossharness-dogfood-2026-06-30",
  "visibility": "shared",
  "author": "default"
}
```

The saved source returned by `get` was:

```js
const text = String(ctx.input.text ?? "");
return { title: text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()) };
```

## Pi pantry tool

Command, with `PANTRY_URL=http://127.0.0.1:8787` and the token read from `.dev.vars` but not printed:

```sh
pi -p --no-session -t pantry 'Use only the pantry tool. list shared recipes, get TitleCaseDemo, run TitleCaseDemo with input {"text":"hello from pi pantry"}. Return only the JSON outputs and do not include any token.'
```

Observed output from `run`:

```json
{
  "ok": true,
  "output": {
    "title": "Hello From Pi Pantry"
  },
  "capabilities": ["text.transform"]
}
```

The Pi path also returned the full recipe with `author`, `visibility`, `status`, `version`, `sourceRunId`, `createdAt`, `updatedAt`, and `code`.

## Plain client process

Command:

```sh
bun -e 'import {pantry} from "./src/client.ts"; const recipe=await pantry.get("TitleCaseDemo"); const ctx=Object.freeze({input:{text:"hello from plain client"}}); const fn=new Function("ctx",`"use strict";\n${recipe.code}`); const output=fn(ctx); console.log(JSON.stringify({recipe:{name:recipe.name,version:recipe.version,status:recipe.status,author:recipe.author,visibility:recipe.visibility,sourceRunId:recipe.sourceRunId},output},null,2));'
```

Observed output:

```json
{
  "recipe": {
    "name": "TitleCaseDemo",
    "version": 1,
    "status": "enabled",
    "author": "default",
    "visibility": "shared",
    "sourceRunId": "crossharness-dogfood-2026-06-30"
  },
  "output": {
    "title": "Hello From Plain Client"
  }
}
```

This was a separate Bun process using `src/client.ts`. It proves fetch and caller-owned execution outside pantry. It is not a security sandbox.

## my-ax path

I did not reach a live my-ax production recipe list in this build round. The code path exists in `my-ax/src/pantry-sync.ts`: enabled `saved_recipes` map to pantry `POST /recipes` bodies, preserve capabilities as tags, skip when `PANTRY_TOKEN` is unset, and fail soft on network or validation errors. The local proof above covers Pi and a plain client process; my-ax remains a reachability gap until an Access-authenticated/container-backed run can list or sync a real row without printing secrets.

## Clunky Bits

The project-local Pi extension conflicted with the global pantry extension when launched from the pantry repo. Running the Pi check from `/tmp` used the installed extension and avoided the duplicate tool registration.

The example runner ignores custom input today, so the plain-client proof used `src/client.ts` plus a small one-process evaluator instead of `examples/run-recipe.ts`.

## Fixes I Would Do Next

1. Add a first-class `examples/client-run.ts` that accepts JSON input and labels itself as caller-owned execution.
2. Make Pi extension loading de-duplicate identical pantry tool registrations.
3. Add a my-ax smoke command that lists enabled saved recipes or reports Access/container unreachability without exposing deployment identifiers.
