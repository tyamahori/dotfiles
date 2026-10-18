import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checks = resolve(import.meta.dir, "../git/global-hooks/checks");
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

// A sandbox HOME keeps the machine's global hooks and identity out of the fixtures.
function sh(cwd: string, command: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["/bin/bash", "-c", command], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir!, GIT_CONFIG_NOSYSTEM: "1", ...env },
    stdin: "ignore",
  });
  return { status: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

test("commit-msg-why reads a body on a last line without a trailing newline", () => {
  dir = mkdtempSync(join(tmpdir(), "global-hooks-"));
  sh(dir, "git init -q && seq 20 > big && git add big");
  writeFileSync(join(dir, "msg"), "subject\n\nbody why");
  expect(sh(dir, `${checks}/commit-msg-why msg`).status).toBe(0);
  writeFileSync(join(dir, "msg"), "subject");
  expect(sh(dir, `${checks}/commit-msg-why msg`).status).toBe(1);
});
