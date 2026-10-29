import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isEnvPath } from "../omp/extensions/deny-env-reads.ts";
import { denyCommand } from "./command-policy.ts";
import { missingTemplateHeadings, templateReason } from "./pr-template-check.ts";
import { slackNoticeViolation } from "./slack-notice.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
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

const COPILOT_READ_TOOLS: Record<string, true> = { view: true, grep: true, rg: true };
const COPILOT_ENV_READ_REASON =
  "`.env`-style credential files are blocked from the view/grep tools. These files hold plaintext secrets — don't load one into context unless the user explicitly asked you to inspect that exact file.";
const COPILOT_GREP_SCOPE_REASON =
  "The grep/rg tools only search explicitly listed regular files on this machine: a directory, a missing path, or no path at all can pull `.env`-style credential files into context whatever the glob says. List the specific files to search in `path`/`paths`.";

// Mirrors omp/extensions/deny-env-reads.ts for Copilot's native readers, by
// name and by symlink target. grep/rg is limited to explicit regular files
// because no glob can be shown to exclude every .env name: copilot 1.0.91 sent
// the directory in `paths` and the file in `glob`, and globs such as `[.]e[n]v`
// or `.{e,x}{n,x}{v,x}.staging` defeat any filename match.
function copilotEnvRead(toolName: string, args: unknown, cwd: unknown): string | undefined {
  if (!isPlainObject(args)) throw new Error("hook input toolArgs must be a JSON object");
  const targets = [args.path, args.paths].flat().filter((value): value is string => typeof value === "string");
  const base = typeof cwd === "string" ? cwd : process.cwd();
  if (targets.some((target) => isEnvPath(target, base))) return COPILOT_ENV_READ_REASON;
  if (toolName !== "view" && targets.length === 0) return COPILOT_GREP_SCOPE_REASON;
  for (const target of targets) {
    const absolute = resolve(base, target.replace(/^~(?=\/|$)/, homedir()));
    const real = existsSync(absolute) ? realpathSync(absolute) : undefined;
    if (toolName !== "view" && (real === undefined || !statSync(real).isFile())) return COPILOT_GREP_SCOPE_REASON;
  }
  return undefined;
}

function commandReason(command: string, client: HookClient, cwd: unknown): string | undefined {
  // Copilot shares Codex's rule set and wording, plus its own rules for the
  // shell paths its native tools already cover.
  const reason =
    client === "copilot"
      ? (denyCommand(command, "codex") ?? denyCommand(command, "copilot"))
      : denyCommand(command, client);
  if (reason) return reason;
  const missing = missingTemplateHeadings(command, typeof cwd === "string" ? cwd : process.cwd());
  return missing.length > 0 ? templateReason(missing) : undefined;
}

export function denyCommandHook(client: HookClient, payload: string) {
  const input: unknown = JSON.parse(payload);
  if (!isPlainObject(input)) {
    throw new Error("hook input must be a JSON object");
  }

  // Copilot CLI sends camelCase toolName/toolArgs for every tool (no matcher),
  // and a non-zero exit denies the call, so only its shell and read tools are parsed.
  const copilotTool = client === "copilot" && typeof input.toolName === "string" ? input.toolName : "";
  const copilotReader = Object.hasOwn(COPILOT_READ_TOOLS, copilotTool);
  const copilotArgs: unknown =
    (copilotTool === "bash" || copilotReader) && typeof input.toolArgs === "string"
      ? JSON.parse(input.toolArgs)
      : input.toolArgs;
  let toolInput = input.tool_input;
  if (client === "copilot") toolInput = copilotTool === "bash" ? copilotArgs : undefined;
  const command = toolCommand(toolInput);

  let reason: string | undefined;
  if (typeof command === "string") {
    reason = commandReason(command, client, input.cwd);
  } else if (copilotReader) {
    reason = copilotEnvRead(copilotTool, copilotArgs, input.cwd);
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
