import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import denyCommands from "../extensions/deny-commands";
import japaneseProse from "../extensions/japanese-prose";
import lintOnEdit, { editedPaths } from "../extensions/lint-on-edit";

type Hook = (...args: unknown[]) => unknown;

type CapturedExtension = {
  api: {
    on(event: string, handler: Hook): void;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  };
  hooks: Map<string, Hook>;
  messages: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }>;
};

function capturedExtension(): CapturedExtension {
  const hooks = new Map<string, Hook>();
  const messages: CapturedExtension["messages"] = [];
  return {
    api: {
      on(event, handler) { hooks.set(event, handler); },
      sendUserMessage(content, options) { messages.push({ content, options }); },
    },
    hooks,
    messages,
  };
}

function hookResult(
  stdout = "",
  status = 0,
  stderr = "",
  error?: Error,
): SpawnSyncReturns<string> {
  return { stdout, stderr, status, error } as SpawnSyncReturns<string>;
}

let spawn: Mock<typeof childProcess.spawnSync>;
let which: Mock<typeof Bun.which>;

beforeEach(() => {
  spawn = spyOn(childProcess, "spawnSync");
  which = spyOn(Bun, "which");
});

afterEach(() => {
  spawn.mockRestore();
  which.mockRestore();
});

test("keeps write nullish precedence and ignores non-local paths", () => {
  expect(editedPaths({
    toolName: "write",
    input: { path: "preferred.ts", file_path: "fallback.ts" },
  })).toEqual(["preferred.ts"]);
  expect(editedPaths({
    toolName: "write",
    input: { path: null, file_path: "fallback.ts" },
  })).toEqual(["fallback.ts"]);
  expect(editedPaths({
    toolName: "write",
    input: { path: "", file_path: "fallback.ts" },
  })).toEqual([""]);
  expect(editedPaths({
    toolName: "write",
    input: { path: "memory://scratch/file.ts" },
  })).toEqual([]);
});

test("extracts edit sources and move targets in stable order", () => {
  expect(editedPaths({
    toolName: "edit",
    input: {
      input: "[source.ts#ABCD]\nMV 'destination.ts'\n[source.ts#ABCD]\nMV \"other file.ts\"\n[file.ts:20#BEEF]",
      patch: "[ignored.ts#1234]",
      command: "[also-ignored.ts#5678]",
    },
  })).toEqual(["source.ts", "destination.ts", "other file.ts"]);
});

test("extracts every apply_patch dialect and rejects malformed boundaries", () => {
  expect(editedPaths({
    toolName: "apply_patch",
    input: "*** Begin Patch\n*** Update File: src/existing.ts\n*** Add File: 'new file.ts'\n*** Delete File: deleted.ts\n*** Update File: file.ts:10\n*** Move to: \"renamed.ts\"\n*** End Patch",
  })).toEqual(["src/existing.ts", "new file.ts", "deleted.ts", "renamed.ts"]);
  expect(editedPaths({
    toolName: "edit",
    input: "[valid.ts#ABCD]\n[lowercase.ts#abcd]\n[trailing.ts#BEEF] extra\nMV \nMV https://example.com/file.ts",
  })).toEqual(["valid.ts"]);
});

test("uses string wrappers in input, patch, command order", () => {
  expect(editedPaths({
    toolName: "edit",
    input: { input: 1, patch: "[patch.ts#ABCD]", command: "[command.ts#BEEF]" },
  })).toEqual(["patch.ts"]);
  expect(editedPaths({
    toolName: "edit",
    input: { input: null, patch: false, command: "[command.ts#BEEF]" },
  })).toEqual(["command.ts"]);
});

test("steers only from a valid blocking lint result after a successful local edit", () => {
  spawn.mockReturnValue(hookResult('{"decision":"block","reason":"fix lint"}'));
  const extension = capturedExtension();
  lintOnEdit(extension.api as never);

  extension.hooks.get("tool_result")?.(
    { toolName: "write", input: { path: "src/file.ts" } },
    { cwd: "/project" },
  );

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(extension.messages).toEqual([
    { content: "[lint-on-edit] fix lint", options: { deliverAs: "steer" } },
  ]);
});

test("does not leave stale lint steering after failed or invalid hook results", () => {
  const extension = capturedExtension();
  lintOnEdit(extension.api as never);
  const result = extension.hooks.get("tool_result");

  result?.({ toolName: "write", input: { path: "src/file.ts" }, isError: true }, { cwd: "/project" });
  result?.({ toolName: "write", input: { path: "memory://scratch.ts" } }, { cwd: "/project" });
  spawn
    .mockReturnValueOnce(hookResult('{"decision":"block","reason":"keep this"}'))
    .mockReturnValueOnce(hookResult('{"decision":"block","reason":"ignored"}', 1))
    .mockReturnValueOnce(hookResult("not json"))
    .mockReturnValueOnce(hookResult('{"decision":"block","reason":1}'));
  result?.({ toolName: "write", input: { path: "good.ts" } }, { cwd: "/project" });
  result?.({ toolName: "write", input: { path: "first.ts" } }, { cwd: "/project" });
  result?.({ toolName: "write", input: { path: "second.ts" } }, { cwd: "/project" });
  result?.({ toolName: "write", input: { path: "third.ts" } }, { cwd: "/project" });

  expect(spawn).toHaveBeenCalledTimes(4);
  expect(extension.messages).toEqual([
    { content: "[lint-on-edit] keep this", options: { deliverAs: "steer" } },
  ]);
});

test("denies managed commands and allows harmless OMP bash input", async () => {
  which.mockReturnValue("/available/replacement");
  let handler: Hook | undefined;
  denyCommands({
    on(_event, registered) { handler = registered as Hook; },
  } as never);

  await expect(handler?.({ toolName: "bash", input: { command: "python3 app.py" } })).resolves.toMatchObject({ block: true });
  await expect(handler?.({ toolName: "bash", input: { command: "printf '%s' ok" } })).resolves.toBeUndefined();
  await expect(handler?.({ toolName: "read", input: { command: "python3 app.py" } })).resolves.toBeUndefined();
});

test("blocks a failed Japanese prose hook once, then recovers", () => {
  const extension = capturedExtension();
  japaneseProse(extension.api as never);
  spawn.mockReturnValue(hookResult("", 1, "hook failed"));

  extension.hooks.get("tool_call")?.(
    { toolName: "write", input: { path: "note.md" } },
    { cwd: "/project" },
  );
  const stop = extension.hooks.get("session_stop");
  expect(stop?.({}, { cwd: "/project" })).toMatchObject({ decision: "block" });
  expect(stop?.({}, { cwd: "/project" })).toBeUndefined();

  spawn.mockReturnValue(hookResult());
  expect(stop?.({}, { cwd: "/project" })).toBeUndefined();
});
