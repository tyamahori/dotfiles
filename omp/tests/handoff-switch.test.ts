import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import handoffSwitch from "../extensions/handoff-switch";

type ToolResult = {
  content: { type: string; text: string }[];
  details?: { path: string };
  isError?: boolean;
};
type Tool = {
  execute: (...args: unknown[]) => Promise<ToolResult>;
};
type Command = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};
type AgentEnd = (event: unknown, ctx: unknown) => void;
type StringSchema = {
  min(length: number): StringSchema;
  describe(description: string): StringSchema;
};

const noteDir = mkdtempSync(join(tmpdir(), "omp-handoff-switch-"));
const note = join(noteDir, "handoff.md");
writeFileSync(note, "# handoff\n");

afterAll(() => rmSync(noteDir, { force: true, recursive: true }));

function handoffHarness(onMessage?: () => void) {
  let tool: Tool | undefined;
  let command: Command | undefined;
  let agentEnd: AgentEnd | undefined;
  const messages: string[] = [];
  const zod = {
    object(shape: unknown) {
      return shape;
    },
    string(): StringSchema {
      const schema: StringSchema = {
        min() {
          return schema;
        },
        describe() {
          return schema;
        },
      };
      return schema;
    },
  };
  handoffSwitch({
    on(event: string, handler: AgentEnd) {
      if (event === "agent_end") agentEnd = handler;
    },
    registerCommand(_name: string, definition: Command) {
      command = definition;
    },
    registerTool(definition: Tool) {
      tool = definition;
    },
    sendUserMessage(message: string) {
      messages.push(message);
      onMessage?.();
    },
    zod,
  } as never);
  return {
    command: () => command!,
    messages,
    agentEnd: () => agentEnd!,
    tool: () => tool!,
  };
}

test("rejects handoff tools without a TUI or a saved note", async () => {
  const noUi = handoffHarness();
  const noUiResult = await noUi.tool().execute(
    "tool",
    { path: "handoff.md" },
    new AbortController().signal,
    () => {},
    { cwd: noteDir, hasUI: false },
  );
  const missingNote = handoffHarness();
  const missingResult = await missingNote.tool().execute(
    "tool",
    { path: "missing.md" },
    new AbortController().signal,
    () => {},
    { cwd: noteDir, hasUI: true },
  );
  const commandNotifications: { level: string; message: string }[] = [];
  await missingNote.command().handler("missing.md", {
    cwd: noteDir,
    newSession: async () => {
      throw new Error("missing note must not switch sessions");
    },
    ui: { notify: (message: string, level: string) => commandNotifications.push({ level, message }) },
    waitForIdle: async () => {
      throw new Error("missing note must not wait");
    },
  });

  expect(noUiResult.isError).toBe(true);
  expect(missingResult.isError).toBe(true);
  expect(missingResult.content[0].text).toContain(join(noteDir, "missing.md"));
  expect(commandNotifications).toMatchObject([{ level: "error" }]);
  expect(commandNotifications[0].message).toContain(join(noteDir, "missing.md"));
});

test("injects the switch command only after the agent becomes idle", async () => {
  const handoff = handoffHarness();
  const result = await handoff.tool().execute(
    "tool",
    { path: "handoff.md" },
    new AbortController().signal,
    () => {},
    { cwd: noteDir, hasUI: true },
  );
  let poll: (() => unknown) | undefined;
  let cleared = false;
  let idle = false;
  const editor: string[] = [];
  const injected: string[] = [];
  let customCalls = 0;
  handoff.agentEnd()({}, {
    clearTimer() {
      cleared = true;
    },
    cwd: noteDir,
    hasUI: true,
    isIdle: () => idle,
    setInterval(callback: () => unknown) {
      poll = callback;
      return "timer";
    },
    ui: {
      custom: async (
        render: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown,
      ) => {
        customCalls++;
        const tui = { injectDebugInput: (bytes: string) => injected.push(bytes) };
        let captured: unknown;
        render(tui, undefined, undefined, (value) => {
          captured = value;
        });
        return captured;
      },
      setEditorText: (text: string) => editor.push(text),
    },
  });

  await poll?.();
  expect(result.isError).toBeUndefined();
  expect(cleared).toBe(false);
  expect(customCalls).toBe(0);
  idle = true;
  await poll?.();

  expect(cleared).toBe(true);
  expect(editor).toEqual([`/handoff-switch ${note}`]);
  expect(injected).toEqual(["\r"]);
});

test("does not prompt a new session when the switch is cancelled", async () => {
  const handoff = handoffHarness();
  const notifications: { level: string; message: string }[] = [];
  let waited = 0;
  let switched = 0;

  await handoff.command().handler("handoff.md", {
    cwd: noteDir,
    newSession: async () => {
      switched++;
      return { cancelled: true };
    },
    ui: { notify: (message: string, level: string) => notifications.push({ level, message }) },
    waitForIdle: async () => {
      waited++;
    },
  });

  expect(waited).toBe(1);
  expect(switched).toBe(1);
  expect(handoff.messages).toEqual([]);
  expect(notifications).toMatchObject([{ level: "warning" }]);
});

test("prompts the successful new session to read the saved handoff note", async () => {
  const steps: string[] = [];
  const handoff = handoffHarness(() => steps.push("sendUserMessage"));

  await handoff.command().handler("handoff.md", {
    cwd: noteDir,
    newSession: async () => {
      steps.push("newSession");
      return { cancelled: false };
    },
    ui: { notify: () => {} },
    waitForIdle: async () => {
      steps.push("waitForIdle");
    },
  });

  expect(steps).toEqual(["waitForIdle", "newSession", "sendUserMessage"]);
  expect(handoff.messages).toHaveLength(1);
  expect(handoff.messages[0]).toContain(note);
});
