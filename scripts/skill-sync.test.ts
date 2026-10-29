import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "skill-sync");
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test("an unreachable upstream reports exit 2 instead of dying with git's code", () => {
  dir = mkdtempSync(join(tmpdir(), "skill-sync-"));
  // The script resolves the repo root from its own location, so run a copy.
  mkdirSync(join(dir, "scripts"));
  cpSync(script, join(dir, "scripts/skill-sync"));
  mkdirSync(join(dir, "agents/skills/x"), { recursive: true });
  writeFileSync(
    join(dir, "agents/skills/x/.openskills.json"),
    JSON.stringify({ repoUrl: join(dir, "missing"), commit: "abc" }),
  );
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });

  const result = Bun.spawnSync([join(dir, "scripts/skill-sync"), "--check"], { cwd: dir });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("skill-sync: x: could not read HEAD");
});

test("--apply of a whole-repo skill (subpath .) does not vendor the upstream .git", () => {
  dir = mkdtempSync(join(tmpdir(), "skill-sync-"));
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
    });
  const upstream = join(dir, "up");
  mkdirSync(upstream);
  writeFileSync(join(upstream, "SKILL.md"), "# x\n");
  git(upstream, "init", "-q");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "x");
  mkdirSync(join(dir, "scripts"));
  cpSync(script, join(dir, "scripts/skill-sync"));
  const skill = join(dir, "agents/skills/x");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, ".openskills.json"), JSON.stringify({ repoUrl: upstream, subpath: ".", commit: "old" }));
  git(dir, "init", "-q");
  // jaq only records the new commit in the marker, which this test does not read.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "jaq"), "#!/bin/sh\n");
  chmodSync(join(bin, "jaq"), 0o755);

  const result = Bun.spawnSync([join(dir, "scripts/skill-sync"), "--apply"], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  expect(existsSync(join(skill, ".git"))).toBe(false);
});
