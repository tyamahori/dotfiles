// Report the just-submitted prompt as the herdr pane title, mirroring
// scripts/herdr-title (Claude Code / Codex run it on UserPromptSubmit).
// `pane report-metadata` is display-only, so the herdr-managed
// herdr-omp-agent-state.ts keeps lifecycle and session-restore authority;
// herdr docs require user hooks beside managed integrations to use it.

import { execFile } from "node:child_process";

const paneId = process.env.HERDR_PANE_ID;
// Panes created by older herdr servers lack HERDR_BIN_PATH; fall back to PATH.
const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

type Ctx = { hasUI?: boolean };

type ExtensionHandlerApi = {
  on(event: string, handler: (event: unknown, ctx: Ctx | undefined) => void): void;
};

export default function (pi: ExtensionHandlerApi): void {
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  // `input` fires only for interactive input, and only the root session
  // owns the pane title; headless/subagent sessions (hasUI false) stay out.
  pi.on("input", (event, ctx) => {
    if (ctx?.hasUI !== true) return;
    // Payload: { type: "input", text, images, source }.
    const text = (event as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") return;
    // Codepoint-safe truncation ([...s] splits by codepoint, not UTF-16 unit).
    const title = [...text.replace(/\s+/g, " ").trim()].slice(0, 60).join("");
    if (!title || title.startsWith("/")) return; // slash commands are not tasks
    execFile(
      herdrBin,
      [
        "pane",
        "report-metadata",
        paneId as string,
        "--source",
        "user:omp-title",
        "--agent",
        "omp",
        "--title",
        title,
        "--ttl-ms",
        "3600000",
      ],
      () => {},
    );
  });
}
