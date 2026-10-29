import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/herdr-subagents.ts");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

// Runs one omp process whose single subagent session starts and ends, and
// returns the herdr calls it made. pane/env are read at import, so each run
// needs its own process.
function runSubagentProcess(extraEnv: Record<string, string> = {}): string[] {
  root ??= mkdtempSync(join(tmpdir(), "omp-herdr-subagents-"));
  const log = join(root, "herdr.log");
  const herdr = join(root, "herdr");
  writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(herdr, 0o755);
  const before = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  const driver = `
    const { default: install } = await import(${JSON.stringify(extension)});
    const handlers = {};
    install({ on: (event, fn) => { handlers[event] = fn; } });
    handlers.session_start?.({}, { hasUI: false });
    handlers.agent_start?.({}, { hasUI: false });
    handlers.agent_end?.({}, { hasUI: false });
  `;
  Bun.spawnSync([process.execPath, "-e", driver], {
    env: {
      PATH: "/usr/bin:/bin",
      TMPDIR: root,
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:1",
      HERDR_BIN_PATH: herdr,
      ...extraEnv,
    },
  });
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).slice(before) : [];
}

function seqs(calls: string[]): number[] {
  return calls.map((call) => Number(/--seq (\d+)/.exec(call)?.[1]));
}

test("a restarted omp in the same pane reports above the previous process's sequence", () => {
  const first = runSubagentProcess();
  const second = runSubagentProcess();
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  // herdr drops any report whose seq is not above the last one it accepted
  // for this pane and source, even after a clear.
  expect(Math.min(...seqs(second))).toBeGreaterThan(Math.max(...seqs(first)));
});

test("a nested omp launched from a parent's shell leaves the parent's count alone", () => {
  expect(runSubagentProcess({ OMPCODE: "1" })).toEqual([]);
});
