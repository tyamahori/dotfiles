import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("pre-push-base-freshness blocks a stale fork in a single-branch clone", () => {
  dir = mkdtempSync(join(tmpdir(), "global-hooks-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // The open PR declares feature-a as the base.
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho feature-a\n");
  chmodSync(join(bin, "gh"), 0o755);
  const git = "git -c user.name=t -c user.email=t@example.com";
  sh(dir, `git init -q --bare -b main remote.git && git clone -q remote.git seed 2>/dev/null && cd seed &&
    ${git} commit -q --allow-empty -m root && git push -q origin main &&
    git switch -q -c feature-a && ${git} commit -q --allow-empty -m a1 && git push -q origin feature-a`);
  sh(dir, "git clone -q --single-branch --branch main remote.git work && cd work && git fetch -q origin feature-a && git switch -q -c stacked FETCH_HEAD");
  sh(join(dir, "seed"), `${git} commit -q --allow-empty -m a2 && git push -q origin feature-a`);

  const sha = sh(join(dir, "work"), "git rev-parse HEAD").out.trim();
  const push = sh(
    join(dir, "work"),
    `printf 'refs/heads/stacked %s refs/heads/stacked %s\\n' ${sha} ${"0".repeat(40)} | ${checks}/pre-push-base-freshness origin`,
    { PATH: `${bin}:${process.env.PATH}` },
  );
  expect(push.out).toContain("forked from 'feature-a' before its current tip");
  expect(push.status).toBe(1);
});
