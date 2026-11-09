// Runs one case's calls against a workspace the agent edited and prints what each one returned.
// Importing that workspace runs model-written code, so agent-eval starts this under
// `codex sandbox -P :read-only` with a minimal environment. The calls come from agent-eval-cases.ts,
// never from the workspace, and nothing here decides a pass: the parent compares the values.
import { join } from "node:path";
import type { CheckCall } from "./agent-eval-cases.ts";
import { CHECK_MARKER, CHECK_STARTED } from "./agent-eval-core.ts";

type Observation = { value?: unknown };

// A call that throws, or that has nothing to call, reports no value. That matches no expectation.
async function observe(workspace: string, call: CheckCall): Promise<Observation> {
  try {
    const loaded: Record<string, unknown> = await import(join(workspace, call.module));
    const fn = loaded[call.fn];
    if (typeof fn !== "function") return {};
    return { value: await (fn as (...args: unknown[]) => unknown)(...call.args) };
  } catch {
    return {};
  }
}

function resultLine(id: string, observation: Observation): string {
  try {
    return JSON.stringify({ [CHECK_MARKER]: id, ...observation });
  } catch {
    // A circular structure or a BigInt has no JSON form.
    return JSON.stringify({ [CHECK_MARKER]: id });
  }
}

// Printed before anything is imported: its absence means this harness never ran, which is not the
// agent's failure.
export async function runChecks(
  workspace: string,
  calls: readonly CheckCall[],
  emit: (line: string) => void,
): Promise<void> {
  emit(JSON.stringify({ [CHECK_MARKER]: CHECK_STARTED }));
  for (const call of calls) emit(resultLine(call.id, await observe(workspace, call)));
}

if (import.meta.main) {
  const [workspace, table] = process.argv.slice(2);
  if (!workspace || !table) {
    console.error("usage: agent-eval-check <workspace> <calls-json>");
    process.exit(2);
  }
  await runChecks(workspace, JSON.parse(table), console.log);
  // Handles the agent's code left open must not keep this process alive.
  process.exit(0);
}
