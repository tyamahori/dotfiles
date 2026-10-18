import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function notificationsAfter(event: { toolName: string; command: string; isError?: boolean }): string[] {
  const driver = `
    const { default: install } = await import(${JSON.stringify(extension)});
    const notes = [];
    let handler;
    install({ on: (name, fn) => { if (name === "tool_result") handler = fn; } });
    handler(
      { toolName: ${JSON.stringify(event.toolName)}, input: { command: ${JSON.stringify(event.command)} }, isError: ${event.isError ?? false} },
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
