// macOS notifications for OMP, in the same spirit as claude/hooks/herdr-notify.sh
// (Claude Code) and scripts/codex-notify (Codex): turn completion and
// attention-needed events (ask / tool approval / hard error) surface as
// terminal-notifier toasts so unattended panes don't silently stall.
//
// Inside a herdr pane the toast subtitle is the pane location
// ("Ghostty / {space} / {tab} / {pane} / {agent}") and delivery is suppressed
// while the user is already looking at that pane — pane focus alone is not
// enough because herdr pane focus persists while Ghostty is in the background,
// so Ghostty must also be the frontmost app. Outside herdr there is no
// pane-focus signal, so turn completion fires only while the terminal app is
// in the background; attention events always fire.

import { execFile } from "node:child_process";

const TERMINAL_NOTIFIER = "/opt/homebrew/bin/terminal-notifier";
const GHOSTTY_BUNDLE = "com.mitchellh.ghostty";
// terminal-notifier and lsappinfo are macOS-only. On Linux delivery goes
// through notify-send and there is no frontmost-app signal at all (Wayland
// gives no portable way to ask), which changes which events are worth firing —
// see notify() below.
const IS_DARWIN = process.platform === "darwin";

// Same set herdr-omp-agent-state.ts uses: an agent_end carrying one of these
// errors is followed by an automatic retry, not a finished turn.
export const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null ? (value as Rec) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: string }>();
  execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
    resolve({ ok: !error, stdout: String(stdout ?? "") });
  });
  return promise;
}

function terminalBundle(): string {
  // The herdr server can retain TERM_PROGRAM from the terminal that first
  // started it, so inside a herdr pane the terminal is assumed to be Ghostty.
  if (process.env.HERDR_PANE_ID) return GHOSTTY_BUNDLE;
  switch (process.env.TERM_PROGRAM) {
    case "WarpTerminal":
      return "dev.warp.Warp-Stable";
    default:
      return GHOSTTY_BUNDLE;
  }
}

async function terminalFrontmost(bundle: string): Promise<boolean> {
  // No equivalent on Linux, so callers must treat "not frontmost" as unknown
  // rather than as a confirmed background state.
  if (!IS_DARWIN) return false;
  // lsappinfo (unlike osascript/System Events) needs no automation permission.
  const front = await run("lsappinfo", ["front"]);
  if (!front.ok) return false;
  const info = await run("lsappinfo", ["info", "-only", "bundleid", front.stdout.trim()]);
  return info.ok && info.stdout.includes(bundle);
}

async function herdrLocation(): Promise<{ focused: boolean; subtitle: string } | undefined> {
  const wsId = process.env.HERDR_WORKSPACE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const paneId = process.env.HERDR_PANE_ID;
  const snap = await run("herdr", ["api", "snapshot"]);
  if (!snap.ok) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(snap.stdout);
  } catch {
    return undefined;
  }
  const snapshot = asRecord(asRecord(asRecord(parsed)?.result)?.snapshot);
  if (!snapshot) return undefined;

  const pick = (listKey: string, idKey: string, id: string | undefined): Rec | undefined => {
    const list = snapshot[listKey];
    if (!Array.isArray(list)) return undefined;
    return list.map(asRecord).find((entry) => entry?.[idKey] === id);
  };
  const ws = pick("workspaces", "workspace_id", wsId);
  const tab = pick("tabs", "tab_id", tabId);
  const pane = pick("panes", "pane_id", paneId);
  return {
    focused: snapshot.focused_workspace_id === wsId && snapshot.focused_pane_id === paneId,
    subtitle: [
      "Ghostty",
      asString(ws?.label) ?? wsId,
      asString(tab?.label) ?? tabId,
      asString(pane?.label) ?? paneId?.split(":")[1],
      asString(pane?.agent) ?? "omp",
    ].join(" / "),
  };
}

