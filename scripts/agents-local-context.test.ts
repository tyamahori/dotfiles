import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agents-local-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const repo = (name: string) => {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "sub"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};
const run = (cwd: string) => {
  const r = Bun.spawnSync([resolve(import.meta.dir, "agents-local-context")], {
    stdin: Buffer.from(JSON.stringify({ cwd })),
  });
  return { code: r.exitCode, out: r.stdout.toString() };
};

test("prints the repo-root rules when the session starts in a subdirectory", () => {
  const dir = repo("plain");
  writeFileSync(join(dir, "AGENTS.local.md"), "Use pnpm.\n");
  const { code, out } = run(join(dir, "sub"));
  expect(code).toBe(0);
  expect(out).toContain("Use pnpm.");
});

test("prints the primary checkout's rules inside a linked worktree", () => {
  const dir = repo("main");
  writeFileSync(join(dir, "AGENTS.local.md"), "Answer in Japanese.\n");
  const wt = join(tmp, "wt");
  git(dir, "worktree", "add", "-q", "--detach", wt);
  expect(run(wt).out).toContain("Answer in Japanese.");
});

test.each([
  ["no rules file", "none", null],
  ["an empty rules file", "empty", ""],
])("prints nothing with %s", (_name, dirName, content) => {
  const dir = repo(dirName);
  if (content !== null) writeFileSync(join(dir, "AGENTS.local.md"), content);
  expect(run(dir)).toEqual({ code: 0, out: "" });
});

test("prints nothing outside a git repository", () => {
  const dir = join(tmp, "nogit");
  mkdirSync(dir);
  writeFileSync(join(dir, "AGENTS.local.md"), "ignored\n");
  expect(run(dir)).toEqual({ code: 0, out: "" });
});
