import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("pre-commit-json needs jq only when JSON is staged", () => {
  dir = mkdtempSync(join(tmpdir(), "global-hooks-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["git", "mktemp", "rm"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
  sh(dir, "git init -q && echo hi > plain.txt && git add plain.txt");
  expect(sh(dir, `${checks}/pre-commit-json`, { PATH: bin }).status).toBe(0);
  sh(dir, "echo '{}' > a.json && git add a.json");
  const blocked = sh(dir, `${checks}/pre-commit-json`, { PATH: bin });
  expect(blocked.out).toContain("jq is required");
  expect(blocked.status).toBe(1);
});

test("pre-commit-json skips JSONC config files that allow comments", () => {
  dir = mkdtempSync(join(tmpdir(), "global-hooks-"));
  sh(dir, "git init -q");
  for (const name of [".devcontainer.json", "biome.json", "app/turbo.json", ".eslintrc.json"]) {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, name), '// comment\n{"a": 1}\n');
  }
  sh(dir, "git add -A");
  expect(sh(dir, `${checks}/pre-commit-json`).status).toBe(0);
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

// git/hooks/pre-commit is this repo's own hook; run a copy whose global hand-off is stubbed.
test.each([
  ["the last pattern of a patterns file without a trailing newline", "secretproject\nother", "mentions other thing\n"],
  ["an added line that starts with ++", "secretproject\n", "++ secretproject\n"],
])("dotfiles pre-commit blocks %s", (_case, patterns, added) => {
  dir = mkdtempSync(join(tmpdir(), "global-hooks-"));
  mkdirSync(join(dir, "git/hooks"), { recursive: true });
  mkdirSync(join(dir, "git/global-hooks"));
  writeFileSync(join(dir, "git/hooks/pre-commit"), readFileSync(resolve(checks, "../../hooks/pre-commit")));
  writeFileSync(join(dir, "git/global-hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "git/hooks/pre-commit"), 0o755);
  chmodSync(join(dir, "git/global-hooks/pre-commit"), 0o755);
  writeFileSync(join(dir, "git/sensitive-patterns.local"), patterns);
  writeFileSync(join(dir, "notes.md"), added);
  sh(dir, "git init -q && git add notes.md");

  const r = sh(dir, "git/hooks/pre-commit");
  expect(r.out).toContain("machine-local pattern");
  expect(r.status).toBe(1);
});
