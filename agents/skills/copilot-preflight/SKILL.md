---
name: copilot-preflight
description: Preflight-review code changes using repository evidence and accumulated GitHub Copilot review patterns. Use before requesting Copilot review, when reducing recurring PR findings, reviewing a local diff or pull request with a cold independent pass, checking cross-file contract drift, or analyzing historical Copilot review behavior in any GitHub repository.
---

# Copilot Preflight

Run a cold, evidence-first review before GitHub Copilot. Find cross-file drift, omitted paths, boundary failures, and executable-documentation defects without inheriting the implementer's explanation as proof.

Resolve `SKILL_DIR` as the directory containing this `SKILL.md` before reading bundled references or running bundled scripts. Never assume the repository working directory is the skill directory.

## Establish the target

1. Resolve the repository with `gh repo view --json nameWithOwner -q .nameWithOwner`.
2. Resolve the review surface:
   - PR: read `gh pr view --json number,baseRefName,headRefName,title,body,url` and the full diff.
   - Local work: inspect `git diff`, `git diff --cached`, and committed branch changes against the intended base.
   Read the full diff before any broader exploratory commands; scope follow-up searches to questions the diff raised.
3. Read current repository-owned instructions and specifications. Search for `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, contribution guides, task/spec documents, and review checklists. Treat these files as the current source of repository-specific rules; do not copy their contents into this skill.
4. If the repository has a large historical review archive, locate only sections relevant to the changed paths or symbols with `rg`.

## Review in priority order

### 1. Sweep changed contracts

List changed and removed identifiers, literals, defaults, limits, paths, commands, environment variables, response fields, documented counts, and old design terminology.

Search both old and new forms across code, schemas, tests, documentation, examples, workflows, runbooks, and the PR description. Pay special attention when the design changed during the PR: implementation often follows the new design while comments and documents retain the old one.

Determine which documents describe current behavior and which are historical records before editing or reporting drift.

### 2. Trace propagation and alternate paths

Follow each changed contract across producer, validation, persistence, public schema, consumer, tests, and documentation. Enumerate other entry points that reach the same side effect or state transition.

Choose applicable checks from [preflight-patterns.md](references/preflight-patterns.md). Do not run every checklist mechanically; select by diff risk.

### 3. Attack invariants and failure paths

Test zero, null, empty, boundary time, last item/page, repeated execution, concurrency, stale completion, partial failure, missing configuration, and another tenant or user's data where applicable. Check whether irreversible or costly side effects happen before success is known.

Prefer a reproducible scenario, test, or repository contradiction over a speculative warning. Label unproven concerns as questions.

### 4. Review executable artifacts

Treat PR descriptions, Markdown links, copied commands, examples, migrations, CI workflows, environment templates, and runbooks as executable or contractual artifacts.

Compare the PR body with the final diff. Verify links against Git-tracked files, commands by running safe read-only variants, and quality evidence against the latest test run.

### 5. Perform a final cold read

Re-read only the final diff, PR body, and applicable repository rules. Challenge claims such as “already handled,” “unchanged,” “out of scope,” and “same as before” with current evidence.

## Triage likely false positives

Before accepting or rejecting a finding, check:

1. **Snapshot freshness**: confirm the reviewed commit still matches HEAD.
2. **Explicit specification**: verify whether the behavior is intentionally allowed or excluded.
3. **Technical premise**: reproduce the claim or consult an authoritative source.
4. **Design reference**: compare intentional UI behavior with the actual reference artifact.
5. **Operational constraint**: verify permissions, deployment policy, or runtime limitations.

Respond to rejected findings with evidence and a verification command, not only “no action.”

## Report results

Order actionable findings by severity. For each include a tight file/line location, failing scenario, current evidence, and smallest safe correction.

Record each finding in the working notes or findings file as soon as it is confirmed, severity-tagged, so an interrupted review still yields usable output; do not defer all reporting to the end.

Separate:

- confirmed findings;
- questions requiring product or scope judgment;
- likely false positives;
- structural debt that should become follow-up work rather than block the PR.

End with areas checked, commands run, and remaining uncertainty. If no findings remain, say so directly.

When asked to fix findings, implement only confirmed items, rerun affected checks, and repeat the changed-contract sweep after every correction.

## Reduce recurring findings structurally

When the same drift recurs, do not only add another checklist item. Recommend reducing the synchronization surface: establish one executable source of truth, generate indexes or summaries, derive PR scope from the diff, and remove manually maintained counts or duplicated values where practical.

## Analyze review history

For repository-wide metrics, run:

```bash
python3 "$SKILL_DIR/scripts/analyze_copilot_history.py" --repo OWNER/REPO
```

Omit `--repo` inside a checkout to infer the current GitHub repository. Add `--with-reviews` to count review events; it performs one API read per PR. Read [methodology.md](references/methodology.md) before interpreting acceptance rates or category percentages.
