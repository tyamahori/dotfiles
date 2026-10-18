import { isEnvPath } from "../omp/extensions/deny-env-reads.ts";
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

const COPILOT_READ_TOOLS = new Set(["view", "grep", "rg"]);
const COPILOT_ENV_READ_REASON =
  "`.env`-style credential files are blocked from the view/grep tools, including grep globs that can match one (`*`, `*.*`, `{.env,...}`). These files hold plaintext secrets — don't load one into context unless the user explicitly asked you to inspect that exact file. Narrow the glob to the extensions you need (e.g. `*.ts`).";

// Mirrors omp/extensions/deny-env-reads.ts for Copilot's native readers. grep
// can reach an .env file through a directory in `paths` plus a `glob` filter
// (captured from copilot 1.0.91). A glob can name the file through
// alternatives or classes (`{.env,.env.local}`, `[.]env`) that a filename
// match misses, so any glob with `env` as a standalone word is refused. An
// `env/` directory segment does not single out a credential file; it widens
// the search no more than passing that directory without a glob.
// ponytail: filename heuristic; a directory search without a glob, or with a
// glob like `**/env/**`, still reads .env files that ripgrep does not ignore.
const ENV_GLOB = /(?:^|[^A-Z\d])env(?:[^A-Z\d/]|$)/i;

// Spellings such as `[.]e[n]v` or `.{e,x}{n,x}{v,x}` have no `env` word, so the
// glob is also evaluated against common credential file names. Wildcards like
// `*` match them too and are refused; the reason text tells the agent to narrow.
const ENV_PROBES = [".env", ".env.local", ".env.production", ".env.development", ".env.test", "credentials.env"]
  .flatMap((name) => [name, `dir/${name}`]);

function copilotEnvRead(args: unknown): string | undefined {
  if (!isPlainObject(args)) throw new Error("hook input toolArgs must be a JSON object");
  const targets = [args.path, args.paths].flat().filter((value): value is string => typeof value === "string");
  const glob = typeof args.glob === "string" ? args.glob : "";
  const globHitsEnv = glob !== "" && (ENV_GLOB.test(glob) || ENV_PROBES.some((name) => new Bun.Glob(glob).match(name)));
  return targets.some(isEnvPath) || globHitsEnv ? COPILOT_ENV_READ_REASON : undefined;
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

  // Copilot CLI sends camelCase toolName/toolArgs for every tool (no matcher),
  // and a non-zero exit denies the call, so only its shell and read tools are parsed.
  const copilotTool = client === "copilot" && typeof input.toolName === "string" ? input.toolName : "";
  const copilotReader = COPILOT_READ_TOOLS.has(copilotTool);
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
    reason = copilotEnvRead(copilotArgs);
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
