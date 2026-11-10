import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "fail-fast-hook");
const dir = mkdtempSync(join(tmpdir(), "fail-fast-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Reports one Bash result the way Claude Code does; true when the hook tells the agent to stop.
function report(
  session: string,
  event: "PostToolUse" | "PostToolUseFailure",
  command: string,
  { interrupted = false, path = process.env.PATH ?? "/usr/bin:/bin" } = {},
) {
  const payload = {
    hook_event_name: event,
    tool_name: "Bash",
    session_id: session,
    tool_input: { command },
    is_interrupt: interrupted,
  };
  const r = Bun.spawnSync([hook], {
    env: { PATH: path, XDG_CACHE_HOME: join(dir, "cache") },
    stdin: Buffer.from(JSON.stringify(payload)),
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().includes('"decision": "block"');
}

test("the second identical failure in a row tells the agent to stop, the first does not", () => {
  expect(report("s1", "PostToolUseFailure", "make test")).toBe(false);
  expect(report("s1", "PostToolUseFailure", "make test")).toBe(true);
  // Another command, or the same command in another session, has its own count.
  expect(report("s1", "PostToolUseFailure", "make lint")).toBe(false);
  expect(report("s2", "PostToolUseFailure", "make test")).toBe(false);
});

test("a success between two failures of the same command starts the count again", () => {
  expect(report("s3", "PostToolUseFailure", "make test")).toBe(false);
  expect(report("s3", "PostToolUse", "make test")).toBe(false);
  expect(report("s3", "PostToolUseFailure", "make test")).toBe(false);
});

test("a command the user interrupted is not counted as a failure", () => {
  expect(report("s4", "PostToolUseFailure", "make test", { interrupted: true })).toBe(false);
  expect(report("s4", "PostToolUseFailure", "make test")).toBe(false);
});

const tools = ["bash", "cat", "jq", "mkdir", "rm", "cut", "shasum", "sha256sum"].map((t) => [t, Bun.which(t)] as const);

test.skipIf(tools.some(([, at]) => !at))("failures count the same with sha256sum and with shasum alone", () => {
  const bins = (name: string, without: string[]) => {
    const bin = join(dir, name);
    mkdirSync(bin);
    for (const [tool, at] of tools) if (!without.includes(tool)) symlinkSync(at!, join(bin, tool));
    return bin;
  };
  expect(report("s5", "PostToolUseFailure", "make test", { path: bins("with-sha256sum", []) })).toBe(false);
  expect(report("s5", "PostToolUseFailure", "make test", { path: bins("shasum-only", ["sha256sum"]) })).toBe(true);
});
