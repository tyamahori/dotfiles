# On-demand task procedures

`agents/global-instructions.md` names the trigger for each section; no host
loads this file automatically. Its rules bind like the always-loaded ones.
`docs/software-engineering.md` defines what belongs here.

## Branches and pull requests

- To reach the fresh tip of the intended base: fetch, then `origin/main`, or
  the parent PR branch for a stacked PR (declare it as the PR base).
- Before the first push of a stacked branch, including one an earlier session
  created, run `git config branch.<branch>.gh-merge-base <parent>`.
- `gh pr create --body` skips the repo's template, so follow it yourself and
  tick only verified checkboxes. Either way, state what is out of scope and
  what else the change could affect. Keep the description readable in a
  minute: link run logs, SHA lists, and metric tables instead of pasting them.
- `--attach` on `gh pr create|edit|comment` and `gh issue create|edit|comment`
  uploads a local image or video into the body; use it for screenshots instead
  of browser uploads or external hosting.
- After posting, open the PR page following `browser-verify` and confirm that
  every Mermaid block and attached image renders, in the body and in Markdown
  files the PR changes; GitHub shows an error box instead of a diagram it
  cannot parse. Fix the body with `gh pr edit` or the file with a new commit,
  then check again. No pre-post render check.

## Herdr worktree workers

The coordinator plans, briefs, reviews, and integrates, while a worker that
`omp-herdr-collab`'s `spawn.sh` starts with `HC_WORKTREE_BRANCH` writes the
code in that branch's worktree workspace.

The coordination rule also covers repository procedures that launch a writing
`codex exec` themselves: send the same prompt to the worker, and turn their
`resume` steps into messages to that worker. Repository scripts that only
review and write a result file run as the repository defines.