async function notify(kind: "done" | "attention", title: string, message: string): Promise<void> {
  const bundle = terminalBundle();
  const front = await terminalFrontmost(bundle);
  const paneId = process.env.HERDR_PANE_ID;

  let subtitle: string;
  let group: string;
  if (paneId) {
    const loc = await herdrLocation();
    if (!loc) return;
    // The user is already looking at this pane; a notification would be noise.
    // On Linux herdr's focus flag is the only signal available, so it decides
    // alone; on macOS it is paired with the frontmost check because herdr pane
    // focus persists while Ghostty itself is in the background.
    if (loc.focused && (front || !IS_DARWIN)) return;
    subtitle = loc.subtitle;
    group = `omp-notify-${paneId}`;
  } else {
    // No pane-focus signal outside herdr: a completion toast on every turn
    // while the user is watching would be noise, so it fires only when the
    // terminal app is in the background. Attention events always fire.
    // Linux has no frontmost signal either, so "done" is dropped entirely
    // rather than fired on every turn — the same trade-off the fallback path
    // of claude/hooks/herdr-notify.sh already makes.
    if (kind === "done" && (front || !IS_DARWIN)) return;
    const base = process.cwd().split("/").pop() || "?";
    subtitle = base;
    group = `omp-notify-fallback-${base}`;
  }

  if (IS_DARWIN) {
    await run(TERMINAL_NOTIFIER, [
      "-group", group,
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-activate", bundle,
    ]);
  } else {
    // notify-send has no subtitle field, so the location line joins the body.
    // The synchronous hint is the freedesktop equivalent of -group: a newer
    // toast from the same pane replaces the previous one instead of stacking.
    await run("notify-send", [
      "--app-name=omp",
      `--hint=string:x-canonical-private-synchronous:${group}`,
      title,
      `${subtitle}\n${message}`,
    ]);
  }
}

function assistantMessages(event: unknown): Rec[] {
  const messages = asRecord(event)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.map(asRecord).filter((message): message is Rec => message !== undefined);
}

function lastAssistant(messages: Rec[]): Rec | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

function assistantText(messages: Rec[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map(asRecord)
      .filter((chunk) => chunk?.type === "text")
      .map((chunk) => asString(chunk?.text) ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 120);
  }
  return "";
}

function askQuestion(args: unknown): string {
  const questions = asRecord(args)?.questions;
  if (!Array.isArray(questions)) return "";
  for (const entry of questions) {
    const question = asString(asRecord(entry)?.question);
    if (question) return question;
  }
  return "";
}

type Ctx = {
  hasUI?: boolean;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
};

type ExtensionHandlerApi = {
  on(event: string, handler: (event: unknown, ctx: Ctx | undefined) => void): void;
};

export default function (pi: ExtensionHandlerApi): void {
  if (process.platform !== "darwin") return;

  // Only the interactive root session notifies; headless/subagent sessions
  // (hasUI false) stay silent.
  let rootSession = false;
  let agentActive = false;

  function activate(ctx: Ctx | undefined): boolean {
    if (rootSession) return true;
    if (ctx?.hasUI !== true) return false;
    rootSession = true;
    return true;
  }

  pi.on("session_start", (_event, ctx) => {
    if (!activate(ctx)) return;
    // A reload can replace this extension mid-run without another agent_start.
    agentActive = ctx?.isIdle?.() === false;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!activate(ctx)) return;
    agentActive = true;
  });

  pi.on("agent_end", (event, ctx) => {
    if (!rootSession || !agentActive) return;
    agentActive = false;

    // A queued follow-up starts the next turn immediately; not a real stop.
    if (ctx?.hasPendingMessages?.() === true) return;

    const messages = assistantMessages(event);
    const assistant = lastAssistant(messages);
    if (assistant?.stopReason === "error") {
      const errorMessage = asString(assistant.errorMessage) ?? "";
      // Auto-retry re-runs the turn; notifying here would be a false stop.
      if (retryableErrorPattern.test(errorMessage)) return;
      void notify("attention", "OMP エラー停止", (errorMessage || "エラーで停止しました").slice(0, 120));
      return;
    }

    void notify("done", "OMP 作業完了", assistantText(messages) || "作業が完了しました");
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const detail = asRecord(event);
    if (detail?.toolName !== "ask") return;
    if (!activate(ctx)) return;
    void notify("attention", "OMP 入力待ち", askQuestion(detail.args) || "質問への回答が必要です");
  });

  pi.on("tool_approval_requested", (event, ctx) => {
    if (!activate(ctx)) return;
    const detail = asRecord(event);
    const message =
      asString(detail?.reason) ?? `${asString(detail?.toolName) ?? "ツール"} の実行許可が必要です`;
    void notify("attention", "OMP 許可待ち", message.slice(0, 120));
  });
}
