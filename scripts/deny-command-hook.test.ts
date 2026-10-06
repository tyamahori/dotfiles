import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
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
