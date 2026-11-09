// Runs one fixed Codex case against a workspace this tool owns, records what independent checks saw,
// and summarises those records. See docs/agent-eval.md. Decisions live in agent-eval-core.ts and
// pass criteria in agent-eval-cases.ts; this file reads, writes, and starts processes.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertionIds, CASES, type EvalCase, expectedTree, grade, type Shape } from "./agent-eval-cases.ts";
import {
  type Assertion,
  type CaseId,
  type ChildResult,
  changedPaths,
  type FinalOutput,
  type Identity,
  type IncompleteReason,
  judgeChecks,
  LIGHT_PROFILE,
  lightProfileProblem,
  type Outcome,
  outcomeOf,
  parseArgs,
  parseCheckOutput,
  parseEvents,
  parseJson,
  parseRecord,
  parseRollout,
  type RunCommand,
  type RunRecord,
  renderSummary,
  runIdFor,
  SCHEMA_VERSION,
  turnArgv,
  turnProblem,
  UNKNOWN_IDENTITY,
  USAGE,
} from "./agent-eval-core.ts";

export type Ctx = {
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  out(text: string): void;
  err(text: string): void;
};

const EXIT = { pass: 0, failed: 1, usage: 2, incomplete: 3 } as const;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 5000;
const MAX_TREE_ENTRIES = 5000;
const MAX_TREE_FILE_BYTES = 1024 * 1024;
const CHECK_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;
const TREE_OVERFLOW = "<too-many-files>";
const CHECK_SCRIPT = join(import.meta.dir, "agent-eval-check.ts");
// Everything that can change a verdict or a time. Two runs compare only when all of it matches.
const EVALUATOR_SOURCES = [
  "agent-eval",
  "agent-eval.ts",
  "agent-eval-core.ts",
  "agent-eval-cases.ts",
  "agent-eval-check.ts",
];
const SYSTEM_PATH = "/usr/bin:/bin";
// The check runs with the agent's workspace as its working directory, where a bunfig.toml could
// preload code ahead of the harness. An explicit empty config replaces it (measured on Bun 1.4.4).
const BUN_RUN = ["run", "--config=/dev/null", "--no-install", "--no-env-file"];
// By-products the agent's own instructions send to .agent-msgs/ are not changes to the fixture.
const NOT_FIXTURE = new Set([".git", ".agent-msgs"]);

function homeOf(ctx: Ctx): string {
  const home = ctx.env.HOME;
  if (!home) throw new Error("HOME が設定されていない");
  return home;
}

// The XDG specification says a relative value must be ignored.
function stateRoot(ctx: Ctx): string {
  const xdg = ctx.env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homeOf(ctx), ".local/state");
  return join(base, "agent-eval");
}

function codexHome(ctx: Ctx): string {
  return ctx.env.CODEX_HOME || join(homeOf(ctx), ".codex");
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`${path} が自分のディレクトリではない`);
  }
  chmodSync(path, 0o700);
}

// Refuses symlinks, other users' files, and anything oversized: every caller reads a path whose
// content this process did not write.
function readBounded(path: string, limit: number): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit || stat.uid !== process.getuid?.()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- Child processes.

type StopFlag = "timedOut" | "interrupted" | "overLimit";
type ChildSpec = {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
  signal: AbortSignal;
};

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The whole group has already exited.
  }
}

function cappedSink(path: string, limit: number, onOverflow: () => void) {
  const fd = openSync(path, "wx", 0o600);
  let written = 0;
  let open = true;
  let full = false;
  return {
    write(chunk: Buffer): void {
      if (!open || full) return;
      if (written + chunk.length > limit) {
        full = true;
        onOverflow();
        return;
      }
      writeSync(fd, chunk);
      written += chunk.length;
    },
    close(): void {
      if (open) closeSync(fd);
      open = false;
    },
  };
}

const notStarted = (): ChildResult => ({
  exitCode: null,
  signal: null,
  timedOut: false,
  interrupted: false,
  overLimit: false,
  launchError: false,
});

