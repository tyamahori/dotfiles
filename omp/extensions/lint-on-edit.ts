// write/edit/apply_patch 直後に編集ファイルへ lint(shellcheck / ruff /
// actionlint)をかけ、指摘を steer 注入で即時に直させる。Claude(PostToolUse
// の decision:block)/Codex(codex/hooks/lint-edit.sh)と同じ共有スクリプト
// scripts/lint-on-edit を使う OMP 版。パス抽出は japanese-prose.ts と
// 同型だが、拡張子で絞らず共有スクリプト側の判定に委ねる。

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const HOOK = join(homedir(), "dotfiles/scripts/lint-on-edit");
const URI_OR_SELECTOR = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MAX_TIMING_RECORDS = 10_000;

type LintOutcome = "clean" | "findings" | "error";

type UnknownRecord = Record<string, unknown>;

const PATCH_KEYS = ["input", "patch", "command"] as const;
function patchText(input: unknown, record: UnknownRecord | undefined): string {
  if (typeof input === "string") return input;
  for (const key of PATCH_KEYS) {
    const value = record?.[key];
    if (typeof value === "string") return value;
  }
  return "";
}

type ToolEvent = {
  toolName?: unknown;
  input?: unknown;
  isError?: unknown;
};

type ExtensionContext = {
  cwd?: string;
};

type ExtensionApi = {
  on(event: string, handler: (event: ToolEvent, ctx: ExtensionContext | undefined) => void): void;
  sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => unknown;
};

function unquote(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Both hook scripts skip paths that no longer exist, so deleted files are
// harmless to report and one parser serves lint-on-edit and japanese-prose.
export function editedPaths(event: ToolEvent): string[] {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const record = event.input !== null && typeof event.input === "object" ? (event.input as UnknownRecord) : undefined;
  const paths = new Set<string>();

  if (toolName === "write" && record) {
    const path = record.path ?? record.file_path;
    if (typeof path === "string") paths.add(path);
  }

  const patch = patchText(event.input, record);
  if (toolName === "edit") {
    for (const match of patch.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gm)) {
      paths.add(match[1]);
    }
    for (const match of patch.matchAll(/^MV (.+)$/gm)) {
      paths.add(unquote(match[1]));
    }
  }
  if (toolName === "apply_patch") {
    for (const match of patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) {
      paths.add(unquote(match[1]));
    }
  }

  // write/edit expand a leading ~ themselves; the hooks get the real path.
  return [...paths].filter((path) => !URI_OR_SELECTOR.test(path)).map((path) => path.replace(/^~(?=\/|$)/, homedir()));
}

// 共有スクリプトの契約は、問題なしなら無出力、指摘ありなら decision:block の JSON。
// それ以外(起動失敗・時間切れ・非ゼロ終了・不正な出力)を clean と数えない。
function interpretLint(result: SpawnSyncReturns<string>): { outcome: LintOutcome; reason?: string } {
  if (result.error || result.status !== 0) return { outcome: "error" };
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return { outcome: "clean" };
  try {
    const decision = JSON.parse(stdout) as UnknownRecord;
    if (decision.decision === "block" && typeof decision.reason === "string") {
      return { outcome: "findings", reason: decision.reason };
    }
  } catch {
    // 共有スクリプトの出力が JSON でない場合は黙って続行し、error と数える。
  }
  return { outcome: "error" };
}

function steer(pi: ExtensionApi, reason: string): void {
  try {
    // omp 18.18.2 以降、ターン開始前に破棄されると reject する。try/catch では拾えないので .catch で受ける。
    void Promise.resolve(pi.sendUserMessage?.(`[lint-on-edit] ${reason}`, { deliverAs: "steer" })).catch(() => {});
  } catch {
    // 同期例外で残りのファイルの lint を止めない。
  }
}

// XDG は相対パスを無効と定めている。作業ツリーへ計測記録を書かないよう既定へ戻す。
export function hookTimingDir(env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_STATE_HOME;
  const stateHome = xdg && isAbsolute(xdg) ? xdg : join(home, ".local/state");
  return join(stateHome, "agent-eval/hooks");
}

// 実行ごとに専用のファイルへ書き、他の OMP プロセスと書き込み先を共有しない。
// ponytail: 上限は 1 実行の件数だけ。ファイル数は数えない(明示的に有効にした実行の分だけ増え、手で消す)。
function timingRecorder(dir: string): (outcome: LintOutcome, elapsedMs: number) => void {
  const file = join(dir, `lint-on-edit-${process.pid}-${randomUUID()}.jsonl`);
  let written = 0;
  return (outcome, elapsedMs) => {
    if (written >= MAX_TIMING_RECORDS) return;
    try {
      if (written === 0) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = {
        schemaVersion: 1,
        hook: "lint-on-edit",
        elapsedMs: Math.round(elapsedMs),
        outcome,
        timestamp: new Date().toISOString(),
      };
      writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: written === 0 ? "wx" : "a", mode: 0o600 });
      written++;
    } catch {
      // 計測の失敗で lint の指摘と編集を止めない。
    }
  };
}

export default function lintOnEdit(pi: ExtensionApi): void {
  const recordTiming =
    process.env.AGENT_HOOK_TIMING === "1" ? timingRecorder(hookTimingDir(process.env, homedir())) : undefined;
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    const cwd = ctx?.cwd || process.cwd();
    for (const path of editedPaths(event)) {
      const absolute = isAbsolute(path) ? path : join(cwd, path);
      const startedAt = performance.now();
      const result = spawnSync(HOOK, [], {
        encoding: "utf8",
        input: JSON.stringify({ tool_input: { file_path: absolute } }),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
      const elapsedMs = performance.now() - startedAt;
      const { outcome, reason } = interpretLint(result);
      if (reason !== undefined) steer(pi, reason);
      recordTiming?.(outcome, elapsedMs);
    }
  });
}
