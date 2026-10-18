import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, "agents/skills/x/.openskills.json"), JSON.stringify({ repoUrl: join(dir, "missing"), commit: "abc" }));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });

  const result = Bun.spawnSync([join(dir, "scripts/skill-sync"), "--check"], { cwd: dir });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("skill-sync: x: could not read HEAD");
});
