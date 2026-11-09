import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lintOnEdit, { hookTimingDir } from "../extensions/lint-on-edit";

type Hook = (event: unknown, ctx: unknown) => void;
type TimingRecord = Record<string, unknown>;

function hookResult(stdout = "", status: number | null = 0, error?: Error): SpawnSyncReturns<string> {
  return { stdout, stderr: "", status, error } as SpawnSyncReturns<string>;
}

const FINDINGS = '{"decision":"block","reason":"fix lint"}';

let state: string;
let spawn: Mock<typeof childProcess.spawnSync>;
const savedEnv = { timing: process.env.AGENT_HOOK_TIMING, xdg: process.env.XDG_STATE_HOME };

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "lint-timing-"));
  process.env.AGENT_HOOK_TIMING = "1";
  process.env.XDG_STATE_HOME = state;
  spawn = spyOn(childProcess, "spawnSync");
});

afterEach(() => {
  spawn.mockRestore();
  restoreEnv("AGENT_HOOK_TIMING", savedEnv.timing);
  restoreEnv("XDG_STATE_HOME", savedEnv.xdg);
  rmSync(state, { recursive: true, force: true });
});

function extension() {
  let handler: Hook | undefined;
  const messages: string[] = [];
  lintOnEdit({
    on(_event: string, registered: Hook) {
      handler = registered;
    },
    sendUserMessage(content: string) {
      messages.push(content);
    },
  } as never);
  return {
    messages,
    edit(path = "src/file.ts") {
      handler?.({ toolName: "write", input: { path } }, { cwd: "/project" });
    },
    patch(input: string) {
      handler?.({ toolName: "edit", input }, { cwd: "/project" });
    },
  };
}

const hooksDir = () => join(state, "agent-eval/hooks");

function timingFiles(): string[] {
  return existsSync(hooksDir()) ? readdirSync(hooksDir()).map((name) => join(hooksDir(), name)) : [];
}

function records(): TimingRecord[] {
  return timingFiles().flatMap((file) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TimingRecord),
  );
}

test("records the duration of the lint run and a findings outcome, and still steers", () => {
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  spawn.mockImplementation((() => {
    now += 42;
    return hookResult(FINDINGS);
  }) as never);
  const ext = extension();

  ext.edit();
  clock.mockRestore();

  expect(ext.messages).toEqual(["[lint-on-edit] fix lint"]);
  const [record] = records();
  expect(Object.keys(record).sort()).toEqual(["elapsedMs", "hook", "outcome", "schemaVersion", "timestamp"]);
  expect(record).toMatchObject({ schemaVersion: 1, hook: "lint-on-edit", elapsedMs: 42, outcome: "findings" });
  expect(Number.isNaN(Date.parse(record.timestamp as string))).toBe(false);
});

test.each([
  ["no output", hookResult(""), "clean"],
  ["only whitespace", hookResult(" \n"), "clean"],
  ["a nonzero exit, even with findings on stdout", hookResult(FINDINGS, 1), "error"],
  ["a killed process", hookResult("", null), "error"],
  ["a launch failure or timeout", hookResult("", null, new Error("spawnSync ETIMEDOUT")), "error"],
  ["output that is not JSON", hookResult("not json"), "error"],
  ["JSON that is not a decision", hookResult("null"), "error"],
  ["a block decision without a usable reason", hookResult('{"decision":"block","reason":1}'), "error"],
] as const)("records an honest outcome and does not steer for %s", (_name, result, want) => {
  spawn.mockReturnValue(result);
  const ext = extension();

  ext.edit();

  expect(ext.messages).toEqual([]);
  expect(records()).toMatchObject([{ outcome: want }]);
});

test.each([["unset"], ["0"], [""], ["true"]])("creates no timing file when the switch is %j", (value) => {
  if (value === "unset") delete process.env.AGENT_HOOK_TIMING;
  else process.env.AGENT_HOOK_TIMING = value;
  spawn.mockReturnValue(hookResult(FINDINGS));
  const ext = extension();

  ext.edit();

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(ext.messages).toEqual(["[lint-on-edit] fix lint"]);
  expect(existsSync(join(state, "agent-eval"))).toBe(false);
});

test("keeps steering when the timing destination cannot be written", () => {
  const notADirectory = join(state, "regular-file");
  writeFileSync(notADirectory, "");
  process.env.XDG_STATE_HOME = notADirectory;
  spawn.mockReturnValue(hookResult(FINDINGS));
  const ext = extension();

  ext.edit("first.ts");
  ext.edit("second.ts");

  expect(ext.messages).toEqual(["[lint-on-edit] fix lint", "[lint-on-edit] fix lint"]);
  expect(spawn).toHaveBeenCalledTimes(2);
});

test("keeps the file private and free of paths, findings and the lint input", () => {
  const secret = "SECRET-FINDING-TEXT";
  spawn.mockReturnValue(hookResult(`{"decision":"block","reason":"${secret}"}`));
  const ext = extension();

  ext.edit("private/customer-name.ts");

  const [file] = timingFiles();
  const raw = readFileSync(file, "utf8");
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("customer-name");
  expect(raw).not.toContain("/project");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(hooksDir()).mode & 0o777).toBe(0o700);
});

test("gives each extension instance its own file", () => {
  spawn.mockReturnValue(hookResult());
  const first = extension();
  const second = extension();

  first.edit();
  second.edit();
  first.edit();

  expect(timingFiles()).toHaveLength(2);
  expect(records()).toHaveLength(3);
});

test("stops appending at the per-run record limit without stopping the lint", () => {
  spawn.mockReturnValue(hookResult());
  const ext = extension();

  for (let i = 0; i < 10_002; i++) ext.edit();

  expect(spawn).toHaveBeenCalledTimes(10_002);
  expect(readFileSync(timingFiles()[0], "utf8").trim().split("\n")).toHaveLength(10_000);
}, 30_000);

test("lints a file once per patch and again on the next edit, with one record per run", () => {
  spawn.mockReturnValue(hookResult());
  const ext = extension();

  ext.patch("[same.ts#ABCD]\n[same.ts#ABCD]");
  ext.edit("same.ts");

  expect(spawn).toHaveBeenCalledTimes(2);
  expect(records()).toHaveLength(2);
});

test.each([
  ["no XDG_STATE_HOME", {}, "/home/me/.local/state/agent-eval/hooks"],
  ["an empty XDG_STATE_HOME", { XDG_STATE_HOME: "" }, "/home/me/.local/state/agent-eval/hooks"],
  ["an absolute XDG_STATE_HOME", { XDG_STATE_HOME: "/state" }, "/state/agent-eval/hooks"],
  ["a relative XDG_STATE_HOME", { XDG_STATE_HOME: "state" }, "/home/me/.local/state/agent-eval/hooks"],
])("chooses the timing directory for %s", (_name, env, want) => {
  expect(hookTimingDir(env, "/home/me")).toBe(want);
});
