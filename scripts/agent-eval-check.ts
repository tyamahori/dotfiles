// Runs one case's behaviour table against a workspace the agent edited. Importing that workspace
// runs model-written code, so agent-eval starts this under `codex sandbox -P :read-only` with a
// minimal environment. The table comes from agent-eval-cases.ts, never from the workspace.
import { join } from "node:path";
import type { Check } from "./agent-eval-cases.ts";
import { CHECK_MARKER, CHECK_STARTED } from "./agent-eval-core.ts";

async function passes(workspace: string, check: Check): Promise<boolean> {
  try {
    const loaded: Record<string, unknown> = await import(join(workspace, check.module));
    const fn = loaded[check.fn];
    if (typeof fn !== "function") return false;
    return Bun.deepEquals(await (fn as (...args: unknown[]) => unknown)(...check.args), check.want, true);
  } catch {
    return false;
  }
}

// Printed before anything is imported: its absence means this harness never ran, which is not the
// agent's failure.
export async function runChecks(
  workspace: string,
  checks: readonly Check[],
  emit: (line: string) => void,
): Promise<void> {
  emit(JSON.stringify({ [CHECK_MARKER]: CHECK_STARTED }));
  for (const check of checks) {
    emit(JSON.stringify({ [CHECK_MARKER]: check.id, pass: await passes(workspace, check) }));
  }
}

if (import.meta.main) {
  const [workspace, table] = process.argv.slice(2);
  if (!workspace || !table) {
    console.error("usage: agent-eval-check <workspace> <checks-json>");
    process.exit(2);
  }
  await runChecks(workspace, JSON.parse(table), console.log);
  // Handles the agent's code left open must not keep this process alive.
  process.exit(0);
}
