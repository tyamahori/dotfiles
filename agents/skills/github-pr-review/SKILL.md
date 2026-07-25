---
name: github-pr-review
description: Deliver a GitHub pull request review on GitHub itself — summary plus line-anchored inline comments, written in Japanese, posted as one review. Load when asked to review a PR, when acting on a CI failure or review-comment notification, or before posting anything to a PR via gh.
---

# github-pr-review

A review that only exists in the chat window never reaches the author. Post it
on the PR.

## Delivery shape

One review, containing:

- an overall summary comment **in Japanese**, and
- **inline** comments **in Japanese**, each anchored to a specific line.

Review only by default. Do not modify code unless the user explicitly asks.

Post it as a single review rather than a stream of separate comments:

```sh
gh api repos/<owner>/<repo>/pulls/<N>/reviews \
  -f event=COMMENT \
  -f body='<summary in Japanese>' \
  -F 'comments[][path]=src/foo.ts' -F 'comments[][line]=42' \
  -F 'comments[][body]=<inline comment in Japanese>'
```

For anything beyond a couple of comments, build the JSON and pipe it in with
`--input -` instead of repeating `-F` flags.

## The 422

GitHub rejects the **entire** review — summary included — if any single inline
comment points at a line that is not in the PR's diff. Validate every
`(path, line)` pair against the actual hunks before posting:

```sh
gh api repos/<owner>/<repo>/pulls/<N>/files --jq '.[] | "\(.filename)\n\(.patch)"'
```

Only lines present in a hunk are addressable. To comment on context the diff
does not touch, put it in the summary instead.

## The diff base is `origin/main`

The PR's diff is computed against `origin/main`, not your local `main`. A stale
local branch silently makes the change look larger than it is, and you end up
reviewing code the PR never touched. Fetch before reading the diff locally.

## Reacting to notifications

Before acting on a CI event or a review-comment notification, check the current
state of the PR:

- Is it already merged or closed?
- Is the thread already resolved?

A concurrent agent session may have handled it — especially when the work spans
days.
