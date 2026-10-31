import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const MAX_OUTPUT_CHARS = 60_000;

function formatOutput(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n[stderr]\n");
  if (output.length <= MAX_OUTPUT_CHARS) return output || "(The agent returned no output.)";
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_OUTPUT_CHARS} characters.]`;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) ?? undefined;
  } catch {
    return undefined;
  }
}

// The CLIs are installed on every machine by the shared Brewfile, but only some machines sign in,
// so the tools are offered only where their CLI holds credentials. Checked once at load: signing in
// or out takes effect in the next OMP process.
function grokSignedIn(home: string): boolean {
  // `grok login` writes one entry per account; a missing or empty file means no account is signed in.
  return Object.keys(readJson(join(home, ".grok", "auth.json")) ?? {}).length > 0;
}

function cursorSignedIn(home: string): boolean {
  // The token itself sits in the OS keychain; `cursor-agent logout` removes authInfo from this file.
  return readJson(join(home, ".cursor", "cli-config.json"))?.authInfo !== undefined;
}

async function runAgent(
  pi: ExtensionAPI,
  label: string,
  argv: string[],
  options: { cwd: string; signal?: AbortSignal },
) {
  const [command, ...args] = argv;
  const result = await pi.exec(command, args, options);
  if (result.killed) {
    return { content: [{ type: "text" as const, text: `${label} was cancelled.` }], details: { cancelled: true } };
  }
  const content = [{ type: "text" as const, text: formatOutput(result.stdout, result.stderr) }];
  if (result.code !== 0) return { content, details: { exitCode: result.code }, isError: true };
  return { content, details: { exitCode: result.code } };
}

function registerKiro(pi: ExtensionAPI) {
  const z = pi.zod;
  pi.registerTool({
    name: "kiro_cli",
    label: "Kiro CLI",
    description:
      "Delegate a task to Kiro CLI in the current workspace. By default Kiro cannot use its own tools. Set allowToolUse only when the user explicitly authorizes the delegated agent to run commands or modify files.",
    parameters: z.object({
      prompt: z.string().min(1).describe("Complete task for Kiro CLI."),
      agent: z.string().optional().describe("Optional Kiro agent profile."),
      model: z.string().optional().describe("Optional Kiro model identifier."),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      allowToolUse: z.boolean().optional().describe("Allow Kiro to execute its own tools. Defaults to false."),
    }),
    defaultInactive: false,
    approval: "exec",
    // OMP fixes this callback at five arguments; the rest tuple keeps their contextual types.
    async execute(...[, params, signal, onUpdate, ctx]) {
      const args = ["chat", "--no-interactive"];
      if (params.agent) args.push("--agent", params.agent);
      if (params.model) args.push("--model", params.model);
      if (params.effort) args.push("--effort", params.effort);
      if (params.allowToolUse) args.push("--trust-all-tools");
      // `--` keeps a prompt that starts with `-` (e.g. a bullet list) from being parsed as a flag.
      args.push("--", params.prompt);

      onUpdate?.({ content: [{ type: "text", text: "Running Kiro CLI…" }] });
      return runAgent(pi, "Kiro CLI", ["kiro-cli", ...args], { cwd: ctx.cwd, signal });
    },
  });
}

function registerGrok(pi: ExtensionAPI) {
  const z = pi.zod;
  pi.registerTool({
    name: "grok_build",
    label: "Grok Build",
    description:
      "Delegate a task to Grok Build in the current workspace. By default Grok Build does not auto-approve its own tools. Set allowToolUse only when the user explicitly authorizes the delegated agent to run commands or modify files.",
    parameters: z.object({
      prompt: z.string().min(1).describe("Complete task for Grok Build."),
      agent: z.string().optional().describe("Optional Grok Build agent name or definition path."),
      model: z.string().optional().describe("Optional Grok Build model identifier."),
      effort: z.string().optional().describe("Optional Grok Build reasoning effort."),
      allowToolUse: z.boolean().optional().describe("Auto-approve Grok Build tool use. Defaults to false."),
    }),
    defaultInactive: false,
    approval: "exec",
    async execute(...[, params, signal, onUpdate, ctx]) {
      // `--single=` keeps a prompt that starts with `-` (e.g. a bullet list) from being parsed as a flag.
      const args = ["--no-alt-screen", "--cwd", ctx.cwd, `--single=${params.prompt}`, "--output-format", "plain"];
      if (params.agent) args.push("--agent", params.agent);
      if (params.model) args.push("--model", params.model);
      if (params.effort) args.push("--reasoning-effort", params.effort);
      if (params.allowToolUse) args.push("--always-approve");

      onUpdate?.({ content: [{ type: "text", text: "Running Grok Build…" }] });
      return runAgent(pi, "Grok Build", ["grok", ...args], { cwd: ctx.cwd, signal });
    },
  });
}

function registerCursor(pi: ExtensionAPI) {
  const z = pi.zod;
  pi.registerTool({
    name: "cursor_agent",
    label: "Cursor Agent",
    description:
      "Delegate a task to Cursor Agent in the current workspace. By default Cursor Agent runs read-only (ask mode). Set allowToolUse only when the user explicitly authorizes the delegated agent to run commands or modify files.",
    parameters: z.object({
      prompt: z.string().min(1).describe("Complete task for Cursor Agent."),
      model: z.string().optional().describe("Optional Cursor model identifier."),
      allowToolUse: z
        .boolean()
        .optional()
        .describe("Let Cursor Agent edit files and run commands. Defaults to false (read-only)."),
    }),
    defaultInactive: false,
    approval: "exec",
    async execute(...[, params, signal, onUpdate, ctx]) {
      // `--print` alone grants write and shell access, so read-only must be requested explicitly.
      const args = ["--print", "--output-format", "text", "--trust"];
      if (params.model) args.push("--model", params.model);
      args.push(...(params.allowToolUse ? ["--force"] : ["--mode", "ask"]));
      args.push("--", params.prompt);

      onUpdate?.({ content: [{ type: "text", text: "Running Cursor Agent…" }] });
      // Called as `cursor-agent`, not `agent`: Grok Build also installs an `agent` command.
      return runAgent(pi, "Cursor Agent", ["cursor-agent", ...args], { cwd: ctx.cwd, signal });
    },
  });
}

// `home` defaults to the user's home; tests pass a fixture (Bun's homedir() ignores a runtime HOME change).
export default function externalCodingAgents(pi: ExtensionAPI, home = homedir()) {
  registerKiro(pi);
  if (grokSignedIn(home)) registerGrok(pi);
  if (cursorSignedIn(home)) registerCursor(pi);
}
