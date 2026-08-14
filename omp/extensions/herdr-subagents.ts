// Report the number of running task subagents as the `subagents` pane
// metadata token, displayed via [ui.sidebar.agents] rows ("$subagents") in
// herdr/config.toml. Subagents run in-process without a PTY, so herdr cannot
// see them as agents; a display-only token is the sanctioned side channel
// (same rationale as herdr-title.ts). Claude Code's counterpart is
// claude/hooks/herdr-subagents.sh.
//
// The task tool returns immediately (subagents are background jobs), so
// tool_execution_start/end on the root session cannot measure their
// lifetime. Instead this extension loads into every session — subagent
// sessions have ctx.hasUI false — and each subagent session marks its own
// lifetime with a marker file; the count is the number of markers. The
// marker directory is keyed by pane and pid, so a crashed omp process
// orphans its directory instead of corrupting the next session's count,
// and the token TTL clears the stale display.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const paneId = process.env.HERDR_PANE_ID;
// Panes created by older herdr servers lack HERDR_BIN_PATH; fall back to PATH.
const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
const markerDir = path.join(
  tmpdir(),
  `herdr-subagents-omp-${(paneId ?? "").replace(/[^A-Za-z0-9]/g, "_")}-${process.pid}`,
);

function report(): void {
  let count = 0;
  try {
    count = readdirSync(markerDir).length;
  } catch {
    // Directory not created yet or already removed: count stays 0.
  }
  const flag = count > 0 ? ["--token", `subagents=${count}`] : ["--clear-token", "subagents"];
  execFile(
    herdrBin,
    [
      "pane",
      "report-metadata",
      paneId as string,
      "--source",
      "user:omp-subagents",
      "--agent",
      "omp",
      ...flag,
      // Concurrent subagent sessions report from one process; a monotonic
      // sequence lets herdr drop out-of-order reports.
      "--seq",
      String(process.hrtime.bigint()),
      // Backstop against a crashed process leaving a stale count; every
      // change refreshes the TTL.
      "--ttl-ms",
      "21600000",
    ],
    () => {},
  );
}

type Ctx = { hasUI?: boolean };

type ExtensionHandlerApi = {
  on(event: string, handler: (event: unknown, ctx: Ctx | undefined) => void): void;
};

export default function (pi: ExtensionHandlerApi): void {
  if (process.env.HERDR_ENV !== "1" || !paneId) return;

  let isRoot = false;
  let marker: string | undefined;

  function addMarker(): void {
    if (isRoot || marker) return;
    marker = path.join(markerDir, randomUUID());
    try {
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(marker, "");
    } catch {
      marker = undefined;
      return;
    }
    report();
  }

  function removeMarker(): void {
    if (!marker) return;
    rmSync(marker, { force: true });
    marker = undefined;
    report();
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx?.hasUI === true) isRoot = true;
  });

  // Subagent sessions emit no per-session shutdown event; their agent loop
  // is the observable lifetime, so mark from agent_start to agent_end.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx?.hasUI === true) {
      isRoot = true;
      return;
    }
    addMarker();
  });

  pi.on("agent_end", () => {
    removeMarker();
  });

  pi.on("session_shutdown", () => {
    if (isRoot) {
      // Root exit ends every in-process subagent with it.
      rmSync(markerDir, { recursive: true, force: true });
      report();
      return;
    }
    removeMarker();
  });
}
