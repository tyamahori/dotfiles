import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/worktree-copy-guard.ts");
let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { force: true, recursive: true });
  home = undefined;
});

// Stands in for scripts/worktree-copy-hook: records the hook payload it was
// given and answers with the Claude-style additionalContext it would emit.
function fixtureHome(): { home: string; payload: string } {
  home = mkdtempSync(join(tmpdir(), "omp-worktree-guard-"));
  const scripts = join(home, "dotfiles/scripts");
  mkdirSync(scripts, { recursive: true });
  const payload = join(home, "payload.json");
  const hook = join(scripts, "worktree-copy-hook");
  writeFileSync(
    hook,
    `#!/bin/bash\ncat >"${payload}"\necho '{"hookSpecificOutput":{"additionalContext":"copied 2 files"}}'\n`,
  );
  chmodSync(hook, 0o755);
  return { home, payload };
}

// The guard resolves the hook from homedir() at load time, which Bun only
// takes from the HOME the process started with.
function notificationsAfter(event: { toolName: string; command: string; cwd?: string; isError?: boolean }): string[] {
  const driver = `
    const { default: install } = await import(${JSON.stringify(extension)});
    const notes = [];
    let handler;
    install({ on: (name, fn) => { if (name === "tool_result") handler = fn; } });
    handler(
      { toolName: ${JSON.stringify(event.toolName)}, input: { command: ${JSON.stringify(event.command)}, cwd: ${JSON.stringify(event.cwd ?? null)} ?? undefined }, isError: ${event.isError ?? false} },
      { cwd: "/work/repo", ui: { notify: (message) => notes.push(message) } },
    );
    console.log(JSON.stringify(notes));
  `;
  const result = Bun.spawnSync(["bun", "-e", driver], { env: { ...process.env, HOME: home! } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test("a successful raw worktree add runs the copy hook with the session cwd and relays its note", () => {
  const { payload } = fixtureHome();
  const command = "git -C repo worktree add ../wt -b topic";

  expect(notificationsAfter({ toolName: "bash", command })).toEqual(["copied 2 files"]);
  expect(JSON.parse(readFileSync(payload, "utf8"))).toEqual({ cwd: "/work/repo", tool_input: { command } });
});

test("the bash call's own cwd, resolved against the session cwd, is what the hook inspects", () => {
  const { payload } = fixtureHome();
  const command = "git worktree add ../wt -b topic";

  notificationsAfter({ toolName: "bash", command, cwd: "../other" });
  expect(JSON.parse(readFileSync(payload, "utf8")).cwd).toBe("/work/other");
});

test("failed adds, other worktree subcommands, and other tools do not run the hook", () => {
  const { payload } = fixtureHome();
  for (const event of [
    { toolName: "bash", command: "git worktree add ../wt", isError: true },
    { toolName: "bash", command: "git worktree list" },
    { toolName: "bash", command: "git worktree addendum" },
    { toolName: "read", command: "git worktree add ../wt" },
  ]) {
    expect(notificationsAfter(event)).toEqual([]);
  }
  expect(existsSync(payload)).toBe(false);
});

// The real hook, with HOME pointed at a temp dir whose dotfiles/scripts is this
// checkout's scripts/. Returns the sweep's context and whether wt got the file.
function realHook(command: string, cwdOf: (repo: string) => string): { context: string; copied: boolean } {
  if (home) rmSync(home, { force: true, recursive: true });
  home = mkdtempSync(join(tmpdir(), "omp-worktree-hook-"));
  mkdirSync(join(home, "dotfiles"));
  symlinkSync(join(import.meta.dir, "../../scripts"), join(home, "dotfiles/scripts"));
  const repo = join(home, "work/repo");
  const wt = join(home, "wt");
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  git("add", ".gitignore", ".worktreeinclude");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", wt);
  const result = Bun.spawnSync([join(import.meta.dir, "../../scripts/worktree-copy-hook")], {
    env,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: cwdOf(repo), tool_input: { command } })),
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return { context: result.stdout.toString(), copied: existsSync(join(wt, ".env")) };
}

test("git -C with an unexpanded $PWD or ~ still sweeps the real repository", () => {
  expect(realHook('git -C "$PWD" worktree add ../wt', (repo) => repo).copied).toBe(true);
  expect(realHook("git -C ~/work/repo worktree add ../wt", () => tmpdir()).copied).toBe(true);
});

test("a worktree add inside a command over 64KB still sweeps", () => {
  const command = `git worktree add ../wt\n${"# padding\n".repeat(20_000)}`;
  expect(realHook(command, (repo) => repo).copied).toBe(true);
});
