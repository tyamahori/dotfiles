# Measured notes

Evidence behind the "measured" rules in `global-instructions.md`. This file
is not loaded by any agent; the incidents live here so the always-loaded
instructions stay small.

## Commits and PRs — branch from an up-to-date base

2026-08-24: two sessions needed `rebase --onto` and a force-push after a
branch cut from an unmerged branch dragged in 17 unrelated commits.

## Root-cause claims need reproduction

2026-08-24: two investigations blamed an external API's plan and an
"invalid" API key; the user's own curl probe disproved both.

## Fail fast on repeated identical failures

2026-08-23: one session repeated an identity-mismatch sweep 15 times, and
three sessions burned ~20 identical no-op turns on blocked delivery, with
the correct diagnosis already made on the first attempt.

## Session hygiene — quota goes to context re-reads

2026-08-16: one resumed session consumed 64% of a week's Anthropic quota,
half of it compaction churn.

## Session hygiene — don't resume a large idle context

2026-08-19: a 2h17m same-day resume rewrote 239k cache tokens, then
reprocessed 3.07M context tokens over 10 turns.

## Session hygiene — settings.json vs update-config skill

2026-08-18: three sessions in one week each absorbed a 177k–240k-char
settings-schema injection, re-read on every later turn (~50k tokens).

## ~/dotfiles is public

2026-08-18: a usage journal with session IDs landed in public history
before being untracked.

## Herdr vs Orca

2026-09-03: Herdr server log showed 51 active days since 07-02 (daily for
the last two weeks), 8 live workspaces, 3 of them feature worktrees; Orca
showed 13 active days in July then 3 since 08-28, with feature counters of
terminal-tabs 500–999 versus agent-orchestration 10–19, account-switching
5–9, usage-tracking 50–99, automations 3–4 — Orca use was mostly a
duplicate terminal.
