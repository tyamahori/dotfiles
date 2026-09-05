# dotfiles

tyamahori's macOS setup.

## Setup

```bash
git clone https://github.com/tyamahori/dotfiles.git ~/project/dotfiles
cd ~/project/dotfiles
./scripts/setup
```

`scripts/setup` runs the following in order:

1. `scripts/init` — install Homebrew, Nix, Devbox, and — only when `gh` is already installed — its extensions (`gh` itself is not managed by setup)
2. `scripts/apps` — install the repository Brewfile on macOS
3. `scripts/devbox` — install global devbox packages and lockfile-pinned dependencies for local hooks
4. `scripts/python` — install the latest CPython via `uv` and register it as the global `python` / `python3`
5. `scripts/link` — create the stable `~/dotfiles` alias, symlink shared instructions and runtime adapters, enable Codex hooks, and link OMP configuration
6. `scripts/omp-plugins` — install the declared OMP plugin set (`omp plugin install`)

The repository can be cloned anywhere. `scripts/link` maintains
`~/dotfiles` as the stable path used by hooks and shared skills.

For a full new-machine migration — including the manual steps `scripts/setup`
does not cover (sign-ins, 1Password SSH agent, jbcontext, launchd choices,
machine-local state) — follow [`docs/new-machine.md`](docs/new-machine.md).

`scripts/link` also enables this repository's pre-commit guard. It blocks staged
UUIDs and dollar-denominated measurements. Add machine-specific project or
customer names to the gitignored `git/sensitive-patterns.local`, one literal
string per line. Intentional public content can bypass the guard with
`git commit --no-verify`.

`.gitconfig` also standardizes `main` as the initial branch, readable non-ASCII
paths, histogram/moved-line diffs, stale remote pruning, and first-push upstream
setup.

### Machine-global git hooks

`.gitconfig` sets a global `core.hooksPath` to `git/global-hooks/`, so the
hooks there run for every repository on the machine — manual commits and all
agent CLIs (Claude Code, Codex, OMP) alike, since they all shell out to
`git commit`. Each hook name is a symlink to `dispatch`, which runs the
machine-global check and then delegates to the repository's own
`.git/hooks/<name>` (a global hooksPath would otherwise silently shadow it).
Repositories that set a local `core.hooksPath` — husky, lefthook, and this
repository itself — bypass the global directory entirely.

Current checks:

- **commit-msg Why guard**
  (`git/global-hooks/checks/commit-msg-why`) — enforces the "commit logs carry
  the Why" rule from `agents/global-instructions.md` by rejecting subject-only
  messages for changes over 3 lines. Merge/cherry-pick/rebase messages,
  `fixup!`/`squash!`/`amend!`/`Revert` subjects, and tiny diffs are exempt.
- **pre-commit semgrep** (`checks/pre-commit-semgrep`) — runs the same rules
  as `semgrep-quality-gate` on the staged files only (repo `.semgrep.yaml`,
  falling back to `semgrep/default.yaml`), so the gate holds structurally
  without an agent-side completion step. See [`docs/semgrep.md`](docs/semgrep.md).
- **pre-commit gitleaks** (`checks/pre-commit-gitleaks`) — scans the staged
  diff for secrets; false positives are silenced with a `gitleaks:allow`
  comment.
- **pre-commit dclint** (`checks/pre-commit-dclint`) — lints staged Docker
  Compose files against modern Compose notation with dclint (errors only; a
  repo's own `.dclintrc` wins, `# dclint disable-line <rule>` opts out a
  line).
- **pre-commit json** (`checks/pre-commit-json`) — validates staged JSON files
  with `jq empty` and requires `jq --sort-keys` canonical formatting for
  `claude/settings.json`, `codex/hooks.json`, `omp/lsp.json`, `omp/dap.json`,
  and `omp/mcp.json`. JSONC dialects (`*.jsonc`, `tsconfig`/`jsconfig`, `.vscode`,
  devcontainer) are skipped.

Genuinely exceptional commits bypass all checks with `git commit --no-verify`.
This repository sets a local `core.hooksPath`, so it wires the same checks
through `git/hooks/commit-msg` (symlink) and explicit calls at the end of its
`git/hooks/pre-commit`.

## OMP (Oh My Pi)

