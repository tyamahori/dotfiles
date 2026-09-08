---
name: efficient-ts-js
description: >
  Load before writing or running generated JavaScript/TypeScript scripts or JS
  Eval cells. Runtime and dependency selection, native APIs, and minimal
  verification for one-offs and reusable helpers.
---

# efficient-ts-js

Goal: correct generated scripts with fewer setup steps, failed invocations, and
context re-reads. Savings are a goal, not a measured result. Harness tool and
permission rules take precedence over the recipes below.

## Choose the execution path once

| Situation | Use |
| --- | --- |
| Read/search files, extract a JSON field, inspect a web page | Dedicated harness tools; `jq` for JSON, read/ax for pages. Do not write a parser first. |
| Existing project | Its runtime, package manager, lockfile and script commands. Do not replace Node with Bun or add a second lockfile. |
| Ad-hoc work in an active JS Eval kernel | Reuse its imports and results; rerun only the failed cell. Follow the harness's language routing. |
| Small standalone JS expression outside Eval | `bun --no-install -e 'console.log(JSON.stringify({ok: true}))'` |
| Standalone JS/TS file on this machine | `bun run --no-install ./script.ts` (or `.js`); Bun is owned by `scripts/devbox`. |
| Script that must run on Node | Use the target Node version and project module mode; `.mjs` makes standalone ESM explicit. |

Use JS when types add nothing; use TS for reusable structured transformations.
Do not scaffold a package, tsconfig, build step or test framework for a
stdlib-only one-off. Put scratch files under the repository's
`.agent-msgs/scratch/`; keep a file only when it is a requested deliverable.
Multiline or quote-heavy code belongs in Eval or a file, not nested shell
quotes. Pass data through argv, stdin or env; never interpolate it into code.

Bun may auto-install unresolved imports when no node_modules is present.
`--no-install` disables that behavior; it is not a network sandbox. Reuse
installed dependencies. If a dependency is genuinely needed, use the project's
manager and lockfile, or an explicitly approved isolated scratch package.
Do not retry a missing import through unpinned `npx`/`bunx`, global installs,
or version-tag imports that silently fetch packages.

## Native APIs, explicit failure

These APIs are for programs being built, not substitutes for harness tools.

- Files/paths: `node:fs/promises`, `node:path`, and `new URL(..., import.meta.url)`
  for module-relative resources. Do not assume cwd equals the script directory.
- Data: `JSON.parse`, `Map`, `Set` and array methods before a utility dependency.
  Treat external JSON as `unknown` in TS; validate its needed shape before
  effects. `as SomeType` does not validate data. Reuse an existing schema library
  when the project has one; do not build a general validator for one payload.
- HTTP in a real script: native `fetch`, a finite `AbortSignal.timeout(...)`,
  `response.ok`, then payload validation. HTTP errors do not reject fetch.
- Subprocesses: argv-based `execFileSync` for short bounded calls, or the
  runtime's spawn API for streaming. Avoid a shell; handle launch errors and
  nonzero exit codes. Bound captured output at the source when it can be large.
- Async work: await it. Never use `forEach(async ...)`; run dependent operations
  sequentially and use `Promise.all` only for a small bounded independent set.
- Writes: validate before overwriting data; reuse atomic replacement when loss
  matters. Never catch an error and return fake success. For a CLI error,
  report a concise diagnostic to stderr and set `process.exitCode = 1`.

## Verify the behavior, not just execution

Bun executes TS without type checking. Node's native TS support also strips
rather than checks types, ignores tsconfig path mappings, and does not support
all TS syntax. Follow the project's runner instead of adding loaders or
changing module modes to silence an error. Use `import type` for type-only imports.

1. Use the existing lint/typecheck/test commands for a project. Do not invoke
   `tsc file.ts` expecting it to use the project's tsconfig.
2. For a standalone file, use installed `oxlint --format=unix ./script.ts`
   and resolve relevant findings. Dotfiles already runs oxlint through
   `scripts/lint-on-edit`; do not repeat a successful unchanged-file check.
   Lint is not type checking; state when only lint and runtime were checked.
3. Exercise the real entry point on a small fixture. Assert the useful result
   and one plausible failure (malformed input, nonzero child exit, or an async
   boundary). Keep a regression test only for behavior worth maintaining;
   reuse the existing runner, or `node:assert/strict` for a scratch check.
   Do not install TypeScript or a test framework merely to bless a throwaway.
4. Print one compact structured result, not an entire dataset or secret-bearing
   environment. Keep bulky evidence in scratch files. After a failure, use the
   error to change the failing step; do not restart the whole workflow or retry
   the same invocation unchanged. Remove scratch artifacts after verification.

## Runtime references

Consult only when the runtime changes or an invocation fails:
[Bun auto-install](https://bun.sh/docs/runtime/auto-install),
[Node TypeScript support](https://nodejs.org/api/typescript.html).
