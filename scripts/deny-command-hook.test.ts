import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyCommandHook } from "./deny-command-hook";

let which: Mock<typeof Bun.which>;
beforeEach(() => { which = spyOn(Bun, "which").mockReturnValue("/available/replacement"); });
afterEach(() => which.mockRestore());

const payload = (command: string) => JSON.stringify({ tool_input: { command } });

test("both command-hook clients deny bare Python with the shared permission protocol", () => {
  for (const client of ["claude", "codex"] as const) {
    const response = denyCommandHook(client, payload("python3 app.py"));
    expect(response?.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(response?.hookSpecificOutput.permissionDecisionReason).toContain("uv");
  }
});

test("client-specific guidance stays distinct and missing replacements do not block", () => {
  expect(denyCommandHook("claude", payload("cat file.txt"))?.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(denyCommandHook("codex", payload("cat file.txt"))).toBeUndefined();
  which.mockReturnValue(null);
  expect(denyCommandHook("claude", payload("python3 app.py"))).toBeUndefined();
});

test("allowed commands and events without a command emit no permission decision", () => {
  expect(denyCommandHook("codex", payload("uv run app.py"))).toBeUndefined();
  expect(denyCommandHook("claude", payload("printf '%s' 'python3 app.py'"))).toBeUndefined();
  expect(denyCommandHook("claude", "{}")).toBeUndefined();
  expect(denyCommandHook("codex", '{"tool_input":{}}')).toBeUndefined();
});

test("Copilot CLI shell calls get Codex's rules with a top-level decision; other tools pass", () => {
  // Shape captured from copilot 1.0.91 preToolUse; the docs describe toolArgs as a JSON string.
  const copilot = (toolName: string, toolArgs: unknown) =>
    denyCommandHook("copilot", JSON.stringify({ cwd: "/tmp", toolName, toolArgs }));
  expect(copilot("bash", { command: "python3 app.py", description: "run" })).toMatchObject({ permissionDecision: "deny" });
  expect(copilot("bash", JSON.stringify({ command: "sleep 30" }))?.permissionDecisionReason).toContain("in one command");
  expect(copilot("bash", { command: "cat file.txt" })).toBeUndefined();
  // Shell grep/rg would bypass the grep tool's .env guard; Codex, with no native grep, keeps it.
  expect(copilot("bash", { command: "rg TOKEN ." })?.permissionDecisionReason).toContain("rg -l");
  expect(copilot("bash", { command: "grep -rn TOKEN .env" })).toMatchObject({ permissionDecision: "deny" });
  expect(copilot("bash", { command: "rg -l TOKEN ." })).toBeUndefined();
  expect(copilot("bash", { command: "git log | grep fix" })).toBeUndefined();
  expect(copilot("bash", { command: "git log | grep -i -A2 fix" })).toBeUndefined();
  for (const command of [
    "printf x | rg TOKEN .env",
    "rg -L TOKEN .env",
    "grep -e -l .env",
    "rg -- -l .env",
    "rg -eTOKEN .env /tmp/app.log",
    "rg -l --pre cat TOKEN .",
    "rg -l TOKEN . > out",
    "env A=1 rg -l TOKEN .env",
    "xargs rg TOKEN .env",
    "/usr/bin/grep TOKEN .env",
    "git grep TOKEN",
  ]) {
    expect(copilot("bash", { command })).toMatchObject({ permissionDecision: "deny" });
  }
  expect(denyCommandHook("codex", payload("rg TOKEN ."))).toBeUndefined();
  expect(copilot("edit", { path: "/tmp/app.ts", command: "python3 app.py" })).toBeUndefined();
});

test("Copilot view/grep never reach .env-style files; grep only searches listed regular files", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-env-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "FAKE\n");
    writeFileSync(join(dir, "sample.env"), "FAKE_TOKEN=dummy\n");
    symlinkSync(join(dir, "sample.env"), join(dir, "link.txt"));
    mkdirSync(join(dir, "src"));
    const copilot = (toolName: string, toolArgs: unknown) =>
      denyCommandHook("copilot", JSON.stringify({ cwd: dir, toolName, toolArgs }))?.permissionDecisionReason;
    for (const [toolName, toolArgs, expected] of [
      ["view", { path: join(dir, ".env") }, "credential"],
      ["view", { path: join(dir, "link.txt") }, "credential"],
      ["view", { path: join(dir, "notes.txt") }, undefined],
      ["view", { path: join(dir, "src") }, undefined],
      // grep as copilot 1.0.91 sent it: the directory in paths, the file picked by glob.
      ["grep", { pattern: "FAKE", paths: dir, glob: "sample.env" }, "explicitly listed"],
      ["grep", { pattern: "FAKE", paths: "src", glob: "*.ts" }, "explicitly listed"],
      ["grep", { pattern: "FAKE", glob: "*.ts" }, "explicitly listed"],
      ["grep", { pattern: "FAKE", paths: "missing.txt" }, "explicitly listed"],
      ["grep", { pattern: "FAKE", paths: "notes.txt" }, undefined],
      ["rg", { pattern: "FAKE", paths: ["notes.txt", "link.txt"] }, "credential"],
      ["grep", JSON.stringify({ pattern: "FAKE", path: "/repo/.env.production" }), "credential"],
    ] as const) {
      const reason = copilot(toolName, toolArgs);
      if (expected === undefined) expect(reason).toBeUndefined();
      else expect(reason).toContain(expected);
    }
    expect(() => copilot("view", [join(dir, ".env")])).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed hook envelopes fail instead of becoming silent approvals", () => {
  for (const input of ["{", "null", "[]", '{"tool_input":null}', '{"tool_input":[]}', '{"tool_input":{"command":42}}']) {
    expect(() => denyCommandHook("codex", input)).toThrow();
  }
});

test("Slack MCP posts must end with the notice; drafts and reads pass", () => {
  const notice = "[自動投稿です。玉堀の秘書システムによるものです。]";
  const slack = (tool_name: string, tool_input: object) => denyCommandHook("claude", JSON.stringify({ tool_name, tool_input }));
  expect(slack("mcp__claude_ai_Slack__slack_send_message", { channel_id: "C1", message: "deploy done" })?.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(slack("mcp__slack__slack_send_message", { message: `deploy done\n${notice}\n` })).toBeDefined();
  expect(slack("mcp__slack__slack_schedule_message", { channel_id: "C1" })).toBeDefined();
  expect(slack("mcp__slack__slack_send_message", { message: `deploy done\n\n${notice}` })).toBeUndefined();
  expect(slack("mcp__slack__slack_send_message_draft", { message: "draft" })).toBeUndefined();
  expect(slack("mcp__slack__slack_read_channel", { channel_id: "C1" })).toBeUndefined();
});
