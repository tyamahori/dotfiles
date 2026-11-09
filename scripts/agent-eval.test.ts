import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ctx, main } from "./agent-eval.ts";
import { CASES, grade } from "./agent-eval-cases.ts";
import { runChecks } from "./agent-eval-check.ts";
import {
  type Assertion,
  type ChildResult,
  changedPaths,
  type FinalOutput,
  type Identity,
  lightProfileProblem,
  NO_RECORDS,
  parseArgs,
  parseCheckOutput,
  parseEvents,
  parseRecord,
  parseRollout,
  type RunRecord,
  renderSummary,
  turnProblem,
  UNKNOWN_IDENTITY,
} from "./agent-eval-core.ts";

// Every native CLI is a stub on PATH, so the production code spawns real subprocesses and real Git
// while HOME, CODEX_HOME, and the state directory stay inside this tree. The real `codex sandbox`
// and a real model belong to the smoke recipe in docs/agent-eval.md.
const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-eval-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// Built at runtime: the repository's pre-commit guard rejects literal UUIDs.
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const THREAD = uuid("a");
const OTHER_THREAD = uuid("b");
const CANARY = "canary-value-not-for-records";

const stubCodex = (root: string) => `#!/bin/sh
root='${root}'
if [ "$1" = sandbox ]; then
  while [ "$1" != "--" ]; do shift; done
  shift
  exec "$@"
fi
printf '%s\\n' "$*" >>"$root/argv.log"
output=
profile=
previous=
for arg in "$@"; do
  [ "$previous" = "-o" ] && output=$arg
  [ "$previous" = "--profile" ] && profile=$arg
  previous=$arg
done
turn=$(( $(cat "$root/turn" 2>/dev/null || echo 0) + 1 ))
echo "$turn" >"$root/turn"
thread=${THREAD}
effort=xhigh
[ "$profile" = light ] && effort=medium
sessions="$CODEX_HOME/sessions/2026/11/09"
mkdir -p "$sessions"
rollout="$sessions/rollout-2026-11-09T00-00-00-$thread.jsonl"
[ -f "$rollout" ] || printf '%s\\n' '{"type":"session_meta","payload":{"cli_version":"0.167.0","model_provider":"openai"}}' >"$rollout"
printf '{"type":"turn_context","payload":{"model":"gpt-test","effort":"%s","approval_policy":"on-request","approvals_reviewer":"auto_review","sandbox_policy":{"type":"workspace-write"}}}\\n' "$effort" >>"$rollout"
printf '%s\\n' '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"default"}}}' >>"$rollout"
final() { printf '%s' "$1" >"$output"; }
complete_turn() {
  printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"
  printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"error","message":"a warning that does not end the turn"}}'
  printf '%s\\n' '{"type":"turn.started"}'
  printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"I am gpt-self-reported at low effort and all done"}}'
  printf '%s\\n' '{"type":"turn.completed","usage":{}}'
}
. "$root/scenario.sh"
`;

type Harness = { root: string; state: string; codexHome: string; ctx: Ctx; out: string[]; err: string[] };

let harnessCount = 0;

function harness(scenario: string, signal: AbortSignal = new AbortController().signal): Harness {
  const root = join(base, `h${harnessCount++}`);
  const bin = join(root, "bin");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const state = join(root, "state");
  for (const dir of [bin, home, codexHome]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "codex"), stubCodex(root), { mode: 0o755 });
  symlinkSync(Bun.which("git")!, join(bin, "git"));
  writeFileSync(join(root, "scenario.sh"), scenario);
  const out: string[] = [];
  const err: string[] = [];
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    CODEX_HOME: codexHome,
    XDG_STATE_HOME: state,
    SECRET_CANARY: CANARY,
  };
  const ctx: Ctx = { env, signal, out: (text) => out.push(text), err: (text) => err.push(text) };
  return { root, state, codexHome, ctx, out, err };
}

const runsDir = (h: Harness) => join(h.state, "agent-eval/runs");

function records(h: Harness): RunRecord[] {
  if (!existsSync(runsDir(h))) return [];
  return readdirSync(runsDir(h))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(runsDir(h), name), "utf8")));
}

function onlyRecord(h: Harness): RunRecord {
  const all = records(h);
  expect(all).toHaveLength(1);
  return all[0]!;
}

const failedIds = (record: RunRecord) => record.assertions.filter((a) => !a.pass).map((a) => a.id);
const evidencePath = (h: Harness, record: RunRecord) => join(h.state, "agent-eval", record.evidence);
const argvLog = (h: Harness) => join(h.root, "argv.log");
const launched = (h: Harness) => existsSync(argvLog(h));

const write = (path: string, ...lines: string[]) =>
  `mkdir -p "$(dirname ${path})" && cat >${path} <<'EOF'\n${lines.join("\n")}\nEOF`;
const finish = (output = '{"summary":"done"}') => `final '${output}'\ncomplete_turn`;

const REPAIR = write(
  "src/paginate.ts",
  "export function pageCount(total, pageSize) {",
  "  return Math.ceil(total / pageSize);",
  "}",
);

const installLightProfile = (h: Harness, text = 'model_reasoning_effort = "medium"\n') =>
  writeFileSync(join(h.codexHome, "light.config.toml"), text);

const SLOW = 30_000;

