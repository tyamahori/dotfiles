import { denyCommand } from "./command-policy.ts";
import { missingTemplateHeadings, templateReason } from "./pr-template-check.ts";
import { slackNoticeViolation } from "./slack-notice.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function toolCommand(toolInput: unknown): string | undefined {
  if (toolInput === undefined) return undefined;
  if (!isPlainObject(toolInput)) {
    throw new Error("hook input tool_input must be a JSON object");
  }
  const command = toolInput.command;
  if (command !== undefined && typeof command !== "string") {
    throw new Error("hook input tool_input.command must be a string");
  }
  return command;
}

type HookClient = "claude" | "codex" | "copilot";

// Copilot CLI sends camelCase toolName/toolArgs for every tool (no matcher),
// and a non-zero exit denies the call, so only its shell tool is inspected.
function copilotShellArgs(input: Record<string, unknown>): unknown {
  if (input.toolName !== "bash") return undefined;
  return typeof input.toolArgs === "string" ? JSON.parse(input.toolArgs) : input.toolArgs;
}

function commandReason(command: string, client: HookClient, cwd: unknown): string | undefined {
  // Copilot is a shell-only agent like Codex; it shares Codex's rule set and wording.
  const reason = denyCommand(command, client === "copilot" ? "codex" : client);
  if (reason) return reason;
  const missing = missingTemplateHeadings(command, typeof cwd === "string" ? cwd : process.cwd());
  return missing.length > 0 ? templateReason(missing) : undefined;
}

export function denyCommandHook(client: HookClient, payload: string) {
  const input: unknown = JSON.parse(payload);
  if (!isPlainObject(input)) {
    throw new Error("hook input must be a JSON object");
  }

  const toolInput = client === "copilot" ? copilotShellArgs(input) : input.tool_input;
  const command = toolCommand(toolInput);

  let reason: string | undefined;
  if (typeof command === "string") {
    reason = commandReason(command, client, input.cwd);
  } else if (typeof input.tool_name === "string") {
    reason = slackNoticeViolation(input.tool_name, toolInput);
  }
  if (!reason) return;
  // Copilot CLI reads the decision at the top level, not under hookSpecificOutput.
  if (client === "copilot") return { permissionDecision: "deny", permissionDecisionReason: reason };
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
  if (client !== "claude" && client !== "codex" && client !== "copilot") {
    throw new Error("usage: deny-command-hook.ts <claude|codex|copilot>");
  }
  const response = denyCommandHook(client, await Bun.stdin.text());
  if (response) console.log(JSON.stringify(response));
}
