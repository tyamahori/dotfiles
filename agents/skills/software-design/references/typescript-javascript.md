# TypeScript and JavaScript

The norms above take this shape in TS/JS. Where a repository has no lint
config of its own, `scripts/lint-on-edit` and the pre-commit oxlint check
count the size limits from this dotfiles' `.oxlintrc.json` (complexity 10,
nesting depth 3, 60-line functions, 4 parameters, no `any`, no non-null
assertion, no `@ts-` suppression) and block only findings an edit adds.
Type discipline (discriminated unions closed by a `never` check, `satisfies`,
type guards that check what their name claims) and how to run and verify
TS/JS are in `efficient-ts-js`.

- **Functional core, imperative shell.** Decisions are pure functions over
  plain data (rows, snapshots, parsed input) that return a value or a
  description of what to do. A thin shell reads the database, files, clock,
  network, and UI, calls the core, and applies the result. The core is tested
  with literals; the shell gets one happy path.
- **A class only for state with rules, or a value with an invariant.** A
  class earns its place when it owns mutable state whose transitions follow a
  rule (a latch that fires once and re-arms below a threshold), or when its
  constructor enforces what must hold for a value. Stateless functions grouped
  together are a module, not a class; no hierarchy for one variant.
- **Types name the smallest capability.** A parameter's type lists only what
  the function uses (`{ notify(message: string, level?: string): void }`, not
  the host's whole context object). Share such a type across modules when a
  second module needs the same capability. Values typed `unknown` are parsed
  once at the boundary.
- **Over a limit: split by decision, not by line count.** Extract the pure
  decision first (guard clauses, a table for a long `if` chain). Never quiet
  the linter with a suppression comment, an options bag of unrelated values,
  or a `!` that hides a missing case.
