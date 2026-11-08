# ADRs

**Placement: match the repository first.** Look for existing ADRs,
`.adr-dir`, `docs/adr/`, `docs/decisions/`, or ADR tooling, and continue
that directory, numbering, extension, and heading set. Only with no
convention use `docs/adr/NNNN-kebab-title.md`, starting at `0001`. Never
restart numbering or add a second scheme; if the evidence conflicts, ask.

Template (one page, in the repository's document language; Japanese ADRs go
through `natural-japanese`):

```markdown
# NNNN. <Decision stated as a sentence>

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
The forces: requirement, constraint, measurement, deadline. Facts, not
opinions.

## Decision
What we will do, in one paragraph.

## Alternatives
One paragraph each: what it was and the specific reason it lost.

## Consequences
What becomes easier, what becomes harder, what we now have to do
(migration, monitoring, follow-up).
```

Never delete or rewrite an accepted ADR; supersede it with a new one that
links back. Link the ADR from the code or doc it governs when the decision
is not obvious from the code.
