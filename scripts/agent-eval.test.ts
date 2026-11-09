import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
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
import { dirname, join } from "node:path";
import { type Ctx, main } from "./agent-eval.ts";
import { assertionIds, CASES, grade } from "./agent-eval-cases.ts";
import {
  type Assertion,
  asRow,
  type CaseId,
  type ChildResult,
  changedPaths,
  checkPasses,
  type FinalOutput,
  type Identity,
  lightProfileProblem,
  NO_RECORDS,
  parseArgs,
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

const clean: ChildResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  interrupted: false,
  overLimit: false,
  launchError: false,
};

const evidence = (fn: string, input: unknown, expected: unknown, observed: unknown) => ({
  function: fn,
  input: JSON.stringify(input),
  expected: JSON.stringify(expected),
  observed: JSON.stringify(observed),
});
// "the evidence the grader accepts" below runs the fixture against these.
const SESSION_INPUT = { session: { userId: "u", expiresAtMs: 100 }, nowMs: 100 };
const TERM = "x' OR '1'='1";
const SEARCH_BOUND = { sql: "SELECT id FROM notes WHERE title = ?", params: [TERM] };
const SEARCH_BUILT = { sql: `SELECT id FROM notes WHERE title = '${TERM}'`, params: [] };
const FOUND_SESSION = {
  file: "src/session.ts",
  line: 8,
  summary: "",
  counterexample: evidence("isExpired", SESSION_INPUT, true, false),
};
const FOUND_RETRY = {
  file: "src/retry.ts",
  line: 4,
  summary: "",
  counterexample: evidence("withRetry", { maxAttempts: 3 }, 3, 4),
};
const FOUND_SEARCH = {
  file: "src/search.ts",
  line: 4,
  summary: "",
  counterexample: evidence("searchNotes", { term: TERM }, SEARCH_BOUND, SEARCH_BUILT),
};
const FOUND = [FOUND_SESSION, FOUND_RETRY, FOUND_SEARCH];

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
      expect(parseRecord(record, record.runId, assertionIds)).toBeDefined();
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
      expect(parseRecord(record, record.runId, assertionIds)).toBeDefined();
    },
    SLOW,
  );

  test.each([
    ["the CLI exits nonzero", `${REPAIR}\n${finish()}\nexit 7`, "exit-nonzero"],
    ["no final output is written", `${REPAIR}\ncomplete_turn`, "output-missing"],
    ["the final output is not JSON", `${REPAIR}\nfinal 'all done'\ncomplete_turn`, "output-malformed"],
    ["the final output is null", `${REPAIR}\nfinal 'null'\ncomplete_turn`, "output-malformed"],
    ["the final output is an array", `${REPAIR}\nfinal '[]'\ncomplete_turn`, "output-malformed"],
    ["the final output lacks its required field", `${REPAIR}\nfinal '{}'\ncomplete_turn`, "output-malformed"],
    [
      "the final output has a field of the wrong type",
      `${REPAIR}\nfinal '{"summary":1}'\ncomplete_turn`,
      "output-malformed",
    ],
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
        '  console.error("printed " + process.env.SECRET_CANARY);',
        "  return process.env.SECRET_CANARY ? -1 : Math.ceil(total / pageSize);",
        "}",
      );
      const h = harness(`${hostile}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(0);
      const record = onlyRecord(h);
      expect(existsSync(join(evidencePath(h, record), "check.stdout"))).toBe(false);
      expect(existsSync(join(evidencePath(h, record), "check.stderr.log"))).toBe(false);
      expect(readFileSync(join(runsDir(h), `${record.runId}.json`), "utf8")).not.toContain("printed");
    },
    SLOW,
  );

  test(
    "treats a sandbox that cannot start as incomplete, keeping how it ended but not what it printed",
    async () => {
      const h = harness(`${REPAIR}\n${finish()}`);
      writeFileSync(
        join(h.root, "bin/codex"),
        readFileSync(join(h.root, "bin/codex"), "utf8").replace('exec "$@"', `echo '${CANARY}' >&2\nexit 1`),
      );
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.incompleteReason).toBe("harness-error");
      const evidence = evidencePath(h, record);
      expect(existsSync(join(evidence, "check.stderr.log"))).toBe(false);
      const status = readFileSync(join(evidence, "check.status.json"), "utf8");
      expect(JSON.parse(status)).toMatchObject({ sandbox: { exitCode: 1 }, checks: [] });
      expect(status).not.toContain(CANARY);
    },
    SLOW,
  );
});

describe("a behaviour check, which asks the public CLI as an outside consumer", () => {
  const RIGHT_VALUES = {
    "empty-list": 0,
    "one-item": 1,
    "exact-page": 1,
    "just-over-a-page": 2,
    "exact-multiple": 2,
    "partial-last-page": 3,
    "report-footer": "2 page(s)",
  };
  const IDS = Object.keys(RIGHT_VALUES);
  const ALL_CHECKS = IDS.map((id) => `behaviour:${id}`);
  const print = (row: object) => `console.log(${JSON.stringify(JSON.stringify(row))});`;
  const library = (...lines: string[]) => write("src/paginate.ts", ...lines);
  const wrongLibrary = (...lines: string[]) => library(...lines, "export const pageCount = () => -1;");
  const answersThen = (...ending: string[]) =>
    library(
      "export function pageCount(total, pageSize) {",
      "  console.log(JSON.stringify(Math.ceil(total / pageSize)));",
      ...ending,
      "}",
    );
  const correctWith = (...before: string[]) =>
    library(...before, "export function pageCount(total, pageSize) {", "  return Math.ceil(total / pageSize);", "}");

  test.each<[string, string]>([
    [
      "prints the old passing verdict for every check and exits 0",
      wrongLibrary(...IDS.map((id) => print({ id, pass: true })), "process.exit(0);"),
    ],
    [
      "prints the old row of the right value for every check and exits 0",
      wrongLibrary(
        ...Object.entries(RIGHT_VALUES).map(([id, value]) => print({ agentEvalCheck: id, value })),
        "process.exit(0);",
      ),
    ],
    ["exits 0 without answering", library("export function pageCount() {", "  process.exit(0);", "}")],
    [
      "answers with the start of a JSON value and exits 0",
      library("export function pageCount() {", '  process.stdout.write("{");', "  process.exit(0);", "}"),
    ],
    ["prints something else beside correct answers", correctWith('console.log("debug");')],
    ["prints the right answer and returns it as well", answersThen("  return Math.ceil(total / pageSize);")],
    ["prints the right answer and then exits nonzero", answersThen("  process.exit(7);")],
    ["prints the right answer and then dies by signal", answersThen('  process.kill(process.pid, "SIGKILL");')],
    ["returns a wrong value", library("export const pageCount = () => -1;")],
    ["returns nothing", library("export const pageCount = () => undefined;")],
    ["returns a value JSON cannot carry", library("export const pageCount = () => 4n;")],
    ["returns a circular value", library("export const pageCount = () => { const a = {}; a.a = a; return a; };")],
    ["throws", library('export const pageCount = () => { throw new Error("x"); };')],
    ["has no such export", library("export const other = () => 4;")],
    ["exports something that is not a function", library("export const pageCount = 4;")],
    ["has a syntax error", library("export const pageCount = (")],
  ])(
    "every check fails when the library %s",
    async (_name, scenario) => {
      const h = harness(`${scenario}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      const record = onlyRecord(h);
      expect(record.outcome).toBe("fail");
      expect(failedIds(record)).toEqual(ALL_CHECKS);
    },
    SLOW,
  );

  test(
    "a number returned as text fails only the checks that read the number",
    async () => {
      const text = library("export const pageCount = (total, pageSize) => String(Math.ceil(total / pageSize));");
      const h = harness(`${text}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      expect(failedIds(onlyRecord(h))).toEqual(ALL_CHECKS.filter((id) => id !== "behaviour:report-footer"));
    },
    SLOW,
  );

  test(
    "a handle the library leaves open does not hold back a correct answer",
    async () => {
      const h = harness(`${correctWith("setInterval(() => {}, 1000);")}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(0);
    },
    SLOW,
  );

  test(
    "a library that was never written leaves the operations of the others answering",
    async () => {
      const h = harness(finish());
      expect(await main(["run", "continuation", "--variant", "baseline"], h.ctx)).toBe(1);
      expect(failedIds(onlyRecord(h))).toEqual([
        "behaviour:corrected-separator",
        "behaviour:single-word",
        "required-changes",
      ]);
    },
    SLOW,
  );

  const FORGED_CLI = write(
    "cli.ts",
    "const { total } = JSON.parse(process.argv[3]);",
    "const pages = Math.ceil(total / 10);",
    'console.log(JSON.stringify(process.argv[2] === "footer" ? pages + " page(s)" : pages));',
  );

  test.each<[string, string, string[]]>([
    ["edits the CLI beside a correct repair", `${REPAIR}\necho '// note' >>cli.ts`, ["no-unexpected-changes"]],
    ["deletes the CLI beside a correct repair", `${REPAIR}\nrm cli.ts`, [...ALL_CHECKS, "no-unexpected-changes"]],
    ["rewrites the CLI to give every right answer", FORGED_CLI, ["required-changes", "no-unexpected-changes"]],
  ])(
    "fails when the agent %s",
    async (_name, scenario, failed) => {
      const h = harness(`${scenario}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      expect(failedIds(onlyRecord(h))).toEqual(failed);
    },
    SLOW,
  );

  test(
    "neither the expected value nor the name of the check reaches the code being checked",
    async () => {
      const snooping = library(
        "export function pageCount(total, pageSize) {",
        '  const seen = /"want"|empty-list|exact-multiple/.test(process.argv.join(" "));',
        "  return seen ? -1 : Math.ceil(total / pageSize);",
        "}",
      );
      const h = harness(`${snooping}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(0);
    },
    SLOW,
  );

  test(
    "keeps how each request ended for diagnosis but nothing the code printed",
    async () => {
      const noisy = wrongLibrary(`console.log("${CANARY}");`, `console.error("${CANARY}");`, "process.exit(7);");
      const h = harness(`${noisy}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      const evidence = evidencePath(h, onlyRecord(h));
      const status = readFileSync(join(evidence, "check.status.json"), "utf8");
      expect(JSON.parse(status).checks[0]).toMatchObject({ id: "empty-list", pass: false, exitCode: 7, signal: null });
      expect(status).not.toContain(CANARY);
      expect(existsSync(join(evidence, "check.stdout"))).toBe(false);
      expect(existsSync(join(evidence, "check.stderr.log"))).toBe(false);
    },
    SLOW,
  );
});

describe("the public CLI of a fixture", () => {
  function fixture(): string {
    const dir = join(base, `cli${harnessCount++}`);
    for (const [path, text] of Object.entries(CASES["bug-fix"].files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }
  const ask = (dir: string, operation: string, input: string) =>
    spawnSync(
      process.execPath,
      ["run", "--config=/dev/null", "--no-install", "--no-env-file", join(dir, "cli.ts"), operation, input],
      { cwd: dir, env: { HOME: dir, PATH: "/usr/bin:/bin" }, encoding: "utf8" },
    );

  test("answers a request for a declared operation with one JSON value and exit 0", () => {
    const run = ask(fixture(), "pageCount", '{"total":20,"pageSize":10}');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("3\n");
  });

  test.each([["src/paginate.ts"], ["../../src/paginate.ts"], ["constructor"], ["__proto__"], [""]])(
    "refuses the operation %j and prints no result",
    (operation) => {
      const run = ask(fixture(), operation, "{}");
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
    },
  );

  test("refuses input that is not JSON and prints no result", () => {
    const run = ask(fixture(), "pageCount", "not json");
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
  });
});

// Returns the file that exists once the preload has run.
function plantPreload(dir: string): string {
  const marker = join(dir, "preload-ran");
  writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(
    join(dir, "preload.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  return marker;
}

describe("a bunfig.toml the evaluator did not write", () => {
  test("the summary ignores one in the current directory, which an ordinary launch would preload", () => {
    const dir = join(base, `bunfig${harnessCount++}`);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    const marker = plantPreload(dir);
    writeFileSync(join(dir, "entry.ts"), "");
    const options = { cwd: dir, env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" } as const;

    spawnSync(process.execPath, ["run", "--no-install", "--no-env-file", join(dir, "entry.ts")], options);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const run = spawnSync(join(import.meta.dir, "agent-eval"), ["summary"], options);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(NO_RECORDS);
    expect(existsSync(marker)).toBe(false);
  });

  test(
    "the behaviour check ignores one the agent wrote, so its preload cannot run ahead of the public CLI",
    async () => {
      const config = write("bunfig.toml", 'preload = ["./preload.ts"]');
      const preload = write("preload.ts", `console.error("${CANARY}");`, "process.exit(1);");
      const h = harness([REPAIR, config, preload, finish()].join("\n"));
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(1);
      const record = onlyRecord(h);
      expect(failedIds(record)).toEqual(["no-unexpected-changes"]);
      expect(existsSync(join(evidencePath(h, record), "check.stderr.log"))).toBe(false);
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
      expect(record.elapsedMs).toBeGreaterThanOrEqual(1000);
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

describe("the time a run records", () => {
  // Each scenario spends this long in one named step, far more than the rest of a stubbed run.
  const SPENT_SECONDS = 0.8;
  const AT_LEAST_MS = 750;

  test(
    "includes fixture setup, and survives a failure there",
    async () => {
      const h = harness(finish());
      rmSync(join(h.root, "bin/git"));
      writeFileSync(join(h.root, "bin/git"), `#!/bin/sh\nsleep ${SPENT_SECONDS}\nexit 1\n`, { mode: 0o755 });
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.incompleteReason).toBe("harness-error");
      expect(record.elapsedMs).toBeGreaterThanOrEqual(AT_LEAST_MS);
    },
    SLOW,
  );

  test(
    "includes the behaviour checks",
    async () => {
      const slowToLoad = write(
        "src/paginate.ts",
        `await Bun.sleep(${SPENT_SECONDS * 1000});`,
        "export function pageCount(total, pageSize) {",
        "  return Math.ceil(total / pageSize);",
        "}",
      );
      const h = harness(`${slowToLoad}\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(0);
      expect(onlyRecord(h).elapsedMs).toBeGreaterThanOrEqual(AT_LEAST_MS);
    },
    SLOW,
  );

  test(
    "a failure after the turns keeps the time spent and the model the CLI recorded",
    async () => {
      const h = harness(`sleep ${SPENT_SECONDS}\nworkspace=$PWD\ncd /\nrm -rf "$workspace"\n${finish()}`);
      expect(await main(["run", "bug-fix", "--variant", "baseline"], h.ctx)).toBe(3);
      const record = onlyRecord(h);
      expect(record.incompleteReason).toBe("harness-error");
      expect(record.elapsedMs).toBeGreaterThanOrEqual(AT_LEAST_MS);
      expect(record.identity.model).toBe("gpt-test");
    },
    SLOW,
  );
});

describe("the evaluation revision", () => {
  const SOURCES = ["agent-eval", "agent-eval.ts", "agent-eval-core.ts", "agent-eval-cases.ts"];

  // A real run from a private copy of the evaluator. A failed turn is enough: every record has a revision.
  function revisionOf(edited?: string): string {
    const copy = join(base, `copy${harnessCount++}`);
    mkdirSync(copy);
    for (const name of SOURCES) copyFileSync(join(import.meta.dir, name), join(copy, name));
    if (edited) appendFileSync(join(copy, edited), "\n// an edit\n");
    const h = harness("exit 7");
    const entry = join(copy, "agent-eval.ts");
    const run = spawnSync(
      process.execPath,
      ["run", "--config=/dev/null", "--no-install", "--no-env-file", entry, "run", "bug-fix", "--variant", "baseline"],
      { env: h.ctx.env as Record<string, string>, encoding: "utf8" },
    );
    expect(run.status).toBe(3);
    return onlyRecord(h).caseRevision;
  }

  test(
    "stays the same when nothing changed",
    () => {
      expect(revisionOf()).toBe(revisionOf());
    },
    SLOW,
  );

  test.each(SOURCES)(
    "moves when %s changes",
    (name) => {
      expect(revisionOf(name)).not.toBe(revisionOf());
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

describe("a value thrown instead of an Error", () => {
  test.each<[string, unknown, string]>([
    ["text", "disk full", "disk full"],
    ["an object whose text would reveal what it holds", { toString: () => CANARY }, "object"],
    ["an object that cannot become text", Object.create(null), "object"],
  ])("reports %s and ends as a failure", async (_name, thrown, want) => {
    const h = harness("");
    const env = {
      get XDG_STATE_HOME(): string {
        throw thrown;
      },
    };
    expect(await main(["summary"], { ...h.ctx, env })).toBe(1);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain(want);
    expect(h.err[0]).not.toContain(CANARY);
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
      const record = onlyRecord(h);
      expect(parseRecord(record, record.runId, assertionIds)).toBeDefined();
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

  test(
    "a review run reviews the seeded commit and passes when every seed is found",
    async () => {
      // The answer travels through a single-quoted shell word, and a JSON escape carries the quote past it.
      const answer = JSON.stringify({ findings: FOUND }).replaceAll("'", "\\u0027");
      const h = harness(finish(answer));
      expect(await main(["run", "review", "--variant", "baseline"], h.ctx)).toBe(0);
      const record = onlyRecord(h);
      expect(parseRecord(record, record.runId, assertionIds)).toBeDefined();
      const workspace = join(evidencePath(h, record), "workspace");
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
    "a continuation with a malformed first answer stops there instead of resuming",
    async () => {
      const h = harness(`final 'null'\ncomplete_turn`);
      expect(await main(["run", "continuation", "--variant", "baseline"], h.ctx)).toBe(3);
      expect(onlyRecord(h).incompleteReason).toBe("output-malformed");
      expect(readFileSync(argvLog(h), "utf8").trim().split("\n")).toHaveLength(1);
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
    assertions: allPassing(caseId),
    evidence: `evidence/${runId}`,
    ...overrides,
  };
}

const allPassing = (caseId: CaseId): Assertion[] => assertionIds(caseId).map((id) => ({ id, pass: true }));
const withFirstFailed = (assertions: Assertion[]): Assertion[] =>
  assertions.map((assertion, index) => (index === 0 ? { ...assertion, pass: false } : assertion));

const failing: Partial<RunRecord> = { outcome: "fail", assertions: withFirstFailed(allPassing("bug-fix")) };
const incomplete: Partial<RunRecord> = { outcome: "incomplete", incompleteReason: "timeout", assertions: [] };

describe("reading records", () => {
  test("accepts a well-formed record of each outcome", () => {
    for (const row of [record(), record(failing), record(incomplete), record({ caseId: "review" })]) {
      expect(parseRecord(row, row.runId, assertionIds)).toBeDefined();
    }
  });

  test("accepts a record whose assertions are listed in another order", () => {
    const row = record();
    const reordered = { ...row, assertions: row.assertions.toReversed() };
    expect(parseRecord(reordered, row.runId, assertionIds)).toBeDefined();
  });

  test.each<[string, (row: RunRecord) => unknown]>([
    ["a pass with a failed assertion", (row) => ({ ...row, assertions: withFirstFailed(row.assertions) })],
    ["a pass with no assertions", (row) => ({ ...row, assertions: [] })],
    [
      "a pass with one invented assertion and a failed exit",
      (row) => ({ ...row, assertions: [{ id: "x", pass: true }], exitCode: 7 }),
    ],
    ["a pass whose process failed", (row) => ({ ...row, exitCode: 7 })],
    ["a pass whose process died by signal", (row) => ({ ...row, exitCode: null, signal: "SIGKILL" })],
    ["a fail whose process failed", (row) => ({ ...row, ...failing, exitCode: 7 })],
    ["a pass with an assertion missing", (row) => ({ ...row, assertions: row.assertions.slice(1) })],
    [
      "a pass with an assertion nobody grades",
      (row) => ({ ...row, assertions: [...row.assertions, { id: "x", pass: true }] }),
    ],
    [
      "a pass with one assertion repeated in place of another",
      (row) => ({ ...row, assertions: [row.assertions[0], ...row.assertions.slice(0, -1)] }),
    ],
    ["a pass with another case's assertions", (row) => ({ ...row, assertions: allPassing("review") })],
    [
      "a passing assertion that counts problems",
      (row) => ({
        ...row,
        assertions: row.assertions.map((a) => (a.id === "required-changes" ? { ...a, count: 2 } : a)),
      }),
    ],
    ["an incomplete run that kept assertions", (row) => ({ ...row, ...incomplete, assertions: row.assertions })],
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
    ["a non-boolean assertion", (row) => ({ ...row, assertions: row.assertions.map((a) => ({ ...a, pass: "yes" })) })],
  ])("rejects %s", (_name, corrupt) => {
    const row = record();
    expect(parseRecord(corrupt(row), row.runId, assertionIds)).toBeUndefined();
  });

  test.each([[null], [[]], ["text"], [1]])("rejects %j", (value) => {
    expect(parseRecord(value, "20261109T000000Z-bug-fix-baseline-00000000", assertionIds)).toBeUndefined();
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

  test("charges failed and incomplete runs to the cost of a pass and still counts each outcome apart", () => {
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
      ms_per_pass: "49000",
      total_ms: "98000",
    });
  });

  describe("with an attempt its session record cannot attribute", () => {
    const cellsOf = (rows: RunRecord[]) => {
      const [header, ...lines] = renderSummary({ records: rows, malformed: 0, omitted: 0 }).split("\n");
      const names = header!.split("\t");
      return lines.map((line) => Object.fromEntries(line.split("\t").map((cell, index) => [names[index], cell])));
    };
    const UNKNOWN_TIMEOUT: Partial<RunRecord> = { ...incomplete, elapsedMs: 90000, identity: UNKNOWN_IDENTITY };

    test("a 90 s timeout leaves no comparable 1 s cost beside it, and stays visible on its own row", () => {
      const [known, unknown, paired] = cellsOf([
        record({ elapsedMs: 1000 }),
        record(UNKNOWN_TIMEOUT),
        light({ elapsedMs: 2000 }),
      ]);
      expect(known).toMatchObject({
        model: "gpt-test",
        runs: "1",
        pass: "1",
        ms_per_pass: "unavailable",
        total_ms: "1000",
        comparison: "incomparable:unattributed-attempts",
      });
      expect(unknown).toMatchObject({
        model: "unknown",
        runs: "1",
        pass: "0",
        incomplete: "1",
        ms_per_pass: "-",
        total_ms: "90000",
      });
      expect(unknown!.comparison).toContain("unattributed-attempts");
      expect(paired).toMatchObject({
        variant: "light",
        ms_per_pass: "2000",
        comparison: "incomparable:unattributed-attempts",
      });
    });

    test("a failed attempt without a session record is treated like a timeout", () => {
      const [known] = cellsOf([
        record({ elapsedMs: 1000 }),
        record({ ...failing, elapsedMs: 90000, identity: UNKNOWN_IDENTITY }),
        light(),
      ]);
      expect(known).toMatchObject({ ms_per_pass: "unavailable", comparison: "incomparable:unattributed-attempts" });
    });

    test("the cost is unavailable even with no other variant to compare with", () => {
      const [known] = cellsOf([record({ elapsedMs: 1000 }), record(UNKNOWN_TIMEOUT)]);
      expect(known).toMatchObject({ ms_per_pass: "unavailable", comparison: "no-counterpart" });
    });

    test.each<[string, Partial<RunRecord>]>([
      ["another revision", { ...UNKNOWN_TIMEOUT, caseRevision: "bbbbbbbbbbbb" }],
      ["another case", { ...UNKNOWN_TIMEOUT, caseId: "review" }],
      ["a pass, which leaves nothing to redo", { elapsedMs: 90000, identity: UNKNOWN_IDENTITY }],
    ])("the cost of a known run stays when the unknown attempt is in %s", (_name, overrides) => {
      const [known] = cellsOf([record({ elapsedMs: 1000 }), record(overrides), light()]);
      expect(known).toMatchObject({ model: "gpt-test", ms_per_pass: "1000", comparison: "comparable" });
    });
  });

  test("shows no time per pass for a group with no pass, but keeps what it spent", () => {
    const cells = renderSummary({ records: [record(incomplete)], malformed: 0, omitted: 0 })
      .split("\n")[1]!
      .split("\t");
    expect(cells.slice(11, 14)).toEqual(["-", "-", "1000"]);
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
  const session = FOUND_SESSION;
  const retry = FOUND_RETRY;
  const search = FOUND_SEARCH;
  const correctedTo = (sql: string) => ({
    ...search,
    counterexample: evidence("searchNotes", { term: TERM }, { sql, params: [TERM] }, SEARCH_BUILT),
  });

  test("a review with every seed and nothing else passes, however it is worded", () => {
    expect(failedOf(review(FOUND))).toEqual([]);
    expect(failedOf(review([{ ...session, summary: "any words at all" }, retry, search]))).toEqual([]);
    expect(failedOf(review([{ ...session, file: "./src/session.ts", line: 9 }, retry, search]))).toEqual([]);
  });

  test.each<[string, object]>([
    [
      "a time past the expiry",
      { ...session, counterexample: evidence("isExpired", { session: { expiresAtMs: 100 }, nowMs: 200 }, true, false) },
    ],
    [
      "a time before the expiry",
      { ...session, counterexample: evidence("isExpired", { session: { expiresAtMs: 100 }, nowMs: 50 }, false, true) },
    ],
    ["no attempts allowed", { ...retry, counterexample: evidence("withRetry", { maxAttempts: 0 }, 0, 1) }],
    ["a numbered placeholder in the correct query", correctedTo("SELECT id FROM notes WHERE title = $1")],
    ["a named placeholder in the correct query", correctedTo("SELECT id FROM notes WHERE title = :term")],
  ])("accepts a counterexample with %s", (_name, finding) => {
    const file = asRow(finding).file;
    expect(failedOf(review(FOUND.map((found) => (found.file === file ? finding : found))))).toEqual([]);
  });

  test.each<[string, typeof session, string]>([
    [
      "empty evidence",
      { ...session, counterexample: { function: "", input: "", expected: "", observed: "" } },
      "seed:inverted-expiry",
    ],
    [
      "text that is not JSON",
      {
        ...session,
        counterexample: { function: "isExpired", input: "an expired session", expected: "true", observed: "false" },
      },
      "seed:inverted-expiry",
    ],
    [
      "another function's name",
      { ...session, counterexample: evidence("remainingMs", SESSION_INPUT, true, false) },
      "seed:inverted-expiry",
    ],
    [
      "expected and observed swapped",
      { ...session, counterexample: evidence("isExpired", SESSION_INPUT, false, true) },
      "seed:inverted-expiry",
    ],
    [
      "no difference between expected and observed",
      { ...session, counterexample: evidence("isExpired", SESSION_INPUT, true, true) },
      "seed:inverted-expiry",
    ],
    [
      "an input without the session",
      { ...session, counterexample: evidence("isExpired", { nowMs: 100 }, true, false) },
      "seed:inverted-expiry",
    ],
    [
      "a time given as text",
      {
        ...session,
        counterexample: evidence("isExpired", { session: { expiresAtMs: 100 }, nowMs: "100" }, true, false),
      },
      "seed:inverted-expiry",
    ],
    [
      "the same count on both sides",
      { ...retry, counterexample: evidence("withRetry", { maxAttempts: 3 }, 3, 3) },
      "seed:extra-retry",
    ],
    [
      "a count the code does not produce",
      { ...retry, counterexample: evidence("withRetry", { maxAttempts: 3 }, 3, 5) },
      "seed:extra-retry",
    ],
    [
      "a fractional limit",
      { ...retry, counterexample: evidence("withRetry", { maxAttempts: 1.5 }, 1.5, 2.5) },
      "seed:extra-retry",
    ],
    [
      "a negative limit",
      { ...retry, counterexample: evidence("withRetry", { maxAttempts: -1 }, -1, 0) },
      "seed:extra-retry",
    ],
    [
      "a term that cannot leave the quoted text",
      {
        ...search,
        counterexample: evidence(
          "searchNotes",
          { term: "tea" },
          { sql: "SELECT id FROM notes WHERE title = ?", params: ["tea"] },
          { sql: "SELECT id FROM notes WHERE title = 'tea'", params: [] },
        ),
      },
      "seed:sql-from-input",
    ],
    [
      "a query the code does not build",
      {
        ...search,
        counterexample: evidence("searchNotes", { term: TERM }, SEARCH_BOUND, { sql: "SELECT 1", params: [] }),
      },
      "seed:sql-from-input",
    ],
    [
      "a correct query that still holds the term",
      { ...search, counterexample: evidence("searchNotes", { term: TERM }, SEARCH_BUILT, SEARCH_BUILT) },
      "seed:sql-from-input",
    ],
    [
      "a correct query that does not pass the term",
      {
        ...search,
        counterexample: evidence(
          "searchNotes",
          { term: TERM },
          { sql: "SELECT id FROM notes WHERE title = ?", params: [] },
          SEARCH_BUILT,
        ),
      },
      "seed:sql-from-input",
    ],
    ["an empty correct query", correctedTo(""), "seed:sql-from-input"],
    ["an unrelated correct query", correctedTo("SELECT 1"), "seed:sql-from-input"],
    ["a correct query on another column", correctedTo("SELECT id FROM notes WHERE body = ?"), "seed:sql-from-input"],
    ["a correct query on another table", correctedTo("SELECT id FROM users WHERE title = ?"), "seed:sql-from-input"],
    ["a correct query selecting more", correctedTo("SELECT * FROM notes WHERE title = ?"), "seed:sql-from-input"],
    [
      "a correct query with a condition added",
      correctedTo("SELECT id FROM notes WHERE title = ? OR 1 = 1"),
      "seed:sql-from-input",
    ],
  ])("a finding on the right line with %s does not establish the defect", (_name, finding, seedId) => {
    const assertions = review(FOUND.map((found) => (found.file === finding.file ? finding : found)));
    expect(failedOf(assertions)).toEqual([seedId, "false-positives"]);
    expect(countOf(assertions)).toBe(1);
  });

  test("the evidence the grader accepts is what the fixture really does", async () => {
    const load = async (files: Readonly<Record<string, string>>) => {
      const dir = join(base, `fixture${harnessCount++}`);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      return {
        session: await import(join(dir, "src/session.ts")),
        retry: await import(join(dir, "src/retry.ts")),
        search: await import(join(dir, "src/search.ts")),
      };
    };
    const callsOfFailingTask = async (retryModule: { withRetry: Function }) => {
      let calls = 0;
      const task = async () => {
        calls += 1;
        throw new Error("always fails");
      };
      await retryModule.withRetry(task, 3).catch(() => undefined);
      return calls;
    };
    const committed = await load(CASES.review.change);
    const correct = await load(CASES.review.files);

    expect(committed.session.isExpired(SESSION_INPUT.session, SESSION_INPUT.nowMs)).toBe(false);
    expect(correct.session.isExpired(SESSION_INPUT.session, SESSION_INPUT.nowMs)).toBe(true);
    expect(await callsOfFailingTask(committed.retry)).toBe(4);
    expect(await callsOfFailingTask(correct.retry)).toBe(3);
    expect(committed.search.searchNotes(TERM)).toEqual(SEARCH_BUILT);
    expect(correct.search.searchNotes(TERM)).toEqual(SEARCH_BOUND);
  });

  test("a missed seed fails that seed", () => {
    expect(failedOf(review([session, retry]))).toEqual(["seed:sql-from-input"]);
  });

  test("an empty review misses every seed", () => {
    expect(failedOf(review([]))).toEqual(["seed:inverted-expiry", "seed:extra-retry", "seed:sql-from-input"]);
  });

  test("flagging the correct decoy rewrite is a false positive, whatever evidence comes with it", () => {
    const decoy = {
      file: "src/total.ts",
      line: 2,
      summary: "",
      counterexample: evidence("sum", { values: [1] }, 1, 2),
    };
    const assertions = review([session, retry, search, decoy]);
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

describe("the shape of a final answer", () => {
  const SUMMARY_CASES = ["bug-fix", "cross-file", "continuation"] as const;
  const accepts = (caseId: keyof typeof CASES, value: unknown) => CASES[caseId].output.accepts(value);
  const EVIDENCE = { function: "f", input: "{}", expected: "1", observed: "2" };
  const FINDING = { file: "src/a.ts", line: 1, summary: "s", counterexample: EVIDENCE };

  test.each(SUMMARY_CASES)("%s accepts a summary, in any words", (caseId) => {
    expect(accepts(caseId, { summary: "" })).toBe(true);
  });

  test.each([[null], [[]], ["text"], [1], [{}], [{ summary: 1 }], [{ summary: null }], [{ summary: "s", extra: 1 }]])(
    "the summary cases refuse %j",
    (value) => {
      for (const caseId of SUMMARY_CASES) expect(accepts(caseId, value)).toBe(false);
    },
  );

  test("an investigation accepts a path and a whole number", () => {
    expect(accepts("investigation", { definingFile: "a", limitBytes: 1 })).toBe(true);
  });

  test.each([
    [null],
    [{ definingFile: "a" }],
    [{ limitBytes: 1 }],
    [{ definingFile: 1, limitBytes: 1 }],
    [{ definingFile: "a", limitBytes: "1" }],
    [{ definingFile: "a", limitBytes: 1.5 }],
  ])("an investigation refuses %j", (value) => {
    expect(accepts("investigation", value)).toBe(false);
  });

  test.each([[{ findings: [] }], [{ findings: [FINDING] }]])("a review accepts %j", (value) => {
    expect(accepts("review", value)).toBe(true);
  });

  test.each([
    [null],
    [{ summary: "all good" }],
    [{ findings: null }],
    [{ findings: {} }],
    [{ findings: [null] }],
    [{ findings: ["looks bad"] }],
    [{ findings: [{ ...FINDING, line: "1" }] }],
    [{ findings: [{ ...FINDING, line: 1.5 }] }],
    [{ findings: [{ file: "src/a.ts", line: 1, counterexample: EVIDENCE }] }],
    [{ findings: [{ file: "src/a.ts", line: 1, summary: "s" }] }],
    [{ findings: [{ ...FINDING, counterexample: null }] }],
    [{ findings: [{ ...FINDING, counterexample: { ...EVIDENCE, input: {} } }] }],
    [{ findings: [{ ...FINDING, counterexample: { function: "f" } }] }],
    [{ findings: [{ ...FINDING, extra: 1 }] }],
  ])("a review refuses %j", (value) => {
    expect(accepts("review", value)).toBe(false);
  });

  test("the schema given to the CLI requires the same fields the answer is checked for", () => {
    expect(CASES["bug-fix"].output.schema).toEqual({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    });
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
    [
      "several changes in one order, whatever order the walk found them in",
      [
        ["c", "3"],
        ["a", "x"],
        ["Z", "9"],
        ["b", "2"],
      ],
      ["Z", "a", "c"],
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

describe("judging one answer from the public CLI", () => {
  test.each<[string, string, Partial<ChildResult>, boolean]>([
    ["the expected value", "2\n", {}, true],
    ["another value", "3\n", {}, false],
    ["the value as text", '"2"\n', {}, false],
    ["no output", "", {}, false],
    ["output that is not JSON", "two\n", {}, false],
    ["the value twice", "2\n2\n", {}, false],
    ["the value beside other output", "debug\n2\n", {}, false],
    ["a verdict instead of the value", '{"id":"c","pass":true}\n', {}, false],
    ["the value with a nonzero exit", "2\n", { exitCode: 7 }, false],
    ["the value before death by signal", "2\n", { exitCode: null, signal: "SIGKILL" }, false],
    ["the value before a timeout", "2\n", { timedOut: true }, false],
    ["the value with too much output", "2\n", { overLimit: true }, false],
    ["the value before an interruption", "2\n", { interrupted: true }, false],
  ])("judges %s", (_name, stdout, child, pass) => {
    expect(checkPasses(2, stdout, { ...clean, ...child })).toBe(pass);
  });
});

describe("the usage snapshot", () => {
  const SNAPSHOT = join(import.meta.dir, "../agents/skills/agent-usage-review/scripts/snapshot.sh");
  const SNAPSHOT_TIMEOUT = 60_000;
  const now = () => new Date().toISOString();

  // Only the named tools and the base system: ccusage, omp, and jbcontext stay out of the run, so
  // their sections come out empty instead of reaching the network.
  function snapshotHome(tools: Record<string, string>): { home: string; bin: string } {
    const home = join(base, `snapshot${harnessCount++}`);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const [name, target] of Object.entries(tools)) symlinkSync(target, join(bin, name));
    return { home, bin };
  }

  function runSnapshot(paths: { home: string; bin: string }, env: Record<string, string> = {}, cwd?: string) {
    return spawnSync(Bun.which("bash")!, [SNAPSHOT, "--days", "7"], {
      cwd,
      env: { HOME: paths.home, PATH: `${paths.bin}:/usr/bin:/bin`, LC_ALL: "C", ...env },
      encoding: "utf8",
    });
  }

  function writeRecords(dir: string, rows: RunRecord[]): void {
    mkdirSync(dir, { recursive: true });
    for (const row of rows) writeFileSync(join(dir, `${row.runId}.json`), JSON.stringify(row));
  }

  const sectionBody = (stdout: string) =>
    (stdout.split("### 固定タスク評価")[1] ?? "")
      .split("\n### ")[0]!
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith(">"));

  const JQ_AND_BUN = () => ({ jq: Bun.which("jq")!, bun: process.execPath });
  const defaultRuns = (home: string) => join(home, ".local/state/agent-eval/runs");

  test(
    "lists runs per comparable group within the period, counts a malformed file apart, and keeps the other sections",
    () => {
      const paths = snapshotHome(JQ_AND_BUN());
      const dir = defaultRuns(paths.home);
      const lightIdentity = { ...IDENTITY, effort: "medium" };
      writeRecords(dir, [
        record({ startedAt: now(), elapsedMs: 2000 }),
        record({ ...failing, startedAt: now(), elapsedMs: 1000 }),
        record({ variant: "light", identity: lightIdentity, startedAt: now(), elapsedMs: 500 }),
        record({ caseId: "review", startedAt: "2020-01-01T00:00:00.000Z" }),
      ]);
      writeFileSync(join(dir, "broken.json"), '{"outcome":"pass"');

      const run = runSnapshot(paths);

      expect(run.status).toBe(0);
      const [header, ...rest] = sectionBody(run.stdout);
      const names = header!.split("\t");
      const rows = rest
        .filter((line) => !line.startsWith("malformed_records"))
        .map((line) => Object.fromEntries(line.split("\t").map((cell, index) => [names[index], cell])));
      expect(rows.map((row) => [row.case, row.variant, row.runs, row.pass, row.fail, row.comparison])).toEqual([
        ["bug-fix", "baseline", "2", "1", "1", "comparable"],
        ["bug-fix", "light", "1", "1", "0", "comparable"],
      ]);
      expect(rest.at(-1)).toBe("malformed_records: 1 (pass に数えない)");
      for (const section of ["## 日次合計", "### 繰り返し失敗", "### Plugin / config drift", "### 制約"]) {
        expect(run.stdout).toContain(section);
      }
    },
    SNAPSHOT_TIMEOUT,
  );

  test(
    "says there is no evaluation when there are no records, even without bun",
    () => {
      const paths = snapshotHome({ jq: Bun.which("jq")! });
      const run = runSnapshot(paths);
      expect(run.status).toBe(0);
      expect(sectionBody(run.stdout)).toEqual([NO_RECORDS]);
    },
    SNAPSHOT_TIMEOUT,
  );

  test(
    "says the records could not be read when bun is missing, rather than reporting no failures",
    () => {
      const paths = snapshotHome({ jq: Bun.which("jq")! });
      writeRecords(defaultRuns(paths.home), [record({ startedAt: now() })]);
      const run = runSnapshot(paths);
      expect(run.status).toBe(0);
      expect(sectionBody(run.stdout)).toEqual(["- 取得不能（bun がない）"]);
    },
    SNAPSHOT_TIMEOUT,
  );

  test(
    "follows an absolute XDG_STATE_HOME to the records",
    () => {
      const paths = snapshotHome(JQ_AND_BUN());
      const state = join(paths.home, "custom-state");
      writeRecords(join(state, "agent-eval/runs"), [record({ startedAt: now() })]);
      const run = runSnapshot(paths, { XDG_STATE_HOME: state });
      expect(sectionBody(run.stdout)[1]).toStartWith("bug-fix\tbaseline");
    },
    SNAPSHOT_TIMEOUT,
  );

  test(
    "still lists the records but runs no preload when started from a directory holding a bunfig.toml",
    () => {
      const paths = snapshotHome(JQ_AND_BUN());
      writeRecords(defaultRuns(paths.home), [record({ startedAt: now() })]);
      const marker = plantPreload(paths.home);
      const run = runSnapshot(paths, {}, paths.home);
      expect(run.status).toBe(0);
      expect(sectionBody(run.stdout)[1]).toStartWith("bug-fix\tbaseline");
      expect(existsSync(marker)).toBe(false);
    },
    SNAPSHOT_TIMEOUT,
  );

  test(
    "treats a record holding a command as data and runs nothing from it",
    () => {
      const paths = snapshotHome(JQ_AND_BUN());
      const marker = join(paths.home, "executed");
      const hostile = record({ startedAt: now(), identity: { ...IDENTITY, model: `$(touch ${marker})` } });
      writeRecords(defaultRuns(paths.home), [hostile]);
      const run = runSnapshot(paths);
      expect(run.status).toBe(0);
      expect(sectionBody(run.stdout)).toEqual([NO_RECORDS, "malformed_records: 1 (pass に数えない)"]);
      expect(existsSync(marker)).toBe(false);
    },
    SNAPSHOT_TIMEOUT,
  );
});