日常の起動方法、セッション操作、モデル運用、local memory、自動学習、定期レビュー、設定変更、トラブル対応は [`docs/omp.md`](docs/omp.md) にまとめています。

最短では、対象リポジトリで `omp`、場所を間違えたくない場合は `omp-repo <repository-path>`、非 trivial な実装は `omp-build` を使います。

## Agent instructions

`agents/global-instructions.md` is a single set of guidance for the LLM coding
CLIs on this machine (Claude Code, OpenAI Codex, GitHub Copilot CLI, and OMP).
`scripts/link` symlinks it into the native global instruction locations:

- Claude Code → `~/.claude/CLAUDE.md`
- Codex       → `~/.codex/AGENTS.md`
- Copilot CLI → `~/.copilot/copilot-instructions.md`
- OMP         → discovers the Claude and Codex user-level files above

Edit that one file to change the rules for all four. It currently tells the
agents to default to the uv-managed Python (`scripts/python`) rather than system,
Homebrew, or nix interpreters.

### Keep personal project settings local

このdotfilesの設定は個人利用を前提としています。
既存の共有repositoryへ任意の設定ファイルを個人用として追加する場合は、共有の`.gitignore`を変更せず、そのrepositoryだけに効く`.git/info/exclude`へpathを追加します。
チームで共有することを合意した設定だけをversion管理します。

### Codex config

Codex の好みの設定（model、approval/sandbox、features、TUI 通知）は
`codex/config.toml` が正本で、`/etc/codex/config.toml`（system 層）に symlink
する。Codex 自身が書き換える `~/.codex/config.toml`（プロジェクトの trust
list、hooks.state、plugin 状態、デスクトップアプリ由来の MCP 定義、`/model` の
選択）は machine-local のまま追跡しない。user 層が system 層より優先されるの
で、設定を dotfiles 側で変えたら同じキーが `~/.codex/config.toml` に残って
いないことを確認する。`/etc` は root 所有のため `scripts/link` は link の有無だ
けを検証し、未設定なら実行すべき `sudo ln` を表示する。

承認なしで sandbox 外実行を許すコマンドは `codex/rules/default.rules`
（→ `~/.codex/rules/default.rules`）で prefix 単位に管理する。TUI の「常に許可」は
同じファイルへコマンド文字列の完全一致ルールを追記するだけなので、溜まったら
prefix に畳んで一回限りの行を消す。リポジトリ固有のコマンドはそのリポジトリの
`.codex/rules/` に置く。判定の確認は
`codex execpolicy check --pretty --rules codex/rules/default.rules -- <cmd>`。

### Local SonarQube quality gate

SonarQube Server、Scanner、runner、認証情報、AIエージェントの実行規約はdotfilesがmachine-globalに管理します。
解析対象のrepositoryには、opt-inと解析範囲を表すroot-levelの`sonar-project.properties`だけを置きます。
runnerはGit未追跡のファイルを解析から自動除外し、Git管理済みファイルとそのworking tree上の変更だけを解析対象にします。

通常の検証後に`sonar-quality-gate`を実行すると、OrbStack上のlocal Serverを起動し、`http://sonarqube.local`経由で解析してQuality Gateを待ちます。
初回導入、project設定、日常操作、Dashboard、初期化、troubleshootingは[`docs/sonarqube.md`](docs/sonarqube.md)を参照してください。

### Local Semgrep quality gate

Semgrep runner（`semgrep-quality-gate`）、machine-globalのdefault ruleset（`semgrep/default.yaml`）、AIエージェントの実行規約はdotfilesが管理します。
repository固有ruleを使う場合だけ、root-levelの`.semgrep.yaml`を置いてdefaultを置き換えます。
SonarQubeが履歴つきの品質判定を担い、Semgrepはserverなしの高速なpattern検査とrepository固有ruleを担います。

通常の検証後に`semgrep-quality-gate`を実行すると、repositoryのruleかdefault rulesetをlocalだけで解析し、指摘があれば失敗します。
rule作成、registry rulesetの取り込み、SonarQubeとの使い分けは[`docs/semgrep.md`](docs/semgrep.md)を参照してください。

### ponytail (minimal-code mode)

