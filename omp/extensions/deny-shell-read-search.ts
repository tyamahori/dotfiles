// Deny shell read/search commands that have dedicated OMP tools. Keep the
// matching contract aligned with claude/hooks/deny-shell-read-search.sh.
// Mid-pipeline filters remain available; only commands at the start or after
// `;`, `(`, `&&`, or `||` are candidates.

import { stripHeredocs } from "./deny-bare-python";

const COMMAND_POSITION =
  String.raw`(?:^|[;(]|&&|\|\|)[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^ \t\n]+)[ \t]+)*(?:command[ \t]+)?`;

const READ_SEARCH_COMMAND = new RegExp(
  `${COMMAND_POSITION}(?:grep|rg|find|head|tail)(?=[ \\t]|$)`,
  "m",
);

const PRINT_SED_COMMAND = new RegExp(
  `${COMMAND_POSITION}sed[ \\t]+(?:-[A-Za-z]*n[A-Za-z]*|--quiet|--silent)(?=[ \\t]|$)`,
  "m",
);

const PLAIN_CAT_COMMAND = new RegExp(
  `${COMMAND_POSITION}cat(?=[ \\t]|$)`,
  "m",
);

function shouldDenyShellReadSearch(command: string): boolean {
  const stripped = stripHeredocs(command);
  if (READ_SEARCH_COMMAND.test(stripped) || PRINT_SED_COMMAND.test(stripped)) {
    return true;
  }
  return PLAIN_CAT_COMMAND.test(stripped) && !/[<>]/.test(command);
}

const REASON =
  "Shell read/search commands are blocked on this machine. Use grep instead of shell grep/rg, read with a bounded selector instead of cat/head/tail/sed -n, and glob instead of find. Mid-pipeline filters, write-mode cat, heredocs, and non-print sed remain allowed.";

interface ToolCallEvent {
  toolName: string;
  input?: { command?: unknown };
}

type ToolCallResult = { block: true; reason: string } | undefined;

interface ExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent) => Promise<ToolCallResult>,
  ): void;
}

export default function denyShellReadSearch(pi: ExtensionApi) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = event.input?.command;
    if (typeof command !== "string") return;
    if (shouldDenyShellReadSearch(command)) {
      return { block: true, reason: REASON };
    }
  });
}
