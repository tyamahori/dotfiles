import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const MAX_OUTPUT_CHARS = 60_000;

function formatOutput(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n[stderr]\n");
  if (output.length <= MAX_OUTPUT_CHARS) return output || "(The agent returned no output.)";
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_OUTPUT_CHARS} characters.]`;
}

export default function externalCodingAgents(pi: ExtensionAPI) {
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
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args = ["chat", "--no-interactive"];
      if (params.agent) args.push("--agent", params.agent);
      if (params.model) args.push("--model", params.model);
      if (params.effort) args.push("--effort", params.effort);
      if (params.allowToolUse) args.push("--trust-all-tools");
      args.push(params.prompt);

      onUpdate?.({ content: [{ type: "text", text: "Running Kiro CLI…" }] });
      const result = await pi.exec("kiro-cli", args, { cwd: ctx.cwd, signal });
      const output = formatOutput(result.stdout, result.stderr);
      if (result.killed) return { content: [{ type: "text", text: "Kiro CLI was cancelled." }], details: { cancelled: true } };
      if (result.code !== 0) {
        return { content: [{ type: "text", text: output }], details: { exitCode: result.code }, isError: true };
      }
      return { content: [{ type: "text", text: output }], details: { exitCode: result.code } };
    },
  });

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
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args = ["--no-alt-screen", "--cwd", ctx.cwd, "-p", params.prompt, "--output-format", "plain"];
      if (params.agent) args.push("--agent", params.agent);
      if (params.model) args.push("--model", params.model);
      if (params.effort) args.push("--reasoning-effort", params.effort);
      if (params.allowToolUse) args.push("--always-approve");

      onUpdate?.({ content: [{ type: "text", text: "Running Grok Build…" }] });
      const result = await pi.exec("grok", args, { cwd: ctx.cwd, signal });
      const output = formatOutput(result.stdout, result.stderr);
      if (result.killed) return { content: [{ type: "text", text: "Grok Build was cancelled." }], details: { cancelled: true } };
      if (result.code !== 0) {
        return { content: [{ type: "text", text: output }], details: { exitCode: result.code }, isError: true };
      }
      return { content: [{ type: "text", text: output }], details: { exitCode: result.code } };
    },
  });
}
