# Preflight pattern selection

Read only the sections matching the diff. Repository instructions override these generic heuristics.

## Cross-file contracts

- Search removed names and previous design terms, not only new identifiers.
- Compare public defaults, limits, paths, error codes, cookie names, field names, and documented counts.
- Check comments and docstrings against implementation order, return types, and branch conditions.
- Verify that filenames, frontmatter IDs, links, and referenced symbols exist and agree.
- Reconcile the PR title, body, affected areas, test evidence, and final diff.
- Distinguish current contract documents from historical decision records.

## Alternate paths and deletion

- Enumerate every entry point reaching the changed state or external cost.
- When adding a guard, find bypass routes to the same resource.
- When deleting or replacing behavior, search for orphaned exports, env vars, schemas, tests, comments, fallback paths, and operational docs.
- When moving logic, compare old and new inputs, branches, cleanup, and failure behavior one-to-one.

## UI and asynchronous state

- Avoid state updates during render.
- Reset state and refs when their context key changes.
- Abort or ignore stale asynchronous completions.
- Release timers, listeners, subscriptions, observers, and overlays during cleanup.
- Restore usable UI state on abort, stale, and error paths.
- Verify empty, last-item, pagination, responsive, keyboard, focus, contrast, and touch-target behavior when relevant.
- Run the framework's production build when static type checks cannot validate server/client boundaries.

## APIs and services

- Separate structural input validation from business-rule validation.
- Keep authentication, authorization, availability, not-found, and semantic-error precedence consistent with the repository contract.
- Scope reads and writes to the authorized tenant or owner at the query boundary where the architecture requires it.
- Distinguish missing configuration, dependency outage, invalid input, and internal failure.
- Avoid side effects or external cost behind safe-method semantics unless explicitly designed and protected.
- Check enumeration resistance across status, body, and timing when identities are sensitive.
- Apply rate, quota, and cost guards to every route reaching the same resource.

## Values and data integrity

- Distinguish zero, null, empty string, missing, and invalid.
- Avoid truthiness checks when zero-like values are valid.
- Validate numeric strings completely rather than accepting valid prefixes.
- Confirm fallback values preserve meaning and fail safely.
- Check uniqueness and state transitions under concurrent execution.
- Keep irreversible actions after sufficient validation and within the intended transaction boundary.

## Database and migrations

- Do not rewrite migrations already applied to shared environments.
- Test migrations with existing non-empty data, not only fresh databases.
- Look for destructive statements, missing extensions, hidden SQL constraints, backfill assumptions, and schema/migration drift.
- Verify nullable, default, uniqueness, timestamp, and foreign-key semantics across ORM schema and SQL.
- Make singleton queries deterministic or enforce uniqueness.

## Scripts, CI, and runbooks

- Preserve command exit status through pipelines and cleanup.
- Quote untrusted or variable values safely; reject unsafe argument combinations.
- Avoid shell examples where angle-bracket placeholders become redirections.
- Handle API pagination and exact matching.
- Validate workflow permissions, concurrency, fork behavior, user-input interpolation, and output encoding.
- Trace environment variables across local, build, test, deploy, and runtime stages.
- Keep generated outputs, credentials, cookies, headers, and local configuration out of tracked paths.

## Executable documentation

- Resolve relative links from the linking file and verify the target is Git-tracked.
- Run safe command examples or validate their syntax.
- Avoid manually maintained indexes, counts, and histories when they can be generated.
- Prefer references to an executable source of truth over duplicating internal values, while retaining public contract values needed by readers.
