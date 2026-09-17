# Measured notes

Evidence behind the "measured" rules in `global-instructions.md`. This file
is not loaded by any agent; the incidents live here so the always-loaded
instructions stay small.

Every entry below must end with a `Mechanized:` line: either the check/hook
that enforces it, or a one-sentence reason it resists mechanization (a
judgment call, a one-time decision, no structural signal to key on). Add it
when you add the entry — no separate audit pass.

## Commits and PRs — branch from an up-to-date base

2026-08-24: two sessions needed `rebase --onto` and a force-push after a
branch cut from an unmerged branch dragged in 17 unrelated commits.

Mechanized: git/global-hooks/checks/pre-push-base-freshness (wired via git/global-hooks/dispatch, 2026-09-17).

## Root-cause claims need reproduction

2026-08-24: two investigations blamed an external API's plan and an
"invalid" API key; the user's own curl probe disproved both.

Mechanized: no — epistemic judgment call; no structural signal distinguishes a grounded root-cause claim from a guess.

## Fail fast on repeated identical failures

2026-08-23: one session repeated an identity-mismatch sweep 15 times, and
three sessions burned ~20 identical no-op turns on blocked delivery, with
the correct diagnosis already made on the first attempt.

Mechanized: scripts/fail-fast-hook (Claude Code PostToolUse/PostToolUseFailure Bash matcher, Codex PostToolUse Bash matcher).

## Session hygiene — quota goes to context re-reads

2026-08-16: one resumed session consumed 64% of a week's Anthropic quota,
half of it compaction churn.

Mechanized: partially — scripts/session-hygiene-hook's resume case catches the costliest re-read pattern (idle >1h, transcript >5MB); overall quota burn is tracked, not blocked, via scripts/agent-usage-weekly.

## Session hygiene — don't resume a large idle context

2026-08-19: a 2h17m same-day resume rewrote 239k cache tokens, then
reprocessed 3.07M context tokens over 10 turns.

Mechanized: scripts/session-hygiene-hook (resume case).

## Session hygiene — settings.json vs update-config skill

2026-08-18: three sessions in one week each absorbed a 177k–240k-char
settings-schema injection, re-read on every later turn (~50k tokens).

Mechanized: yes — claude/settings.json `skillOverrides.update-config =
"user-invocable-only"` (commit 1779fe4, 2026-08-26) blocks agent-initiated
invocation structurally; manual `/update-config` still works. This entry
said "Mechanized: no" until 2026-09-16 — the note was committed five days
after the actual fix and never updated to match.

## ~/dotfiles is public

2026-08-18: a usage journal with session IDs landed in public history
before being untracked.

Mechanized: .semgrep.yaml rule no-session-uuid.

## Herdr vs Orca

2026-09-03: Herdr server log showed 51 active days since 07-02 (daily for
the last two weeks), 8 live workspaces, 3 of them feature worktrees; Orca
showed 13 active days in July then 3 since 08-28, with feature counters of
terminal-tabs 500–999 versus agent-orchestration 10–19, account-switching
5–9, usage-tracking 50–99, automations 3–4 — Orca use was mostly a
duplicate terminal.

Mechanized: no — one-time comparative decision record, not a recurring invariant to check.

## Reading documents — no component library

2026-09-15: a side-by-side rebuild of a 6-section stakeholder spec page in
Tailwind 4 + daisyUI 5 reproduced the hand-written version's look only
after re-applying the same typography and spacing rules as utilities; the
library itself contributed a color theme, a link style, and one stat
block. Its table needed every cell overridden to get ruled financial
tables, `table-sm` shrank body text to ~12px, `menu` removed link
underlines, CSS grew from 6KB to 49KB inline, and the build added 22MB of
dependencies. Text content was byte-identical; readability was not better.

Mechanized: no — design judgment call; can't structurally distinguish a "reading document" page from a "mock app" page.
