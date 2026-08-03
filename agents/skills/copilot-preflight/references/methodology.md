# Review-history methodology

Use historical metrics as directional evidence, not causal proof.

## Counting

- Count top-level inline findings separately from bot replies by excluding comments with `in_reply_to_id`.
- Count review events separately from inline findings; repeated reviews of one PR are not independent samples.
- Define whether “PRs reviewed” means any bot review event or at least one inline finding.
- Keep the observation window and collection date with every snapshot.

## Acceptance and rejection

Reply counts are not acceptance rates. A thread may have multiple replies, no explicit disposition, or a fix committed without a reply.

If classifying dispositions:

1. publish the labeling rules;
2. store per-finding labels so the result can be audited;
3. keep `fixed`, `rejected`, `already fixed`, `question`, and `unknown` distinct;
4. report unlabeled findings;
5. sample-check automated labels.

Do not present keyword heuristics as exact adoption rates.

## Categories

Category percentages require per-finding labels or a documented reproducible classifier. Categories may overlap; state whether totals are exclusive or multi-label.

Path distributions can demonstrate where findings occur, but they do not by themselves prove the semantic category or root cause.

## Causal claims

- Large diffs and repeated review rounds correlate with more opportunities for findings, but review rounds are also caused by prior findings.
- A cold reviewer may reduce implementation anchoring; this does not prove that less context is generally better.
- Custom instructions and repository review assets are context and may materially affect results.
- Claims that a preflight phase will remove a specific percentage require a prospective before/after evaluation.

## Structural interpretation

Repeated consistency findings often indicate synchronization debt: one contract is manually represented in many artifacts. Before adding another rule, consider reducing duplication, generating derived artifacts, or validating propagation in CI.
