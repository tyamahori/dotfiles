// Apply the shared Japanese prose baseline review to OMP write/edit tools.
// Claude Code and Codex use command-hook adapters; this extension translates
// OMP lifecycle events into the same scripts and one-review-then-pass contract.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const EDIT_HOOK = join(homedir(), "dotfiles/scripts/japanese-prose-hook-edit");
const STOP_HOOK = join(homedir(), "dotfiles/scripts/japanese-prose-hook-stop");
const PROSE_EXTENSION = /\.(?:md|markdown|txt)$/;
const URI_OR_SELECTOR = /^[A-Za-z][A-Za-z0-9+.-]*:/;

type UnknownRecord = Record<string, unknown>;

type ToolEvent = {
  toolName?: unknown;
  input?: unknown;
  isError?: unknown;
};

type ExtensionContext = {
  cwd?: string;
};

type StopResult =
  | { decision: "block"; reason: string }
  | { continue: true; additionalContext: string }
  | undefined;

type ExtensionApi = {
  on(event: string, handler: (event: ToolEvent, ctx: ExtensionContext) => unknown): void;
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : undefined;
}

function unquote(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function textInput(input: unknown): string {
  if (typeof input === "string") return input;
  const record = asRecord(input);
  if (!record) return "";
  for (const key of ["input", "command", "patch"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

export function editedProsePaths(event: ToolEvent): string[] {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const input = asRecord(event.input);
  const paths = new Set<string>();

  if (toolName === "write" && typeof input?.path === "string") {
    paths.add(input.path);
  }

  const patch = textInput(event.input);
  if (toolName === "edit") {
    for (const match of patch.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gm)) {
      paths.add(match[1]);
    }
    for (const match of patch.matchAll(/^MV (.+)$/gm)) {
      paths.add(unquote(match[1]));
    }
  }

  if (toolName === "apply_patch") {
    for (const match of patch.matchAll(
      /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm,
    )) {
      paths.add(unquote(match[1]));
    }
  }

  return [...paths].filter(
    (path) => PROSE_EXTENSION.test(path) && !URI_OR_SELECTOR.test(path),
  );
}

function runHook(
  script: string,
  payload: UnknownRecord,
): { stdout: string; error?: string } {
  const result = spawnSync(script, [], {
    encoding: "utf8",
    env: { ...process.env, JAPANESE_PROSE_RUNTIME: "omp" },
    input: JSON.stringify(payload),
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });

  if (result.error) {
    return { stdout: "", error: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit status ${result.status}`;
    return { stdout: result.stdout, error: detail };
  }
  return { stdout: result.stdout };
}

export default function japaneseProse(pi: ExtensionApi): void {
  let sessionId = randomUUID();
  let hookError: string | undefined;
  let reportedHookError: string | undefined;

  const reset = () => {
    sessionId = randomUUID();
    hookError = undefined;
    reportedHookError = undefined;
  };

  const runEditHook = (eventName: "PreToolUse" | "PostToolUse", path: string, cwd: string) => {
    const result = runHook(EDIT_HOOK, {
      cwd,
      hook_event_name: eventName,
      session_id: sessionId,
      tool_input: { file_path: path },
    });
    if (result.error) hookError = result.error;
  };

  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  pi.on("tool_call", (event, ctx) => {
    const cwd = ctx.cwd || process.cwd();
    for (const path of editedProsePaths(event)) {
      runEditHook("PreToolUse", path, cwd);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError === true) return;
    const cwd = ctx.cwd || process.cwd();
    for (const path of editedProsePaths(event)) {
      runEditHook("PostToolUse", path, cwd);
    }
  });

  pi.on("session_stop", (_event, ctx): StopResult => {
    if (hookError) {
      if (reportedHookError === hookError) {
        hookError = undefined;
        reportedHookError = undefined;
        return;
      }
      reportedHookError = hookError;
      return {
        decision: "block",
        reason: `日本語文章レビューHookの実行に失敗しました: ${hookError}`,
      };
    }

    const result = runHook(STOP_HOOK, {
      cwd: ctx.cwd || process.cwd(),
      hook_event_name: "Stop",
      session_id: sessionId,
    });
    if (result.error) {
      hookError = result.error;
      return {
        decision: "block",
        reason: `日本語文章レビューHookの実行に失敗しました: ${result.error}`,
      };
    }

    const output = result.stdout.trim();
    if (!output) return;
    try {
      const decision = JSON.parse(output) as UnknownRecord;
      if (decision.decision === "block" && typeof decision.reason === "string") {
        return { decision: "block", reason: decision.reason };
      }
    } catch {
      return {
        decision: "block",
        reason: "日本語文章レビューHookが不正な応答を返しました。設定を確認してください。",
      };
    }
  });
}
