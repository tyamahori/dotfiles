// session_start で ~/dotfiles のエージェント管理ファイル
// (agents/global-instructions.md, claude/settings.json, codex/hooks.json)の
// 未コミット差分を検知して通知する。jbcontext setup-agent とその AutoUpdater が
// symlink 越しにこれらを書き換える事故(2026-08-26 日誌: 0.9.9->0.9.10 自動更新で
// 中立指示ブロックが Codex テンプレに置換された。2026-09-09 の 0.9.12 更新では
// codex/hooks.json からこの検知フック自体が消された)を、数日後の謎 diff 調査では
// なくセッション開始時の即時警告に変える。予防は `jbcontext config set
// skip-agents-on-upgrade true`(0.9.12+)で、ここはその取りこぼしの検知。
// Claude/Codex は scripts/jbcontext-clobber-check(SessionStart hook)で同じ検査を行う。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = join(homedir(), "dotfiles");
const WATCHED = [
  "agents/global-instructions.md",
  "claude/settings.json",
  "codex/hooks.json",
];

type Ctx = {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: string) => void };
};

type ExtensionHandlerApi = {
  on(
    event: string,
    handler: (event: unknown, ctx: Ctx | undefined) => void,
  ): void;
};

let checked = false;

export default function (pi: ExtensionHandlerApi): void {
  pi.on("session_start", (_event, ctx) => {
    if (checked || !ctx?.hasUI) return;
    checked = true;
    if (!existsSync(join(REPO, ".git"))) return;
    const result = spawnSync(
      "git",
      ["-C", REPO, "status", "--porcelain", "--", ...WATCHED],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.error || result.status !== 0) return;
    const dirty = result.stdout.trim();
    if (!dirty) return;
    ctx.ui?.notify?.(
      `jbcontext-clobber-guard: ~/dotfiles のエージェント管理ファイルに未コミット差分(${dirty.replace(/\n/g, ", ")})。` +
        `意図した編集でなければ jbcontext setup-agent / AutoUpdater の書き換えを疑い、` +
        `~/.jbcontext/logs/jbcontext.log の AutoUpdater 行と mtime を突き合わせて復旧する`,
    );
  });
}
