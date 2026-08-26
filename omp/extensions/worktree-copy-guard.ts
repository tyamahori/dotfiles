// bash ツールで raw `git worktree add` が実行された直後に、共有フック
// scripts/worktree-copy-hook を経由して worktree-include-copy を回す。
// global instructions の「raw worktree add の直後は必ず worktree-include-copy」
// の機械化。helper は冪等(上書きなし・symlink スキップ)なので誤発火しても
// 無害。OMP のタスク分離は checkout 全体を clone するため、この拡張が効くのは
// セッション内で raw に worktree を切った場合だけ。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK = join(homedir(), "dotfiles/scripts/worktree-copy-hook");
const WORKTREE_ADD = /git[^;&|]*\sworktree\s+add(\s|$)/;

type UnknownRecord = Record<string, unknown>;

type ToolEvent = {
  toolName?: unknown;
  input?: unknown;
  isError?: unknown;
};

type Ctx = {
  cwd?: string;
  ui?: { notify?: (message: string, level?: string) => void };
};

type ExtensionHandlerApi = {
  on(
    event: string,
    handler: (event: ToolEvent, ctx: Ctx | undefined) => void,
  ): void;
};

export default function (pi: ExtensionHandlerApi): void {
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "bash") return;
    const record =
      event.input !== null && typeof event.input === "object"
        ? (event.input as UnknownRecord)
        : undefined;
    const command =
      typeof record?.command === "string" ? record.command : "";
    if (!WORKTREE_ADD.test(command)) return;

    const result = spawnSync(HOOK, [], {
      encoding: "utf8",
      input: JSON.stringify({
        cwd: ctx?.cwd || process.cwd(),
        tool_input: { command },
      }),
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
    const stdout = (result.stdout ?? "").trim();
    if (result.error || result.status !== 0 || !stdout) return;
    try {
      const parsed = JSON.parse(stdout) as UnknownRecord;
      const specific = parsed.hookSpecificOutput as UnknownRecord | undefined;
      const context = specific?.additionalContext;
      if (typeof context === "string") {
        ctx?.ui?.notify?.(context);
      }
    } catch {
      // 通知はベストエフォート。コピー自体は完了している。
    }
  });
}
