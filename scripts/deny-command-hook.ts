import { denyCommand } from "./command-policy.ts";

const client = process.argv[2];
if (client !== "claude" && client !== "codex") {
  throw new Error("usage: deny-command-hook.ts <claude|codex>");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

const input: unknown = JSON.parse(await Bun.stdin.text());
if (!isPlainObject(input)) {
  throw new Error("hook input must be a JSON object");
}

const toolInput = input.tool_input;
let command: unknown = undefined;
if (toolInput !== undefined) {
  if (!isPlainObject(toolInput)) {
    throw new Error("hook input tool_input must be a JSON object");
  }
  command = toolInput.command;
}
if (command !== undefined && typeof command !== "string") {
  throw new Error("hook input tool_input.command must be a string");
}

if (typeof command === "string") {
  const reason = denyCommand(command, client);
  if (reason) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
}
