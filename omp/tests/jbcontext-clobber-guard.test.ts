import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/jbcontext-clobber-guard.ts");
let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { force: true, recursive: true });
  home = undefined;
});

function git(repo: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

// ~/dotfiles with every watched file committed, plus one file the guard ignores.
function fixtureRepo(): string {
  home = mkdtempSync(join(tmpdir(), "omp-jbcontext-guard-"));
  const repo = join(home, "dotfiles");
  for (const file of ["agents/global-instructions.md", "claude/settings.json", "codex/hooks.json", "README.md"]) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), "original\n");
  }
  git(repo, "init", "-q");
  git(repo, "add", "--", "agents", "claude", "codex", "README.md");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

// The guard resolves ~/dotfiles from homedir() at load time, which Bun only
// takes from the HOME the process started with.
function sessionStartNotifications(hasUI: boolean): string[] {
  const driver = `
    const { default: install } = await import(${JSON.stringify(extension)});
    const notes = [];
    let handler;
    install({ on: (event, fn) => { if (event === "session_start") handler = fn; } });
    const ctx = { hasUI: ${hasUI}, ui: { notify: (message) => notes.push(message) } };
    handler({}, ctx);
    handler({}, ctx);
    console.log(JSON.stringify(notes));
  `;
  const result = Bun.spawnSync(["bun", "-e", driver], { env: { ...process.env, HOME: home! } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test("warns once about uncommitted edits to watched agent files only", () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "claude/settings.json"), "rewritten by an updater\n");
  writeFileSync(join(repo, "README.md"), "ordinary edit\n");

  const notes = sessionStartNotifications(true);

  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("claude/settings.json");
  expect(notes[0]).not.toContain("README.md");
});

test("stays silent when the watched files are clean or the session has no UI", () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "README.md"), "ordinary edit\n");
  expect(sessionStartNotifications(true)).toEqual([]);

  writeFileSync(join(repo, "codex/hooks.json"), "rewritten\n");
  expect(sessionStartNotifications(false)).toEqual([]);
});
