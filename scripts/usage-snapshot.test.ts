import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ruleTable from "../agents/command-rules.json";

const root = resolve(import.meta.dir, "..");
const snapshot = resolve(root, "agents/skills/agent-usage-review/scripts/snapshot.sh");
const reason = (id: string, client: "claude" | "codex" | "omp") => {
  const rule = ruleTable.rules.find((r) => r.id === id)!;
  return (rule.reasons as Record<string, string> | undefined)?.[client] ?? rule.reason!;
};

test("snapshot counts repeated failures per client, class, and session from all three log formats", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "usage-snapshot-"));
  const now = new Date().toISOString();
  const old = "2020-01-01T00:00:00.000Z";
  const jsonl = (path: string, rows: unknown[]) => {
    mkdirSync(dirname(resolve(home, path)), { recursive: true });
    writeFileSync(resolve(home, path), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  };

  const claudeResult = (text: string, isError: boolean, timestamp = now) => ({
    type: "user",
    timestamp,
    message: { content: [{ type: "tool_result", is_error: isError, content: text }] },
  });
  const commitReject = "commit-msg: subject-only message for a 12-line change";
  jsonl(".claude/projects/p/a.jsonl", [
    claudeResult(`PreToolUse:Bash hook error: ${reason("shell-read-search", "claude")}`, true),
    claudeResult(`PreToolUse:Bash hook error: ${reason("shell-read-search", "claude")}`, true),
    claudeResult(commitReject, true),
    // Not an error: printing the rule text must not count.
    claudeResult(reason("bare-python", "claude"), false),
    // Reading the hook source shows the pattern, not a numbered rejection.
    claudeResult("commit-msg: subject-only message for a [0-9]+-line change", true),
    // Before the window.
    claudeResult(commitReject, true, old),
  ]);
  jsonl(".claude/projects/p/b.jsonl", [
    claudeResult(`PreToolUse:Bash hook error: ${reason("shell-read-search", "claude")}`, true),
    claudeResult("<tool_use_error>File has not been read yet. Read it first.</tool_use_error>", true),
  ]);

  const codexOutput = (output: string) => ({ timestamp: now, payload: { type: "function_call_output", output } });
  jsonl(".codex/sessions/2026/x.jsonl", [
    codexOutput(`Command blocked by PreToolUse hook: ${reason("bare-python", "codex")}`),
    codexOutput("Script error:\nCommand blocked by PreToolUse hook: something this table has no rule for"),
    codexOutput("ordinary output"),
    { timestamp: now, payload: { type: "item_completed", item: { type: "HookPrompt" } } },
  ]);

  const ompMessage = (role: string, text: string, toolName?: string) => ({
    type: "message",
    timestamp: now,
    message: { role, toolName, content: [{ type: "text", text }] },
  });
  jsonl(".omp/agent/sessions/s.jsonl", [
    ompMessage("toolResult", reason("brew-upgrade", "omp"), "bash"),
    ompMessage("user", "[lint-on-edit] shellcheck found issues in the file you just edited — fix them now:\nx.sh:1:6: note: Double quote [SC2086]"),
  ]);

  // Only jq and the base system: ccusage, omp, and jbcontext stay out of the
  // run, so their sections come out empty instead of reaching the network.
  const bin = resolve(home, "bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("jq")!, resolve(bin, "jq"));

  try {
    const run = spawnSync(Bun.which("bash")!, [snapshot, "--days", "7"], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const table = run.stdout.split("### 繰り返し失敗")[1].split("###")[0];
    const rows = table.split("\n").filter((line) => /^(OMP|Claude|Codex)\t/.test(line));
    // Sorted by sessions, then events (both descending), then client and class.
    expect(rows).toEqual([
      "Claude\tdeny:shell-read-search\t3\t2",
      "Claude\tcommit-msg-why\t1\t1",
      "Claude\tedit-before-read\t1\t1",
      "Codex\tdeny:bare-python\t1\t1",
      "Codex\tdeny:other\t1\t1",
      "Codex\tstop-hook\t1\t1",
      "OMP\tdeny:brew-upgrade\t1\t1",
      "OMP\tlint:shellcheck\t1\t1",
      "OMP\tlint:shellcheck:SC2086\t1\t1",
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
