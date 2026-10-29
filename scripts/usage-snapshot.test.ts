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
    ompMessage(
      "user",
      "[lint-on-edit] shellcheck found issues in the file you just edited — fix them now:\nx.sh:1:6: note: Double quote [SC2086]",
    ),
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

test("snapshot counts days spanned by human input in local time, not UTC", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "usage-snapshot-"));
  // A JST calendar day two days ago, inside the --days 7 window.
  const day = new Date(Date.now() - 2 * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const next = new Date(Date.parse(`${day}T12:00:00+09:00`) + 86_400_000).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Tokyo",
  });
  const at = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`).toISOString();
  const session = (name: string, first: string, second: string) => {
    const path = resolve(home, `.claude/projects/p/${name}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    const human = (timestamp: string) => ({
      type: "user",
      timestamp,
      origin: { kind: "human" },
      message: { content: "hi" },
    });
    const rows = [
      human(first),
      { type: "assistant", timestamp: first, message: { id: `${name}-1`, model: "m", usage: { input_tokens: 10 } } },
      human(second),
    ];
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  };
  // 08:30 and 09:30 JST fall on two UTC dates but one local day.
  session("same-local-day", at(day, "08:30"), at(day, "09:30"));
  // 23:30 and 00:30 JST fall on one UTC date but two local days.
  session("crosses-local-midnight", at(day, "23:30"), at(next, "00:30"));

  const bin = resolve(home, "bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("jq")!, resolve(bin, "jq"));

  try {
    const run = spawnSync(Bun.which("bash")!, [snapshot, "--days", "7"], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C", TZ: "Asia/Tokyo" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const section = run.stdout.split("## 警告フラグ: Claude セッション")[1].split("\n## ")[0];
    const flagged = section
      .split("\n")
      .filter((line) => line.includes("\tdays="))
      .map((line) => line.split("\t").slice(0, 2).join("\t"));
    expect(flagged).toEqual(["crosses-local-midnight\tdays=2"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("snapshot reports a failed stats freshness check when stats.db cannot be queried", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "usage-snapshot-"));
  const now = new Date().toISOString();
  const sessions = resolve(home, ".omp/agent/sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    resolve(sessions, "s.jsonl"),
    JSON.stringify({
      type: "message",
      timestamp: now,
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }) + "\n",
  );
  // The freshness query reads tool_calls too; a DB without it makes sqlite3 fail.
  const db = resolve(home, ".omp/stats.db");
  const created = spawnSync("sqlite3", [db, "CREATE TABLE messages (timestamp INTEGER);"]);
  expect(created.status).toBe(0);

  const bin = resolve(home, "bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("jq")!, resolve(bin, "jq"));
  const omp = resolve(bin, "omp");
  writeFileSync(omp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  try {
    const run = spawnSync(Bun.which("bash")!, [snapshot, "--days", "7"], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const line = run.stdout.split("\n").find((l) => l.startsWith("- stats freshness:"))!;
    expect(line).toContain("失敗");
    expect(run.stdout).toContain("OMP stats:** 取得不能");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("snapshot prints a fallback when jbcontext analyze yields no summary lines", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "usage-snapshot-"));
  const bin = resolve(home, "bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("jq")!, resolve(bin, "jq"));
  // Plain-text mode prints nothing the summary filter matches; --json-output fails.
  writeFileSync(resolve(bin, "jbcontext"), '#!/bin/sh\ncase "$*" in *--json-output*) exit 1;; esac\necho unrelated\n', {
    mode: 0o755,
  });

  try {
    const run = spawnSync(Bun.which("bash")!, [snapshot, "--days", "7"], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const section = run.stdout.split("### jbcontext 活用度")[1].split("###")[0];
    expect(section.trim().split("\n").slice(1).join("").trim()).not.toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("snapshot marks the ccusage sections unavailable when ccusage prints nothing", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(resolve(scratch, "usage-snapshot-"));
  const bin = resolve(home, "bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("jq")!, resolve(bin, "jq"));
  writeFileSync(resolve(bin, "ccusage"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  try {
    const run = spawnSync(Bun.which("bash")!, [snapshot, "--days", "7"], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const body = (heading: string) => run.stdout.split(heading)[1].split("\n## ")[0].trim().split("\n").slice(1);
    expect(body("## 日次合計 (agent 別)")).toEqual(["(取得不能: `ccusage daily` が出力を返さない)"]);
    expect(body("## コスト上位セッション")).toEqual(["(取得不能: `ccusage session` が出力を返さない)"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
