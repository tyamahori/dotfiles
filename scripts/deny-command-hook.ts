import { denyCommand } from "./command-policy.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function denyCommandHook(client: "claude" | "codex", payload: string) {
  const input: unknown = JSON.parse(payload);
  if (!isPlainObject(input)) {
    throw new Error("hook input must be a JSON object");
  }

  const toolInput = input.tool_input;
  let command: unknown;
  if (toolInput !== undefined) {
    if (!isPlainObject(toolInput)) {
      throw new Error("hook input tool_input must be a JSON object");
    }
    command = toolInput.command;
  }
  if (command !== undefined && typeof command !== "string") {
    throw new Error("hook input tool_input.command must be a string");
  }

  if (typeof command !== "string") return;
  const reason = denyCommand(command, client);
  if (!reason) return;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

if (import.meta.main) {
  const client = process.argv[2];
  if (client !== "claude" && client !== "codex") {
    throw new Error("usage: deny-command-hook.ts <claude|codex>");
  }
  const response = denyCommandHook(client, await Bun.stdin.text());
  if (response) console.log(JSON.stringify(response));
}
