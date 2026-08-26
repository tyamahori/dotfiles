---
name: structural-edit
description: Syntax-aware code search and codemods with ast-grep. Load before repeated structural rewrites, AST matching, or changes where text replacement could touch comments or strings. Routes OMP to ast_edit and Claude Code/Codex to ast-grep. Do not use for a symbol rename when language-server rename is available or for a single local edit.
---

# structural-edit

Use the narrowest tool that preserves program structure:

1. Symbol rename, references, imports, or type-aware refactor → language-server
   operation when available.
2. One known site with no repeated pattern → native edit tool.
3. Repeated syntax-shaped change or codemod → AST-aware workflow below.

AST matching is syntactic, not semantic. A pattern such as `oldApi($A)` can
match unrelated functions with the same spelling; use LSP for symbol identity.

## Pattern rules

- Metavariables match complete AST nodes: `$VALUE`, `$NAME`.
- `$$$ARGS` matches zero or more nodes. Use three dollar signs, never two.
- Metavariable names are uppercase. `$_` is an unbound single-node wildcard.
- Repeating a metavariable requires identical syntax: `$A == $A` does not
  match `left == right`.
- Patterns and rewrites must parse as one AST node. Wrap non-standalone syntax
  in its parent context, such as `class $_ { async $METHOD($$$ARGS) { $$$BODY } }`.
- Match the whole node being replaced. Deleting only a call expression from
  `console.log(value);` leaves the enclosing semicolon; delete the complete
  `console.log($$$ARGS);` expression statement instead.
- Captures substitute one-for-one. Do not design a rewrite that needs to split
  one capture into several nodes or merge unrelated captures.
- Quote CLI patterns with single quotes so the shell cannot expand `$NAME`.

If a pattern does not parse, inspect it with `--debug-query=ast` or add the
smallest valid parent wrapper. A parse error is a failed rewrite, not evidence
that the repository has no matches.

## OMP: `ast_edit`

OMP exposes ast-grep through the staged `xd://ast_edit` device. Write this JSON
to the device:

```json
{
  "ops": [
    {
      "pat": "console.log($$$ARGS);",
      "out": ""
    }
  ],
  "paths": ["src/**/*.ts"]
}
```

The result is only a proposal. Review every reported file and replacement,
then finalize exactly once:

- Apply: write a one-sentence reason to `xd://resolve`.
- Discard: write a one-sentence reason to `xd://reject`.

Do not edit affected files between proposal and resolution. For multiple
operations, put independent patterns in one proposal; run dependency-ordered
patterns in separate proposals so each pattern sees the prior AST.

## Claude Code and Codex: `ast-grep`

Use the canonical `ast-grep` binary, not an ad-hoc sed/perl replacement.
Always separate discovery, rewrite preview, and application.

### Discover matches

```bash
ast-grep run \
  --pattern 'console.log($$$ARGS);' \
  --lang ts \
  src
```

Scope paths and `--globs` as tightly as the task allows. Read unexpected
matches before proceeding; broaden only when the requested migration requires
it.

### Preview the rewrite

Supplying `--rewrite` without `--update-all` prints the proposed diff and does
not modify files:

```bash
ast-grep run \
  --pattern 'console.log($$$ARGS);' \
  --rewrite '' \
  --lang ts \
  src
```

The preview is the approval boundary. Check every affected path and reject a
pattern that reaches comments, strings, unrelated symbols, generated output,
or files outside scope.

### Apply the reviewed rewrite

Re-run the identical pattern, rewrite, language, paths, and globs with
`--update-all`:

```bash
ast-grep run \
  --pattern 'console.log($$$ARGS);' \
  --rewrite '' \
  --lang ts \
  --update-all \
  src
```

Use `--interactive` instead when a TTY is available and only selected matches
should change. Never add `--update-all` before a clean preview.

## Verification

After application:

1. Re-run the original search pattern. For a clean cutover, it must have no
   remaining in-scope matches; otherwise inspect and intentionally handle each
   remainder.
2. Run the repository formatter once if the rewrite changed formatting.
3. Run targeted language-server diagnostics, compilation, or the smallest
   behavioral check covering the changed contract.

Do not claim success from match counts alone. The AST guarantees syntactic
shape, not type correctness, symbol identity, or runtime behavior.
