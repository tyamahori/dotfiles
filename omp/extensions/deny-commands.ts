import { denyCommand } from "../../scripts/command-policy.ts";
import { missingTemplateHeadings, templateReason } from "../../scripts/pr-template-check.ts";

interface ToolCallEvent {
  toolName: string;
  input?: { command?: unknown };
}

type ToolCallResult = { block: true; reason: string } | undefined;

interface ExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx?: { cwd?: string }) => Promise<ToolCallResult>,
  ): void;
}

export default function denyCommands(pi: ExtensionApi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = event.input?.command;
    if (typeof command !== "string") return;
    const reason = denyCommand(command, "omp");
    if (reason) return { block: true, reason };
    const missing = missingTemplateHeadings(command, ctx?.cwd || process.cwd());
    if (missing.length > 0) return { block: true, reason: templateReason(missing) };
  });
}