All three coding CLIs (OMP, Claude Code, Codex) run the
[ponytail](https://github.com/DietrichGebert/ponytail) plugin, which injects a
YAGNI ladder every turn (default level: full). Daily usage, per-host wiring,
reinstall steps, and uninstall order are in
[`docs/ponytail.md`](docs/ponytail.md). Installs are reproduced automatically:
Claude Code declaratively via `claude/settings.json`, OMP by
`scripts/omp-plugins`, Codex by `scripts/link` (its hook trust stays a one-time
manual `/hooks` step).

### diagram / artifact workflow

Architecture, workflow, sequence, data-flow, and lifecycle diagrams go through
[`archify`](https://github.com/tt-a1i/archify). Plans, diffs, and generated
HTML are reviewed with Plannotator before sharing when that extra pass matters.
For stakeholder handoff, the preferred presentation layer is a Claude artifact;
the repository-owned source of truth stays the diagram JSON IR or Markdown. The
daily workflow, host wiring, verification commands, and anti-"AIっぽさ" rules
are in [`docs/diagram-workflow.md`](docs/diagram-workflow.md).

### Japanese prose review

Claude Code, Codex, and OMP run the same Japanese prose review around file
edits. The runtime-specific adapters capture the file's pre-edit findings and
call `scripts/japanese-prose-lint` when the agent tries to finish. Only findings
introduced by that agent are reported. The first report asks the agent to
review the wording; an unchanged second result passes so a contextual judgment
cannot create an infinite rewrite loop.

This is an agent-runtime check, not a git hook. The Codex hooks feature is
enabled in `codex/config.toml`. After `codex/hooks.json` changes, open `/hooks`
in Codex and trust the updated definition before relying on it.

### Vendored third-party skills

Most third-party skills are installed with `npx skills add <owner/repo> -g`
into `~/.agents/skills/` and tracked by `~/.agents/.skill-lock.json`;
`npx skills check` / `npx skills update` keep them current. A skill is
vendored into `agents/skills/<name>/` instead when the repo depends on its
files (the prose lint above calls `natural-japanese/scripts/lint.py`) or
carries deliberate local edits. Each vendored skill has `.openskills.json`
(`repoUrl`, `subpath`, synced `commit`) and, if edited, a `local.patch`
holding the diff against upstream.

`scripts/skill-sync --check` compares the recorded commit with upstream HEAD;
`scripts/brewUpdate` runs it so drift shows up during the routine update.
`scripts/skill-sync --apply` replaces the files with upstream, re-applies
`local.patch`, and records the new commit; review with `git diff` and commit.
If the patch stops applying, resolve by hand and regenerate it: copy the
upstream subpath into a scratch git repo, commit it, rsync the vendored
directory over it (excluding `.openskills.json` and `local.patch`), and save
`git diff` as `local.patch`.

### Runtime guard hooks

The same three runtimes share a set of guard hooks. Claude Code and Codex
wire the shell scripts through `claude/settings.json` / `codex/hooks.json`;
OMP mirrors each one as an extension in `omp/extensions/`:

- **bare-Python deny** — `scripts/deny-bare-python-hook` forces the
  uv invocation forms required by the shared instructions.
- **lint on edit** — `scripts/lint-on-edit` lints files right after an agent
  writes or edits them (shellcheck for shell, ruff for Python, oxlint for
  TypeScript/JavaScript, actionlint for GitHub workflow files, jq syntax
  validation for JSON, `jq --sort-keys` formatting for the linked
  Claude/Codex/OMP JSON configuration, and dclint for Docker Compose files)
  and feeds findings back for an immediate fix. dclint runs errors only, so
  obsolete notation like a `version` field, untagged images, or unquoted ports
  blocks immediately. Its binary is a locked Node dependency in `tools/dclint`,
  installed by `scripts/devbox`.
- **jbcontext clobber check** — `scripts/jbcontext-clobber-check` warns at
  session start when `agents/global-instructions.md` or
  `claude/settings.json` carry uncommitted changes — the signature of a
  jbcontext setup-agent run or auto-update rewriting them through the
  symlinks.
- **worktree include sweep** — `scripts/worktree-copy-hook` runs
  `worktree-include-copy` automatically after a raw `git worktree add`
  (see "Worktree-local files" below).
- **locked-1Password hint** — `scripts/push-agent-hint` intercepts
  `communication with agent failed` on git/ssh commands and feeds back that
  the only fix is unlocking 1Password, so agents stop misdiagnosing it as a
  network or SSH-config problem.
- **session hygiene** — `scripts/session-hygiene-hook` (Claude Code and
  Codex `SessionStart`) warns on day-crossing resumes, hour-idle
  large-transcript resumes, and from the second compaction of a session
  onward. OMP covers the same rules with its `session-day-guard` and
  `session-compaction-guard` extensions, and its `handoff-switch` extension
  closes the loop: once the agent saves the handoff note and calls the
  `handoff_switch` tool, the extension opens a fresh session after the
  current response and feeds it the note.

### Worktree-local files
Repository-local `.worktreeinclude` files are the shared allowlist for
gitignored setup files needed by agent worktrees. Claude Code and Codex managed
worktrees process the file natively. Herdr runs the same copy behavior from its
`worktree.created` plugin. OMP task isolation clones the full checkout, so the
same files are already present there.

When an agent creates a worktree with raw `git worktree add`, the shared
instructions require it to run:

```bash
worktree-include-copy <source-repository> <new-worktree>
```

The helper uses gitignore-style patterns, copies only files that are also
gitignored, skips source symlinks, and leaves existing destination files
unchanged. `scripts/link` installs it in `~/.local/bin` and links the Herdr
plugin that invokes it automatically.

The `worktree-copy-hook` guard above also runs the helper automatically right
after a raw `git worktree add` in Claude Code, Codex, and OMP sessions.

### efficient-python skill & quarterly review

How the agents use Python is governed by the `efficient-python` skill
(`agents/skills/efficient-python/`), written 2026-07 from an audit of real
session logs to cut token waste (bare-python denials, missing-module retries,
re-running failed commands unchanged). Because its advice can rot as uv and
the ecosystem move, a self-checking loop keeps it honest:

- **`scripts/audit-python-usage`** — re-runs the audit over
  `~/.claude/projects` transcripts any time; fixed-schema JSON to stdout,
  `--save` archives a snapshot to `~/.local/state/python-usage-audit/` and
  prints a delta vs the previous one. This is how to tell whether the skill
  is actually improving agent behavior.
- **`launchd/com.tyamahori.python-skill-review.plist`** (rendered & loaded by
  `scripts/link`) fires **`scripts/python-skill-review`** quarterly
  (Jan/Apr/Jul/Oct 15th, 09:47; a sleeping Mac runs it on wake). It runs a
  headless `claude -p` that re-audits, checks uv release notes, and writes a
  **proposal-only** report (no files are edited) to
  `~/.local/state/python-usage-audit/review-YYYY-MM-DD.md`, announced via a
  macOS notification.
- **When the notification appears**: read the report; if it proposes skill
  changes, apply the ones you agree with to
  `agents/skills/efficient-python/SKILL.md` (or hand the report to an agent
  session) and commit. Applying is deliberately manual.
- Run `./scripts/python-skill-review` (or `launchctl kickstart
  gui/$(id -u)/com.tyamahori.python-skill-review`) to trigger a review
  off-schedule.

### Agent collaboration (Herdr only)

Agents collaborate without manual copy-pasting. The coordinator is always an
**omp session** that has loaded the `omp-herdr-collab` skill; Claude Code and
Codex participate as peers (reviewers or task recipients) and receive their
contract via the skill's shipped templates — peers never read the skill.

`review-mode` absent is the **single** review: one fresh reviewer from a
model family different from the implementer, following
`REVIEW-REQ → FINDINGS → APPLIED` (when needed)
`→ VERIFIED → DECISION` (for unresolved high/mid). Revisions are pinned as
`commit:` only; uncommitted work gets a temporary commit in a worktree.

Explicit `review-mode: panel` is a manual **Herdr-only** mode owned by the
`omp-herdr-collab-panel` skill: exactly two distinct fresh reviewers
(reviewer-a from the opposite model family as the independent
`correctness-contract` anchor, reviewer-b same-family with a documented
failure-mode lens), a FINDINGS independence barrier, CROSS-CHECK, a lossless
CONSOLIDATED ledger, owner-scoped VERIFIED partitions, and group fanout. A
decline or timeout is non-go: panel never silently becomes single.

- **Inside Herdr**: `omp-herdr-collab` stores one flow ledger under
  `.agent-msgs/`, validates every review tag before delivery, scaffolds
  return-file skeletons (`review-flow.py scaffold`), and prints the next
  action with `review-flow.py status`.
- **Outside Herdr**: there is no skill-based transport. An occasional second
  opinion from a GUI Claude or Codex session is a manual paste of the
  template and artifact; it carries no review tags and never claims review
  closure.

Shared closure accepts only `closed-pass`, `closed-low`, and `closed-risk`;
unresolved high/mid needs a user DECISION. Direct message transport is not
itself mutual review. `adversarial-verification` remains the distinct,
higher-cost, broader two-pass mode for high-risk work.

- **Then ask in plain words**:
  - 「Codex にレビューさせて」
  - 「Codex が実装、Claude がレビューで」
  - 「この変更を Herdr の panel review にかけて」
  - 「この調査結果を Codex に共有して」
  - 「このタスクを Codex に渡して」
  All of these run inside Herdr, coordinated from omp; panel included.
- **Inspect a conversation**: inside Herdr, use
  `~/.agents/skills/omp-herdr-collab/scripts/inbox.sh --flow <flow>`. Formal
  reviews use `.agent-msgs/<flow>` as the ledger and must pass
  `review-flow.py require-closed --dir .agent-msgs/<flow>`.

The omp-herdr-collab scripts exit unless `HERDR_ENV=1`, so Herdr sessions are
never operated from outside.

Sources of truth (this section is only the human entry point): the review
contract, tags/templates, lifecycle, validator, and Herdr transport live in
`agents/skills/omp-herdr-collab/` (panel extensions in
`agents/skills/omp-herdr-collab-panel/`); routing lives in
`agents/global-instructions.md`.

## OrbStack VM (Ubuntu 24.04)

Reproduces this dev environment in an OrbStack Linux VM via cloud-init.

```bash
orb create --isolated --forward-ssh-agent -c cloud-init/ubuntu.yaml ubuntu:24.04 dev
orb shell dev   # default user inherits from the macOS host
```

What it installs: zsh, Nix (Determinate Systems), Devbox + global packages
(`php go direnv bun git nodejs httpie cmake curl task uv`), the latest CPython
via `uv` as the global `python` / `python3`, `gh` + `gh-copilot` extension,
Docker CE (with the default user added to the `docker` group), and links
dotfiles from this repo. macOS-only items (Homebrew casks, `mas`) are skipped.

> Note: the docker group membership only takes effect after the next login —
> reconnect with `orb shell dev` or run `newgrp docker` once.

## Maintenance

```bash
# Sync dotfiles with remote (pull --rebase, commit local diff, push)
./scripts/sync

# Update brew formulae and casks
./scripts/brewUpdate

# Reapply OMP plugins and managed links after `omp update`
omp-apply

# Visualize disk usage on the desktop
./scripts/clean
```

`brewUpdate` defers `brew cleanup` when a running OMP session still uses an old
Cellar executable. Close those OMP sessions and rerun the script to finish
cleanup.

## Optional / Manual steps

These are not run automatically. Copy & paste as needed.

### Package layering

Every global tool has exactly one owning layer; never install the same tool
in two layers. devbox's profile precedes `/opt/homebrew/bin` in PATH, so a
duplicate silently shadows the brew copy and forks behavior.

- **System (no reinstall)** — OS-bundled network/TLS commands: `curl`, `git`.
  Apple's curl is a SecureTransport build that reads the Keychain trust
  store; nix/brew curls carry their own CA bundles and behave differently
  behind corporate/MITM CAs.
- **`scripts/devbox`** — cross-platform language toolchains and reproducible
  CLIs via `devbox global`. Default for anything a project or CI also pins.
- **`~/.Brewfile`** (`scripts/apps`) — macOS-integrated tools and casks:
  anything touching Keychain, launchd, notifications, or a GUI.
- **`scripts/nix-extras`** — raw `nix profile add`, only for what devbox
  can't carry well (unfree packages, custom flake refs). Edit the script to
  add packages, then run it:

  ```bash
  ./scripts/nix-extras
  ```

### gh extensions

```bash
gh extension install github/gh-copilot
```
