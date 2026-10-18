import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/herdr-title.ts");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

// pane/env are read at import, so each run needs its own process.
function titleCalls(extraEnv: Record<string, string> = {}): string[] {
  root = mkdtempSync(join(tmpdir(), "omp-herdr-title-"));
  const log = join(root, "herdr.log");
  const herdr = join(root, "herdr");
  writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(herdr, 0o755);
  const driver = `
    const { default: install } = await import(${JSON.stringify(extension)});
    const handlers = {};
    install({ on: (event, fn) => { handlers[event] = fn; } });
    handlers.input?.({ type: "input", text: "fix the build" }, { hasUI: true });
  `;
  Bun.spawnSync([process.execPath, "-e", driver], {
    env: { PATH: "/usr/bin:/bin", HERDR_ENV: "1", HERDR_PANE_ID: "w1:1", HERDR_BIN_PATH: herdr, ...extraEnv },
  });
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

test("the pane's root omp reports the prompt as the title", () => {
  expect(titleCalls()).toEqual([
    "pane report-metadata w1:1 --source user:omp-title --agent omp --title fix the build --ttl-ms 3600000",
  ]);
});

test("a nested omp launched from a parent's shell leaves the parent's title alone", () => {
  expect(titleCalls({ OMPCODE: "1" })).toEqual([]);
});