// The child leads its own process group so that everything it started can be stopped with it. A
// process that left the group and kept a pipe open cannot hold the run: the timers below end the
// wait regardless.
function runChild(spec: ChildSpec): Promise<ChildResult> {
  const [command = "", ...args] = spec.argv;
  const child = spawn(command, args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = notStarted();
  return new Promise((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let stopping = false;
    let finished = false;
    const stop = (flag: StopFlag) => {
      if (stopping) return;
      stopping = true;
      result[flag] = true;
      killGroup(child.pid, "SIGTERM");
      timers.push(setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS));
      timers.push(setTimeout(finish, KILL_GRACE_MS + CLOSE_GRACE_MS));
    };
    const interrupt = () => stop("interrupted");
    const stdout = cappedSink(spec.stdoutPath, MAX_STDOUT_BYTES, () => stop("overLimit"));
    const stderr = cappedSink(spec.stderrPath, MAX_STDERR_BYTES, () => {
      // Diagnostics past the cap are dropped; they are no reason to stop the agent.
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      spec.signal.removeEventListener("abort", interrupt);
      killGroup(child.pid, "SIGKILL");
      stdout.close();
      stderr.close();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    child.stdout.on("data", stdout.write);
    child.stderr.on("data", stderr.write);
    child.on("error", () => {
      result.launchError = true;
      finish();
    });
    child.on("exit", (code, signal) => {
      result.exitCode = code;
      result.signal = signal;
      killGroup(child.pid, "SIGKILL");
      timers.push(setTimeout(finish, CLOSE_GRACE_MS));
    });
    child.on("close", finish);
    timers.push(setTimeout(() => stop("timedOut"), spec.timeoutMs));
    if (spec.signal.aborted) interrupt();
    else spec.signal.addEventListener("abort", interrupt);
  });
}

// ---- One run.

type Tools = { codex: string; git: string };
type Plan = {
  command: RunCommand;
  evalCase: EvalCase;
  revision: string;
  tools: Tools;
  root: string;
  runId: string;
  startedAt: Date;
  startedMs: number;
  evidence: string;
  workspace: string;
  scratchHome: string;
  schemaPath: string;
  deadline: number;
};

function lightProfileError(ctx: Ctx): string | undefined {
  const path = join(codexHome(ctx), `${LIGHT_PROFILE}.config.toml`);
  try {
    const problem = lightProfileProblem(Bun.TOML.parse(readFileSync(path, "utf8")));
    return problem && `${path}: ${problem}`;
  } catch {
    return `${path} を読めない。scripts/link で配置する`;
  }
}

function preflight(ctx: Ctx, command: RunCommand): Tools | string {
  const path = { PATH: ctx.env.PATH ?? "" };
  const codex = Bun.which("codex", path);
  if (!codex) return "codex が見つからない";
  const git = Bun.which("git", path);
  if (!git) return "git が見つからない";
  const problem = command.variant === "light" ? lightProfileError(ctx) : undefined;
  return problem ?? { codex, git };
}

// Read before anything runs, so that it describes the code doing this run.
function evaluationRevision(caseId: CaseId): string {
  const hash = createHash("sha256").update(caseId);
  for (const name of EVALUATOR_SOURCES) {
    hash
      .update("\0")
      .update(name)
      .update("\0")
      .update(readFileSync(join(import.meta.dir, name)));
  }
  return hash.digest("hex").slice(0, 12);
}

function createPlan(ctx: Ctx, command: RunCommand, tools: Tools): Plan {
  const startedMs = performance.now();
  const startedAt = new Date();
  const root = stateRoot(ctx);
  for (const dir of [root, join(root, "runs"), join(root, "evidence")]) ensurePrivateDir(dir);
  const runId = runIdFor(startedAt, command.caseId, command.variant, randomBytes(4).toString("hex"));
  const evidence = join(root, "evidence", runId);
  // Not recursive: a collision fails here rather than mixing two runs.
  mkdirSync(evidence, { mode: 0o700 });
  const evalCase = CASES[command.caseId];
  const schemaPath = join(evidence, "output-schema.json");
  writeFileSync(schemaPath, JSON.stringify(evalCase.output.schema), { mode: 0o600 });
  const scratchHome = join(evidence, "scratch-home");
  mkdirSync(scratchHome, { mode: 0o700 });
  return {
    command,
    evalCase,
    revision: evaluationRevision(command.caseId),
    tools,
    root,
    runId,
    startedAt,
    startedMs,
    evidence,
    schemaPath,
    scratchHome,
    workspace: join(evidence, "workspace"),
    deadline: performance.now() + command.timeoutMs,
  };
}

// The fixture is committed before the agent exists, with no user or system Git configuration: a
// global hook has no business inspecting it. Git is not run again afterwards, because the agent can
// reach this repository's configuration and that could name commands to execute.
function git(plan: Plan, args: readonly string[]): void {
  const run = spawnSync(plan.tools.git, args, {
    cwd: plan.workspace,
    env: {
      PATH: SYSTEM_PATH,
      HOME: plan.scratchHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
  if (run.status !== 0) throw new Error(`git ${args[0]} に失敗した: ${String(run.stderr).slice(0, 500)}`);
}

function commitFiles(plan: Plan, files: Readonly<Record<string, string>>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(plan.workspace, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  git(plan, ["add", "--", ...Object.keys(files)]);
  git(plan, [
    "-c",
    "user.name=agent-eval",
    "-c",
    "user.email=agent-eval@example.invalid",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

function prepareWorkspace(plan: Plan): void {
  mkdirSync(plan.workspace, { mode: 0o700 });
  git(plan, ["init", "-q"]);
  mkdirSync(join(plan.workspace, ".git/info"), { recursive: true });
  appendFileSync(join(plan.workspace, ".git/info/exclude"), ".agent-msgs/\n");
  commitFiles(plan, plan.evalCase.files, "Initial version");
  if (Object.keys(plan.evalCase.change).length > 0) commitFiles(plan, plan.evalCase.change, "Update helpers");
}

// HERDR_* would report this run as the state of whichever pane started it, and GIT_* would point the
// agent's Git at another repository.
function agentEnv(ctx: Ctx): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.env)) {
    if (value !== undefined && !key.startsWith("HERDR_") && !key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function readFinalOutput(path: string, shape: Shape): FinalOutput {
  const text = readBounded(path, MAX_OUTPUT_BYTES);
  if (text === undefined) return { state: "missing" };
  const value = parseJson(text);
  return shape.accepts(value) ? { state: "ok", value } : { state: "malformed" };
}

type TurnInput = { index: number; prompt: string; threadId?: string };

async function runTurn(ctx: Ctx, plan: Plan, turn: TurnInput) {
  const base = join(plan.evidence, `turn-${turn.index + 1}`);
  const outputPath = `${base}.final.json`;
  const stdoutPath = `${base}.events.jsonl`;
  const child = await runChild({
    argv: turnArgv(plan.tools.codex, {
      variant: plan.command.variant,
      schemaPath: plan.schemaPath,
      outputPath,
      prompt: turn.prompt,
      threadId: turn.threadId,
    }),
    cwd: plan.workspace,
    env: agentEnv(ctx),
    stdoutPath,
    stderrPath: `${base}.stderr.log`,
    timeoutMs: Math.max(0, plan.deadline - performance.now()),
    signal: ctx.signal,
  });
  const facts = parseEvents(readBounded(stdoutPath, MAX_STDOUT_BYTES) ?? "");
  const output = readFinalOutput(outputPath, plan.evalCase.output);
  return { child, output, threadId: facts.threadId, problem: turnProblem(child, facts, output, turn.threadId) };
}

type TurnsResult = {
  problem?: IncompleteReason;
  threadId?: string;
  exitCode: number | null;
  signal: string | null;
  output: unknown;
};

async function runTurns(ctx: Ctx, plan: Plan): Promise<TurnsResult> {
  const result: TurnsResult = { exitCode: null, signal: null, output: undefined };
  for (const [index, prompt] of plan.evalCase.prompts.entries()) {
    const turn = await runTurn(ctx, plan, { index, prompt, threadId: result.threadId });
    result.threadId ??= turn.threadId;
    result.exitCode = turn.child.exitCode;
    result.signal = turn.child.signal;
    result.problem = turn.problem;
    result.output = turn.output.state === "ok" ? turn.output.value : undefined;
    if (turn.problem) break;
  }
  return result;
}

function listFixtureEntries(root: string, dir: string) {
  return readdirSync(join(root, dir), { withFileTypes: true }).filter(
    (entry) => dir !== "" || !entry.isDirectory() || !NOT_FIXTURE.has(entry.name),
  );
}

// A Map because file names are the agent's choice: a file called __proto__ on a plain object would
// vanish from the comparison.
function readTree(root: string): Map<string, string | null> {
  const tree = new Map<string, string | null>();
  const pending = [""];
  while (pending.length > 0 && tree.size < MAX_TREE_ENTRIES) {
    const dir = pending.pop() ?? "";
    for (const entry of listFixtureEntries(root, dir)) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else tree.set(path, entry.isFile() ? (readBounded(join(root, path), MAX_TREE_FILE_BYTES) ?? null) : null);
    }
  }
  if (pending.length > 0) tree.set(TREE_OVERFLOW, null);
  return tree;
}

type ChecksResult = { problem?: IncompleteReason; results: ReadonlyMap<string, boolean> };

// Only the workspace's code runs here, and it can read what the agent could already read but neither
// write nor reach the network. It gets no environment beyond these few variables and none of the
// expected values. What it prints may hold anything it read, so only the comparison and a status file
// of fixed fields survive this function. That goes for stderr without a start marker too: a missing
// marker does not prove that no workspace code ran, so a sandbox failure is reproduced by hand instead.
async function runBehaviourChecks(ctx: Ctx, plan: Plan): Promise<ChecksResult> {
  const { checks } = plan.evalCase;
  if (checks.length === 0) return { results: new Map() };
  const stdoutPath = join(plan.evidence, "check.stdout");
  const stderrPath = join(plan.evidence, "check.stderr.log");
  const calls = checks.map(({ id, module, fn, args }) => ({ id, module, fn, args }));
  const child = await runChild({
    argv: [
      plan.tools.codex,
      "sandbox",
      "-P",
      ":read-only",
      "-C",
      plan.workspace,
      "--",
      process.execPath,
      ...BUN_RUN,
      CHECK_SCRIPT,
      plan.workspace,
      JSON.stringify(calls),
    ],
    cwd: plan.workspace,
    env: { PATH: SYSTEM_PATH, HOME: plan.scratchHome, LC_ALL: "C", TZ: "UTC" },
    stdoutPath,
    stderrPath,
    timeoutMs: CHECK_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const output = parseCheckOutput(
    readBounded(stdoutPath, MAX_STDOUT_BYTES) ?? "",
    checks.map((check) => check.id),
  );
  rmSync(stdoutPath, { force: true });
  rmSync(stderrPath, { force: true });
  const { started } = output;
  const { exitCode, signal, timedOut, overLimit } = child;
  writeFileSync(
    join(plan.evidence, "check.status.json"),
    `${JSON.stringify({ started, exitCode, signal, timedOut, overLimit, reported: [...output.values.keys()] })}\n`,
    { mode: 0o600 },
  );
  if (child.interrupted) return { problem: "interrupted", results: new Map() };
  if (!output.started) return { problem: "harness-error", results: new Map() };
  return { results: judgeChecks(checks, output, child) };
}

function observeIdentity(ctx: Ctx, threadId: string | undefined): Identity {
  if (threadId === undefined) return UNKNOWN_IDENTITY;
  const sessions = join(codexHome(ctx), "sessions");
  try {
    const matches = [...new Bun.Glob(`*/*/*/rollout-*-${threadId}.jsonl`).scanSync({ cwd: sessions })];
    const [match] = matches;
    const text = matches.length === 1 && match ? readBounded(join(sessions, match), MAX_ROLLOUT_BYTES) : undefined;
    return text === undefined ? UNKNOWN_IDENTITY : parseRollout(text);
  } catch {
    return UNKNOWN_IDENTITY;
  }
}

type Attempt = {
  outcome: Outcome;
  incompleteReason: IncompleteReason | null;
  assertions: Assertion[];
  turns?: TurnsResult;
};

async function attempt(ctx: Ctx, plan: Plan, progress: { turns?: TurnsResult }): Promise<Attempt> {
  prepareWorkspace(plan);
  const turns = await runTurns(ctx, plan);
  progress.turns = turns;
  if (turns.problem) return { outcome: "incomplete", incompleteReason: turns.problem, assertions: [], turns };
  // Read before the checks run: this is the state the agent left.
  const changed = changedPaths(expectedTree(plan.evalCase), readTree(plan.workspace));
  const checks = await runBehaviourChecks(ctx, plan);
  if (checks.problem) return { outcome: "incomplete", incompleteReason: checks.problem, assertions: [], turns };
  const assertions = grade(plan.evalCase, { output: turns.output, changed, checks: checks.results });
  return { outcome: outcomeOf(assertions), incompleteReason: null, assertions, turns };
}

function buildRecord(ctx: Ctx, plan: Plan, result: Attempt, elapsedMs: number): RunRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    caseId: plan.command.caseId,
    caseRevision: plan.revision,
    variant: plan.command.variant,
    startedAt: plan.startedAt.toISOString(),
    elapsedMs,
    outcome: result.outcome,
    incompleteReason: result.incompleteReason,
    exitCode: result.turns?.exitCode ?? null,
    signal: result.turns?.signal ?? null,
    identity: observeIdentity(ctx, result.turns?.threadId),
    assertions: result.assertions,
    evidence: `evidence/${plan.runId}`,
  };
}

// A reader sees either the whole record or none: the rename is the publication.
function publishRecord(plan: Plan, record: RunRecord): string {
  const path = join(plan.root, "runs", `${plan.runId}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return path;
}

// A failure after the turns keeps what they showed, so the run stays in its model's and effort's group.
async function attemptRecordingFailure(ctx: Ctx, plan: Plan): Promise<Attempt> {
  const progress: { turns?: TurnsResult } = {};
  try {
    return await attempt(ctx, plan, progress);
  } catch (error) {
    writeFileSync(join(plan.evidence, "harness-error.log"), `${errorText(error)}\n`, { mode: 0o600 });
    return { outcome: "incomplete", incompleteReason: "harness-error", assertions: [], ...progress };
  }
}

const EXIT_FOR_OUTCOME: Record<Outcome, number> = { pass: EXIT.pass, fail: EXIT.failed, incomplete: EXIT.incomplete };

async function runCase(ctx: Ctx, command: RunCommand): Promise<number> {
  const tools = preflight(ctx, command);
  if (typeof tools === "string") {
    ctx.err(`agent-eval: ${tools}。評価は実行していない`);
    return EXIT.failed;
  }
  const plan = createPlan(ctx, command, tools);
  const result = await attemptRecordingFailure(ctx, plan);
  // Taken here so that a run that threw keeps the time it spent. The clock stopped at final grading:
  // reading the session record and publishing are this tool's bookkeeping.
  const elapsedMs = Math.round(performance.now() - plan.startedMs);
  const record = buildRecord(ctx, plan, result, elapsedMs);
  const path = publishRecord(plan, record);
  ctx.out(
    JSON.stringify({
      runId: record.runId,
      outcome: record.outcome,
      incompleteReason: record.incompleteReason,
      elapsedMs: record.elapsedMs,
      failed: record.assertions.filter((assertion) => !assertion.pass).map((assertion) => assertion.id),
      record: path,
    }),
  );
  return EXIT_FOR_OUTCOME[record.outcome];
}

// ---- Summary. Records only ever feed these counts: nothing in one is executed or followed.

function readRecordFile(dir: string, name: string): RunRecord | undefined {
  const text = readBounded(join(dir, name), MAX_RECORD_BYTES);
  return text === undefined ? undefined : parseRecord(parseJson(text), name.slice(0, -".json".length), assertionIds);
}

function listRecordNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function runSummary(ctx: Ctx, sinceMs: number): number {
  const dir = join(stateRoot(ctx), "runs");
  const names = listRecordNames(dir);
  const kept = names.slice(-MAX_RECORDS);
  const parsed = kept.map((name) => readRecordFile(dir, name));
  const valid = parsed.filter((record) => record !== undefined);
  ctx.out(
    renderSummary({
      records: valid.filter((record) => Date.parse(record.startedAt) >= sinceMs),
      malformed: parsed.length - valid.length,
      omitted: names.length - kept.length,
    }),
  );
  return EXIT.pass;
}

export async function main(argv: readonly string[], ctx: Ctx): Promise<number> {
  const command = parseArgs(argv);
  if (!command) {
    ctx.err(USAGE);
    return EXIT.usage;
  }
  try {
    return command.kind === "run" ? await runCase(ctx, command) : runSummary(ctx, command.sinceMs);
  } catch (error) {
    ctx.err(`agent-eval: ${errorText(error)}`);
    return EXIT.failed;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, () => controller.abort());
  const code = await main(process.argv.slice(2), {
    env: process.env,
    signal: controller.signal,
    out: console.log,
    err: console.error,
  });
  process.exit(code);
}
