// write/edit/apply_patch 直後にシェルスクリプトへ shellcheck をかけ、指摘を
// steer 注入で即時に直させる。Claude(PostToolUse の decision:block)/Codex
// (codex/hooks/shellcheck-edit.sh)と同じ共有スクリプト
// scripts/shellcheck-on-edit を使う OMP 版。パス抽出は japanese-prose.ts と
// 同型だが、拡張子で絞らず共有スクリプト側の shebang 判定に委ねる。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const HOOK = join(homedir(), "dotfiles/scripts/shellcheck-on-edit");
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

type ExtensionApi = {
  on(
    event: string,
    handler: (event: ToolEvent, ctx: ExtensionContext | undefined) => void,
  ): void;
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ) => unknown;
};

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
  const record =
    input !== null && typeof input === "object"
      ? (input as UnknownRecord)
      : undefined;
  if (!record) return "";
  for (const key of ["input", "patch", "command"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

export function editedPaths(event: ToolEvent): string[] {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const record =
    event.input !== null && typeof event.input === "object"
      ? (event.input as UnknownRecord)
      : undefined;
  const paths = new Set<string>();

  if (toolName === "write" && record) {
    const path = record.path ?? record.file_path;
    if (typeof path === "string") paths.add(path);
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
      /^\*\*\* (?:Update File|Add File|Move to): (.+)$/gm,
    )) {
      paths.add(unquote(match[1]));
    }
  }

  return [...paths].filter((path) => !URI_OR_SELECTOR.test(path));
}

export default function shellcheckOnEdit(pi: ExtensionApi): void {
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    const cwd = ctx?.cwd || process.cwd();
    for (const path of editedPaths(event)) {
      const absolute = isAbsolute(path) ? path : join(cwd, path);
      const result = spawnSync(HOOK, [], {
        encoding: "utf8",
        input: JSON.stringify({ tool_input: { file_path: absolute } }),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
      const stdout = (result.stdout ?? "").trim();
      if (result.error || result.status !== 0 || !stdout) continue;
      try {
        const decision = JSON.parse(stdout) as UnknownRecord;
        if (
          decision.decision === "block" &&
          typeof decision.reason === "string"
        ) {
          pi.sendUserMessage?.(`[shellcheck-on-edit] ${decision.reason}`, {
            deliverAs: "steer",
          });
        }
      } catch {
        // 共有スクリプトの出力が JSON でない場合は黙って続行する。
      }
    }
  });
}