describe("a bug fix run", () => {
  test(
    "passes only after a real repair, and states what the CLI recorded rather than what the agent claimed",
    async () => {
      const h = harness(`${REPAIR}\n${finish('{"summary":"gpt-self-reported effort low"}')}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(0);
      const record = onlyRecord(h);
      expect(record.outcome).toBe("pass");
      expect(record.incompleteReason).toBeNull();
      expect(record.identity).toEqual({
        cli: "codex",
        cliVersion: "0.167.0",
        provider: "openai",
        model: "gpt-test",
        effort: "xhigh",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        serviceTier: "default",
      });
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(parseRecord(record, record.runId)).toBeDefined();
      expect(JSON.parse(h.out[0]!).outcome).toBe("pass");
    },
    SLOW,
  );

  test.each([
    ["claims done without touching the code", finish(), "behaviour:exact-multiple"],
    [
      "leaves the bug for exact multiples",
      `${write("src/paginate.ts", "export const pageCount = (total, size) => (total === 0 ? 0 : Math.floor(total / size) + 1);")}\n${finish()}`,
      "behaviour:exact-multiple",
    ],
    [
      "repairs the bug but also edits another file",
      `${REPAIR}\necho x >>src/report.ts\n${finish()}`,
      "no-unexpected-changes",
    ],
    ["repairs the bug but also adds a file", `${REPAIR}\necho x >notes.txt\n${finish()}`, "no-unexpected-changes"],
    ["deletes a file it was told to keep", `${REPAIR}\nrm src/report.ts\n${finish()}`, "no-unexpected-changes"],
  ])(
    "fails when the agent %s",
    async (_name, scenario, failing) => {
      const h = harness(scenario);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      const record = onlyRecord(h);
      expect(record.outcome).toBe("fail");
      expect(failedIds(record)).toContain(failing);
    },
    SLOW,
  );

  test.each([
    ["the CLI exits nonzero", `${REPAIR}\n${finish()}\nexit 7`, "exit-nonzero"],
    ["no final output is written", `${REPAIR}\ncomplete_turn`, "output-missing"],
    ["the final output is not JSON", `${REPAIR}\nfinal 'all done'\ncomplete_turn`, "output-malformed"],
    [
      "the turn reports failure",
      `${REPAIR}\nfinal '{"summary":"x"}'\ncomplete_turn\nprintf '%s\\n' '{"type":"turn.failed"}'`,
      "turn-failed",
    ],
    [
      "the turn never completes",
      `${REPAIR}\nfinal '{"summary":"x"}'\nprintf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"`,
      "turn-missing",
    ],
    [
      "the CLI never names a thread",
      `${REPAIR}\nfinal '{"summary":"x"}'\nprintf '%s\\n' '{"type":"turn.completed"}'`,
      "thread-missing",
    ],
  ])(
    "stays incomplete when %s, even with correct code",
    async (_name, scenario, reason) => {
      const h = harness(scenario);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.outcome).toBe("incomplete");
      expect(record.incompleteReason).toBe(reason as RunRecord["incompleteReason"]);
      expect(record.assertions).toEqual([]);
    },
    SLOW,
  );

  test(
    "keeps the exit code and the CLI's stderr for diagnosis",
    async () => {
      const h = harness("echo 'auth expired' >&2\nexit 7");
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.exitCode).toBe(7);
      expect(readFileSync(join(evidencePath(h, record), "turn-1.stderr.log"), "utf8")).toContain("auth expired");
    },
    SLOW,
  );

  test(
    "writes records and evidence that only the owner can read",
    async () => {
      const h = harness(`${REPAIR}\n${finish()}`);
      await main(["run", "bug-fix", "--variant", "baseline"], h.ctx);
      const record = onlyRecord(h);
      expect(statSync(join(runsDir(h), `${record.runId}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(runsDir(h)).mode & 0o777).toBe(0o700);
      expect(statSync(evidencePath(h, record)).mode & 0o777).toBe(0o700);
      expect(statSync(join(evidencePath(h, record), "turn-1.events.jsonl")).mode & 0o777).toBe(0o600);
    },
    SLOW,
  );

  test(
    "gives each run its own record",
    async () => {
      const h = harness(`${REPAIR}\n${finish()}`);
      await main(["run", "bug-fix", "--variant", "baseline"], h.ctx);
      rmSync(join(h.root, "turn"));
      await main(["run", "bug-fix", "--variant", "baseline"], h.ctx);
      expect(records(h)).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "runs model-written code without the caller's secrets and keeps nothing it printed",
    async () => {
      const hostile = write(
        "src/paginate.ts",
        "export function pageCount(total, pageSize) {",
        '  console.log("printed " + process.env.SECRET_CANARY);',
        "  return process.env.SECRET_CANARY ? -1 : Math.ceil(total / pageSize);",
        "}",
      );
      const h = harness(`${hostile}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(0);
      const record = onlyRecord(h);
      expect(existsSync(join(evidencePath(h, record), "check.stdout"))).toBe(false);
      expect(readFileSync(join(runsDir(h), `${record.runId}.json`), "utf8")).not.toContain("printed");
    },
    SLOW,
  );

  test(
    "treats a harness that never started as incomplete rather than the agent's failure",
    async () => {
      const h = harness(`${REPAIR}\n${finish()}`);
      writeFileSync(
        join(h.root, "bin/codex"),
        readFileSync(join(h.root, "bin/codex"), "utf8").replace('exec "$@"', "echo 'no sandbox here' >&2\nexit 1"),
      );
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.incompleteReason).toBe("harness-error");
      expect(readFileSync(join(evidencePath(h, record), "check.stderr.log"), "utf8")).toContain("no sandbox here");
    },
    SLOW,
  );

  test(
    "fails when the agent's code ends the check process before every result is in",
    async () => {
      const quitting = write("src/paginate.ts", "export function pageCount() {", "  process.exit(0);", "}");
      const h = harness(`${quitting}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      expect(failedIds(onlyRecord(h))).toContain("behaviour:empty-list");
    },
    SLOW,
  );
});

describe("stopping a run", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const SPAWN_AND_HANG = 'sleep 300 &\necho $! >"$root/grandchild"\nwait';

  test(
    "a run past its time limit stays incomplete and leaves no process behind",
    async () => {
      const h = harness(SPAWN_AND_HANG);
      expect(await main(["run", "bug-fix", "--variant", "baseline", "--timeout-seconds", "1"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.incompleteReason).toBe("timeout");
      await Bun.sleep(100);
      expect(alive(Number(readFileSync(join(h.root, "grandchild"), "utf8")))).toBe(false);
    },
    SLOW,
  );

  test(
    "an interrupted run stays incomplete and leaves no process behind",
    async () => {
      const controller = new AbortController();
      const h = harness(SPAWN_AND_HANG, controller.signal);
      const grandchild = join(h.root, "grandchild");
      const running = main(["run", "bug-fix", "--variant", "baseline"], h.ctx);
      while (!existsSync(grandchild) || readFileSync(grandchild, "utf8") === "") await Bun.sleep(20);
      controller.abort();
      expect(await running).toBe(3);
      expect(onlyRecord(h).incompleteReason).toBe("interrupted");
      await Bun.sleep(100);
      expect(alive(Number(readFileSync(grandchild, "utf8")))).toBe(false);
    },
    SLOW,
  );

  test(
    "an agent that floods its output is stopped at the cap",
    async () => {
      const h = harness("dd if=/dev/zero bs=1048576 count=40 2>/dev/null\nsleep 300");
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.incompleteReason).toBe("output-limit");
      expect(statSync(join(evidencePath(h, record), "turn-1.events.jsonl")).size).toBeLessThanOrEqual(32 * 1024 * 1024);
    },
    SLOW,
  );
});

describe("refusing a run before anything starts", () => {
  test.each([
    [["run", "../../evil", "--variant", "baseline"]],
    [["run", "bug-fix", "--variant", "heavy"]],
    [["run", "bug-fix"]],
    [["run", "bug-fix", "--variant", "baseline", "--timeout-seconds", "0"]],
  ])("does not start the CLI for invalid input %j", async (argv) => {
    const h = harness(finish());
    expect(await main(argv, h.ctx)).toBe(2);
    expect(h.err[0]).toContain("usage:");
    expect(launched(h)).toBe(false);
    expect(records(h)).toEqual([]);
  });

  test("reports a missing CLI and writes no record", async () => {
    const h = harness(finish());
    h.ctx.env.PATH = "/nonexistent";
    expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
    expect(h.err[0]).toContain("codex");
    expect(records(h)).toEqual([]);
  });

  test("reports a light run without the profile instead of silently running the default", async () => {
    const h = harness(finish());
    expect(await main(["run", "bug-fix", "--variant", "light"], h.ctx)).toBe(1);
    expect(h.err[0]).toContain("scripts/link");
    expect(launched(h)).toBe(false);
  });

  test("refuses a light profile that changes anything besides the effort", async () => {
    const h = harness(finish());
    installLightProfile(h, 'model_reasoning_effort = "medium"\napproval_policy = "never"\n');
    expect(await main(["run", "bug-fix", "--variant", "light"], h.ctx)).toBe(1);
    expect(launched(h)).toBe(false);
  });

  test("refuses a state directory that is a symlink, writing nothing through it", async () => {
    const h = harness(finish());
    const elsewhere = join(h.root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(h.state, { recursive: true });
    symlinkSync(elsewhere, join(h.state, "agent-eval"));
    expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
    expect(launched(h)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("the other fixed cases", () => {
  const investigate = (answer: object) => finish(JSON.stringify(answer));
  const RIGHT_ANSWER = { definingFile: "src/limits/active.ts", limitBytes: 3145728 };

  test(
    "an investigation passes with the right answer and no edits",
    async () => {
      const h = harness(investigate(RIGHT_ANSWER));
      expect(await main(["run", "investigation", "--variant", "baseline"], h.ctx)).toBe(0);
    },
    SLOW,
  );

  test.each([
    ["repeats the stale number from the docs", investigate({ ...RIGHT_ANSWER, limitBytes: 10485760 }), "limit-bytes"],
    [
      "names the unused legacy file",
      investigate({ ...RIGHT_ANSWER, definingFile: "src/limits/legacy.ts" }),
      "defining-file",
    ],
    ["answers correctly but edits a file", `echo x >>README.md\n${investigate(RIGHT_ANSWER)}`, "no-unexpected-changes"],
  ])(
    "an investigation fails when the agent %s",
    async (_name, scenario, failing) => {
      const h = harness(scenario);
      expect(await main(["run", "investigation", "--variant", "baseline"], h.ctx)).toBe(1);
      expect(failedIds(onlyRecord(h))).toEqual([failing]);
    },
    SLOW,
  );

  test(
    "a by-product under .agent-msgs does not count as an edit",
    async () => {
      const h = harness(`mkdir -p .agent-msgs/scratch\necho x >.agent-msgs/scratch/note\n${investigate(RIGHT_ANSWER)}`);
      expect(await main(["run", "investigation", "--variant", "baseline"], h.ctx)).toBe(0);
    },
    SLOW,
  );

  test(
    "a cross-file change passes only when every consumer works",
    async () => {
      const money = write(
        "src/money.ts",
        "export function formatPrice({ cents, currency }) {",
        '  return currency + " " + (cents / 100).toFixed(2);',
        "}",
      );
      const cart = write(
        "src/cart.ts",
        'import { formatPrice } from "./money";',
        "export function cartTotal(items) {",
        '  return formatPrice({ cents: items.reduce((sum, cents) => sum + cents, 0), currency: "USD" });',
        "}",
      );
      const invoice = write(
        "src/invoice.ts",
        'import { formatPrice } from "./money";',
        "export function invoiceLine(label, cents, currency) {",
        '  return label + ": " + formatPrice({ cents, currency });',
        "}",
      );
      const receipt = write(
        "src/receipt.ts",
        'import { formatPrice } from "./money";',
        "export function receiptFooter(cents) {",
        '  return "Paid " + formatPrice({ cents, currency: "USD" });',
        "}",
      );
      const complete = harness([money, cart, invoice, receipt, finish()].join("\n"));
      expect(await main(["run", "cross-file", "--variant", "baseline"], complete.ctx)).toBe(0);

      const forgotConsumer = harness([money, cart, invoice, finish()].join("\n"));
      expect(await main(["run", "cross-file", "--variant", "baseline"], forgotConsumer.ctx)).toBe(1);
      expect(failedIds(onlyRecord(forgotConsumer))).toEqual(["behaviour:receipt-usd", "required-changes"]);
    },
    SLOW,
  );

  const FOUND = [
    { file: "src/session.ts", line: 8, summary: "expiry is inverted" },
    { file: "src/retry.ts", line: 4, summary: "one attempt too many" },
    { file: "src/search.ts", line: 4, summary: "query built from input" },
  ];

  test(
    "a review run reviews the seeded commit and passes when every seed is found",
    async () => {
      const h = harness(finish(JSON.stringify({ findings: FOUND })));
      expect(await main(["run", "review", "--variant", "baseline"], h.ctx)).toBe(0);
      const workspace = join(evidencePath(h, onlyRecord(h)), "workspace");
      const shown = spawnSync(Bun.which("git")!, ["log", "--oneline"], { cwd: workspace, encoding: "utf8" });
      expect(shown.stdout.trim().split("\n")).toHaveLength(2);
      expect(readFileSync(join(workspace, "src/session.ts"), "utf8").split("\n")[7]).toContain("nowMs < session");
      expect(readFileSync(join(workspace, "src/retry.ts"), "utf8").split("\n")[3]).toContain("attempt <= maxAttempts");
      expect(readFileSync(join(workspace, "src/search.ts"), "utf8").split("\n")[3]).toContain("+ term +");
    },
    SLOW,
  );

  const SLUG_TURNS = (second: string) => `case "$turn" in
1)
  ${write("src/slug.ts", "export function slugify(title) {", '  return title.trim().toLowerCase().split(/\\s+/).join("-");', "}")}
  echo 'added slugify' >>CHANGELOG.md
  ;;
2)
  ${second}
  ;;
esac
${finish()}`;
  const CORRECTED = `${write("src/slug.ts", "export function slugify(title) {", '  return title.trim().toLowerCase().split(/\\s+/).join("_");', "}")}
  printf '# Changelog\\n' >CHANGELOG.md`;

  test(
    "a continuation passes when the correction lands on the same thread",
    async () => {
      const h = harness(SLUG_TURNS(CORRECTED));
      expect(await main(["run", "continuation", "--variant", "baseline"], h.ctx)).toBe(0);
      const [first, second] = readFileSync(argvLog(h), "utf8").trim().split("\n");
      expect(first).not.toContain(" resume ");
      expect(second).toContain(` resume `);
      expect(second).toContain(THREAD);
    },
    SLOW,
  );

  test.each([
    ["keeps the superseded separator", ":", "behaviour:corrected-separator"],
    [
      "leaves the changelog edit it was told to undo",
      write(
        "src/slug.ts",
        "export function slugify(title) {",
        '  return title.trim().toLowerCase().split(/\\s+/).join("_");',
        "}",
      ),
      "no-unexpected-changes",
    ],
  ])(
    "a continuation fails when the agent %s",
    async (_name, second, failing) => {
      const h = harness(SLUG_TURNS(second));
      expect(await main(["run", "continuation", "--variant", "baseline"], h.ctx)).toBe(1);
      expect(failedIds(onlyRecord(h))).toContain(failing);
    },
    SLOW,
  );

  test(
    "a continuation stays incomplete when the second turn starts a different thread",
    async () => {
      const h = harness(`[ "$turn" = 2 ] && thread=${OTHER_THREAD}\n${finish()}`);
      expect(await main(["run", "continuation", "--variant", "baseline"], h.ctx)).toBe(3);
      expect(onlyRecord(h).incompleteReason).toBe("thread-mismatch");
    },
    SLOW,
  );
});

describe("baseline and light", () => {
  const SLUG_DONE = `${write("src/slug.ts", "export function slugify(title) {", '  return title.trim().toLowerCase().split(/\\s+/).join("_");', "}")}\n${finish()}`;

  test(
    "only light selects the profile, on every turn, and neither uses a bypass flag",
    async () => {
      const h = harness(SLUG_DONE);
      installLightProfile(h);
      expect(await main(["run", "continuation", "--variant", "baseline"], h.ctx)).toBe(0);
      // The stub reuses one thread id, and a real second run would have its own session record.
      rmSync(join(h.root, "turn"));
      rmSync(join(h.codexHome, "sessions"), { recursive: true });
      expect(await main(["run", "continuation", "--variant", "light"], h.ctx)).toBe(0);

      const lines = readFileSync(argvLog(h), "utf8").trim().split("\n");
      expect(lines).toHaveLength(4);
      expect(lines.map((line) => line.includes("--profile light"))).toEqual([false, false, true, true]);
      for (const line of lines) {
        expect(line).not.toMatch(/--dangerously|--skip-git-repo-check|--ignore-rules|--ignore-user-config|--ephemeral/);
      }
      const summary = await summarize(h);
      expect(summary.map((row) => [row.variant, row.effort, row.comparison])).toEqual([
        ["baseline", "xhigh", "comparable"],
        ["light", "medium", "comparable"],
      ]);
    },
    SLOW,
  );

  const summarize = async (h: Harness) => {
    h.out.length = 0;
    expect(await main(["summary"], h.ctx)).toBe(0);
    const [header, ...rows] = (h.out[0] ?? "").split("\n");
    const names = (header ?? "").split("\t");
    return rows.map((row) => Object.fromEntries(row.split("\t").map((cell, index) => [names[index], cell])));
  };

  test("a light run that resumes at another effort is recorded as mixed and not comparable", () => {
    const rollout = (effort: string) => JSON.stringify({ type: "turn_context", payload: { model: "m", effort } });
    expect(parseRollout(`${rollout("medium")}\n${rollout("xhigh")}`).effort).toBe("mixed");
    const mixed = record({ variant: "light", identity: { ...IDENTITY, effort: "mixed" } });
    expect(renderSummary({ records: [record(), mixed], malformed: 0, omitted: 0 })).toContain(
      "incomparable:unknown-identity",
    );
  });
});

const IDENTITY: Identity = {
  cli: "codex",
  cliVersion: "0.167.0",
  provider: "openai",
  model: "gpt-test",
  effort: "xhigh",
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
  sandbox: "workspace-write",
  serviceTier: "default",
};

let recordCount = 0;

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const suffix = (recordCount++).toString(16).padStart(8, "0");
  const variant = overrides.variant ?? "baseline";
  const caseId = overrides.caseId ?? "bug-fix";
  const runId = `20261109T000000Z-${caseId}-${variant}-${suffix}`;
  return {
    schemaVersion: 1,
    runId,
    caseId,
    caseRevision: "aaaaaaaaaaaa",
    variant,
    startedAt: "2026-11-09T00:00:00.000Z",
    elapsedMs: 1000,
    outcome: "pass",
    incompleteReason: null,
    exitCode: 0,
    signal: null,
    identity: IDENTITY,
    assertions: [{ id: "required-changes", pass: true, count: 0 }],
    evidence: `evidence/${runId}`,
    ...overrides,
  };
}

const failing: Partial<RunRecord> = { outcome: "fail", assertions: [{ id: "behaviour:x", pass: false }] };
const incomplete: Partial<RunRecord> = { outcome: "incomplete", incompleteReason: "timeout", assertions: [] };

describe("reading records", () => {
  test("accepts a well-formed record of each outcome", () => {
    for (const row of [record(), record(failing), record(incomplete)]) {
      expect(parseRecord(row, row.runId)).toBeDefined();
    }
  });

  test.each<[string, (row: RunRecord) => unknown]>([
    ["a pass with a failed assertion", (row) => ({ ...row, assertions: [{ id: "x", pass: false }] })],
    ["a pass with no assertions", (row) => ({ ...row, assertions: [] })],
    ["a pass that also names an incomplete reason", (row) => ({ ...row, incompleteReason: "timeout" })],
    ["a fail whose assertions all pass", (row) => ({ ...row, outcome: "fail" })],
    ["an incomplete run with no reason", (row) => ({ ...row, outcome: "incomplete" })],
    ["an incomplete run with an invented reason", (row) => ({ ...row, outcome: "incomplete", incompleteReason: "ok" })],
    ["an unknown outcome", (row) => ({ ...row, outcome: "great" })],
    ["another schema version", (row) => ({ ...row, schemaVersion: 2 })],
    ["a run id that is not the file name", (row) => ({ ...row, runId: "other" })],
    ["an unknown case", (row) => ({ ...row, caseId: "../../x" })],
    ["an unknown variant", (row) => ({ ...row, variant: "heavy" })],
    ["a revision with path characters", (row) => ({ ...row, caseRevision: "../aaaaaaaaa" })],
    ["a bad timestamp", (row) => ({ ...row, startedAt: "yesterday" })],
    ["a negative elapsed time", (row) => ({ ...row, elapsedMs: -1 })],
    ["a fractional elapsed time", (row) => ({ ...row, elapsedMs: 1.5 })],
    ["an impossible elapsed time", (row) => ({ ...row, elapsedMs: 1e12 })],
    ["a text exit code", (row) => ({ ...row, exitCode: "0" })],
    ["evidence pointing elsewhere", (row) => ({ ...row, evidence: "../../etc" })],
    ["a model name with a tab", (row) => ({ ...row, identity: { ...IDENTITY, model: "a\tb" } })],
    ["a missing identity field", (row) => ({ ...row, identity: { cli: "codex" } })],
    ["free text in an assertion", (row) => ({ ...row, assertions: [{ id: "has space", pass: true }] })],
    ["a non-boolean assertion", (row) => ({ ...row, assertions: [{ id: "x", pass: "yes" }] })],
    ["too many assertions", (row) => ({ ...row, assertions: Array(65).fill({ id: "x", pass: true }) })],
  ])("rejects %s", (_name, corrupt) => {
    const row = record();
    expect(parseRecord(corrupt(row), row.runId)).toBeUndefined();
  });

  test.each([[null], [[]], ["text"], [1]])("rejects %j", (value) => {
    expect(parseRecord(value, "20261109T000000Z-bug-fix-baseline-00000000")).toBeUndefined();
  });

  test("the summary never counts a malformed file as a pass and skips an unfinished one", async () => {
    const h = harness("");
    mkdirSync(runsDir(h), { recursive: true });
    const good = record();
    writeFileSync(join(runsDir(h), `${good.runId}.json`), JSON.stringify(good));
    writeFileSync(join(runsDir(h), "truncated.json"), '{"outcome":"pass"');
    const forged = { ...record(), assertions: [] };
    writeFileSync(join(runsDir(h), `${forged.runId}.json`), JSON.stringify(forged));
    writeFileSync(join(runsDir(h), "huge.json"), " ".repeat(65 * 1024));
    mkdirSync(join(runsDir(h), "directory.json"));
    symlinkSync(join(runsDir(h), `${good.runId}.json`), join(runsDir(h), "linked.json"));
    writeFileSync(join(runsDir(h), `${good.runId}.json.123.tmp`), "{");

    expect(await main(["summary"], h.ctx)).toBe(0);
    const [header, row, ...rest] = h.out[0]!.split("\n");
    const cells = Object.fromEntries(row!.split("\t").map((cell, index) => [header!.split("\t")[index], cell]));
    expect([cells.runs, cells.pass]).toEqual(["1", "1"]);
    expect(rest).toEqual(["malformed_records: 5 (pass に数えない)"]);
  });

  test("the summary reports no evaluation when there are no records, and starts no process", async () => {
    const h = harness(finish());
    expect(await main(["summary"], h.ctx)).toBe(0);
    expect(h.out).toEqual([NO_RECORDS]);
    expect(launched(h)).toBe(false);
    expect(existsSync(runsDir(h))).toBe(false);
  });

  test("the summary leaves out runs older than the requested start", async () => {
    const h = harness("");
    mkdirSync(runsDir(h), { recursive: true });
    const old = record({ startedAt: "2020-01-01T00:00:00.000Z" });
    writeFileSync(join(runsDir(h), `${old.runId}.json`), JSON.stringify(old));
    expect(await main(["summary", "--since-ms", String(Date.parse("2021-01-01"))], h.ctx)).toBe(0);
    expect(h.out).toEqual([NO_RECORDS]);
  });
});

describe("comparing variants", () => {
  const light = (overrides: Partial<RunRecord> = {}) =>
    record({ variant: "light", identity: { ...IDENTITY, effort: "medium" }, ...overrides });
  const comparisonOf = (records: RunRecord[]) =>
    renderSummary({ records, malformed: 0, omitted: 0 })
      .split("\n")
      .slice(1)
      .map((line) => line.split("\t").at(-1));

  test("calls identical settings at different efforts comparable", () => {
    expect(comparisonOf([record(), light()])).toEqual(["comparable", "comparable"]);
  });

  test.each<[string, Partial<RunRecord>, string]>([
    ["model", { identity: { ...IDENTITY, effort: "medium", model: "gpt-other" } }, "model"],
    ["CLI version", { identity: { ...IDENTITY, effort: "medium", cliVersion: "0.168.0" } }, "cli-version"],
    ["sandbox", { identity: { ...IDENTITY, effort: "medium", sandbox: "read-only" } }, "settings"],
    ["approval policy", { identity: { ...IDENTITY, effort: "medium", approvalPolicy: "never" } }, "settings"],
    ["service tier", { identity: { ...IDENTITY, effort: "medium", serviceTier: "flex" } }, "settings"],
    ["case revision", { caseRevision: "bbbbbbbbbbbb" }, "case-revision"],
    ["effort that did not change", { identity: IDENTITY }, "same-effort"],
  ])("flags a different %s instead of comparing", (_name, overrides, reason) => {
    expect(comparisonOf([record(), light(overrides)])).toEqual([`incomparable:${reason}`, `incomparable:${reason}`]);
  });

  test("flags an identity it could not observe", () => {
    const rows = comparisonOf([record(), light({ identity: UNKNOWN_IDENTITY })]);
    expect(rows[0]).toContain("unknown-identity");
  });

  test("says when the other variant has no runs", () => {
    expect(comparisonOf([record()])).toEqual(["no-counterpart"]);
  });

  test("keeps cases apart", () => {
    expect(comparisonOf([record(), light({ caseId: "review" })])).toEqual(["no-counterpart", "no-counterpart"]);
  });

  test("uses a comparable pair even when an older incomparable group exists", () => {
    const old = light({ caseRevision: "bbbbbbbbbbbb", startedAt: "2020-01-01T00:00:00.000Z" });
    expect(comparisonOf([record(), light(), old])[0]).toBe("comparable");
  });

  test("charges failed runs to the cost of a pass and leaves incomplete runs out", () => {
    const rows = renderSummary({
      records: [
        record({ elapsedMs: 1000 }),
        record({ elapsedMs: 3000 }),
        record({ ...failing, elapsedMs: 4000 }),
        record({ ...incomplete, elapsedMs: 90000 }),
      ],
      malformed: 0,
      omitted: 0,
    }).split("\n");
    const names = rows[0]!.split("\t");
    const cells = Object.fromEntries(rows[1]!.split("\t").map((cell, index) => [names[index], cell]));
    expect(cells).toMatchObject({
      runs: "4",
      pass: "2",
      fail: "1",
      incomplete: "1",
      median_pass_ms: "2000",
      ms_per_pass: "4000",
    });
  });

  test("shows no time for a group with no pass", () => {
    const cells = renderSummary({ records: [record(failing)], malformed: 0, omitted: 0 })
      .split("\n")[1]!
      .split("\t");
    expect(cells.slice(11, 13)).toEqual(["-", "-"]);
  });

  test("states how many old records it did not read", () => {
    expect(renderSummary({ records: [], malformed: 0, omitted: 3 })).toContain("omitted_records: 3");
  });
});

describe("parsing arguments", () => {
  test.each<[string[], object]>([
    [["run", "bug-fix", "--variant", "baseline"], { caseId: "bug-fix", variant: "baseline", timeoutMs: 1_200_000 }],
    [["run", "review", "--variant", "light", "--timeout-seconds", "7200"], { caseId: "review", timeoutMs: 7_200_000 }],
    [["run", "continuation", "--timeout-seconds", "1", "--variant", "light"], { timeoutMs: 1000 }],
    [["summary"], { kind: "summary", sinceMs: 0 }],
    [["summary", "--since-ms", "5"], { sinceMs: 5 }],
  ])("accepts %j", (argv, want) => {
    expect(parseArgs(argv)).toMatchObject(want);
  });

  test.each([
    [[]],
    [["other"]],
    [["run"]],
    [["run", "bug-fix", "--variant"]],
    [["run", "bug-fix", "--variant", "baseline", "extra"]],
    [["run", "bug-fix", "--variant", "baseline", "--variant", "light"]],
    [["run", "bug-fix", "--variant", "baseline", "--timeout-seconds", "7201"]],
    [["run", "bug-fix", "--variant", "baseline", "--timeout-seconds", "1e3"]],
    [["run", "bug-fix", "--variant", "baseline", "--timeout-seconds", "-1"]],
    [["run", "bug fix", "--variant", "baseline"]],
    [["run", "constructor", "--variant", "baseline"]],
    [["run", "bug-fix", "--unknown", "x", "--variant", "baseline"]],
    [["summary", "--since-ms", "yesterday"]],
    [["summary", "extra"]],
  ])("rejects %j", (argv) => {
    expect(parseArgs(argv)).toBeUndefined();
  });
});

describe("reading the CLI's events", () => {
  const clean: ChildResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    interrupted: false,
    overLimit: false,
    launchError: false,
  };
  const done = { threadId: THREAD, completed: 1, failed: 0 };
  const ok: FinalOutput = { state: "ok", value: {} };

  test("a warning item and stray text do not end a turn", () => {
    const events = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      "not json",
      JSON.stringify({ type: "item.completed", item: { type: "error", message: "warning" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n");
    expect(parseEvents(events)).toEqual(done);
  });

  test("a thread id that is not a UUID is not believed", () => {
    expect(parseEvents(JSON.stringify({ type: "thread.started", thread_id: "../../x" })).threadId).toBeUndefined();
  });

  test.each<[string, ChildResult, string | undefined]>([
    ["a clean turn", clean, undefined],
    ["an interruption over everything else", { ...clean, interrupted: true, timedOut: true }, "interrupted"],
    ["a timeout", { ...clean, timedOut: true, exitCode: null }, "timeout"],
    ["too much output", { ...clean, overLimit: true }, "output-limit"],
    ["a launch failure", { ...clean, launchError: true, exitCode: null }, "launch-failed"],
    ["death by signal", { ...clean, exitCode: null, signal: "SIGKILL" }, "exit-nonzero"],
  ])("judges %s", (_name, child, want) => {
    expect(turnProblem(child, done, ok) as string | undefined).toBe(want);
  });

  test("the second turn has to stay on the first turn's thread", () => {
    expect(turnProblem(clean, done, ok, THREAD)).toBeUndefined();
    expect(turnProblem(clean, done, ok, OTHER_THREAD)).toBe("thread-mismatch");
  });
});

describe("reading the CLI's session record", () => {
  const rows = [
    { type: "session_meta", payload: { cli_version: "0.167.0", model_provider: "openai" } },
    {
      type: "turn_context",
      payload: {
        model: "gpt-test",
        effort: "medium",
        approval_policy: "on-request",
        approvals_reviewer: "auto_review",
        sandbox_policy: { type: "workspace-write" },
      },
    },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } } },
  ];
  const text = (list: object[]) => list.map((row) => JSON.stringify(row)).join("\n");

  test("takes identity from the record's own fields", () => {
    expect(parseRollout(text(rows))).toEqual({ ...IDENTITY, effort: "medium" });
  });

  test("ignores what the agent wrote about itself", () => {
    const claim = { type: "response_item", payload: { type: "message", model: "gpt-self-reported", effort: "low" } };
    expect(parseRollout(text([...rows, claim])).model).toBe("gpt-test");
  });

  test("says unknown when the record has nothing to read", () => {
    expect(parseRollout("")).toEqual(UNKNOWN_IDENTITY);
    expect(parseRollout("garbage\n{}")).toEqual(UNKNOWN_IDENTITY);
  });

  test("does not let a strange value into the record", () => {
    const strange = { type: "turn_context", payload: { model: "a\tb\nc", effort: null } };
    expect(parseRollout(text([strange]))).toMatchObject({ model: "unknown", effort: "unknown" });
  });
});

describe("grading", () => {
  const review = (findings: unknown): Assertion[] =>
    grade(CASES.review, { output: { findings }, changed: [], checks: new Map() });
  const failedOf = (assertions: Assertion[]) => assertions.filter((a) => !a.pass).map((a) => a.id);
  const countOf = (assertions: Assertion[]) => assertions.find((a) => a.id === "false-positives")?.count;
  const session = { file: "src/session.ts", line: 8, summary: "" };
  const retry = { file: "src/retry.ts", line: 4, summary: "" };
  const search = { file: "src/search.ts", line: 4, summary: "" };

  test("a review with every seed and nothing else passes, however it is worded", () => {
    expect(failedOf(review([session, retry, search]))).toEqual([]);
    expect(failedOf(review([{ ...session, file: "./src/session.ts", line: 9 }, retry, search]))).toEqual([]);
  });

  test("a missed seed fails that seed", () => {
    expect(failedOf(review([session, retry]))).toEqual(["seed:sql-from-input"]);
  });

  test("an empty review misses every seed", () => {
    expect(failedOf(review([]))).toEqual(["seed:inverted-expiry", "seed:extra-retry", "seed:sql-from-input"]);
  });

  test("flagging the correct decoy rewrite is a false positive", () => {
    const assertions = review([session, retry, search, { file: "src/total.ts", line: 2, summary: "" }]);
    expect(failedOf(assertions)).toEqual(["false-positives"]);
    expect(countOf(assertions)).toBe(1);
  });

  test("a finding in the right file on a distant line neither finds the seed nor goes uncounted", () => {
    const assertions = review([{ ...session, line: 12 }, retry, search]);
    expect(failedOf(assertions)).toEqual(["seed:inverted-expiry", "false-positives"]);
    expect(countOf(assertions)).toBe(1);
  });

  test("two findings on one seed count once and are not false positives", () => {
    const assertions = review([session, { ...session, line: 7 }, retry, search]);
    expect(failedOf(assertions)).toEqual([]);
    expect(countOf(assertions)).toBe(0);
  });

  test("a finding with the wrong shape is a false positive", () => {
    expect(countOf(review([session, retry, search, "looks bad", { file: 1, line: "x" }]))).toBe(2);
  });

  test("a review output without findings fails", () => {
    const assertions = grade(CASES.review, { output: { summary: "all good" }, changed: [], checks: new Map() });
    expect(failedOf(assertions)).toEqual(["findings-present"]);
  });

  test("a behaviour check with no result fails", () => {
    const assertions = grade(CASES["bug-fix"], {
      output: {},
      changed: ["src/paginate.ts"],
      checks: new Map([["empty-list", true]]),
    });
    expect(failedOf(assertions)).toContain("behaviour:exact-multiple");
    expect(failedOf(assertions)).not.toContain("behaviour:empty-list");
  });
});

describe("comparing the workspace", () => {
  const expected = new Map([
    ["a", "1"],
    ["b", "2"],
  ]);

  test.each<[string, [string, string | null][], string[]]>([
    [
      "nothing changed",
      [
        ["a", "1"],
        ["b", "2"],
      ],
      [],
    ],
    [
      "an edit",
      [
        ["a", "x"],
        ["b", "2"],
      ],
      ["a"],
    ],
    ["a deletion", [["a", "1"]], ["b"]],
    [
      "a new file",
      [
        ["a", "1"],
        ["b", "2"],
        ["c", "3"],
      ],
      ["c"],
    ],
    [
      "a symlink or oversized file",
      [
        ["a", null],
        ["b", "2"],
      ],
      ["a"],
    ],
    [
      "a file named after an object property",
      [
        ["a", "1"],
        ["b", "2"],
        ["__proto__", "x"],
      ],
      ["__proto__"],
    ],
  ])("finds %s", (_name, actual, want) => {
    expect(changedPaths(expected, new Map(actual))).toEqual(want);
  });
});

describe("the light profile", () => {
  test.each<[string, unknown, boolean]>([
    ["only the effort", { model_reasoning_effort: "medium" }, true],
    ["another setting beside it", { model_reasoning_effort: "medium", model: "other" }, false],
    ["another setting instead", { approval_policy: "never" }, false],
    ["nothing", {}, false],
    ["a non-table", "text", false],
  ])("judges a profile with %s", (_name, parsed, allowed) => {
    expect(lightProfileProblem(parsed) === undefined).toBe(allowed);
  });
});

describe("the behaviour check harness", () => {
  const CHECK = { id: "c", module: "m.ts", fn: "f", args: [2], want: 4 };

  async function run(source: string | undefined, checks = [CHECK]): Promise<string[]> {
    const dir = join(base, `check${harnessCount++}`);
    mkdirSync(dir, { recursive: true });
    if (source !== undefined) writeFileSync(join(dir, "m.ts"), source);
    const lines: string[] = [];
    await runChecks(dir, checks, (line) => lines.push(line));
    return lines;
  }

  test.each<[string, string | undefined, boolean]>([
    ["the expected value", "export const f = (n) => n * 2;", true],
    ["an async function with the expected value", "export const f = async (n) => n * 2;", true],
    ["another value", "export const f = (n) => n * 3;", false],
    ["a value of another type", 'export const f = () => "4";', false],
    ["a throw", 'export const f = () => { throw new Error("x"); };', false],
    ["no such export", "export const g = () => 4;", false],
    ["an export that is not a function", "export const f = 4;", false],
    ["a syntax error", "export const f = (", false],
    ["a missing module", undefined, false],
  ])("reports %s", async (_name, source, pass) => {
    const parsed = parseCheckOutput((await run(source)).join("\n"), ["c"]);
    expect(parsed.started).toBe(true);
    expect(parsed.results.get("c")).toBe(pass);
  });

  test("a line the check did not ask about is ignored and a repeated failure stays failed", () => {
    const lines = [
      '{"agentEvalCheck":"started"}',
      "ordinary output",
      '{"agentEvalCheck":"unknown","pass":true}',
      '{"agentEvalCheck":"c","pass":false}',
      '{"agentEvalCheck":"c","pass":true}',
      '{"agentEvalCheck":"d","pass":"yes"}',
    ].join("\n");
    const parsed = parseCheckOutput(lines, ["c", "d"]);
    expect(parsed.results.get("c")).toBe(false);
    expect(parsed.results.has("d")).toBe(false);
    expect(parsed.results.has("unknown")).toBe(false);
  });

  test("output that never says it started means the harness did not run", () => {
    expect(parseCheckOutput("sandbox unavailable", ["c"]).started).toBe(false);
  });
});
