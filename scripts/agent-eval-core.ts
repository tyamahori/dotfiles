// Decisions for scripts/agent-eval (docs/agent-eval.md): pure functions over parsed data, so each
// verdict can be shown with literals. Processes and files stay in agent-eval.ts; what makes a case
// pass stays in agent-eval-cases.ts.
import { isDeepStrictEqual } from "node:util";

export const CASE_IDS = ["investigation", "bug-fix", "cross-file", "review", "continuation"] as const;
export type CaseId = (typeof CASE_IDS)[number];
export const VARIANTS = ["baseline", "light"] as const;
export type Variant = (typeof VARIANTS)[number];

export const SCHEMA_VERSION = 1;
export const LIGHT_PROFILE = "light";
export const UNKNOWN = "unknown";
export const MIXED = "mixed";
export const NO_RECORDS = "(評価記録なし)";
export const CHECK_MARKER = "agentEvalCheck";
export const CHECK_STARTED = "started";
export const USAGE =
  "usage: agent-eval run <investigation|bug-fix|cross-file|review|continuation> --variant <baseline|light> [--timeout-seconds N]\n" +
  "       agent-eval summary [--since-ms N]";

const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_TIMEOUT_SECONDS = 7200;
const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;
const MAX_ASSERTIONS = 64;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[a-z-]{1,32}-[a-z]{1,16}-[0-9a-f]{8}$/;
const REVISION = /^[0-9a-f]{12}$/;
const ASSERTION_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

type Row = Record<string, unknown>;

export function asRow(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

// ---- Command line: the one place a case or variant name is accepted.

export type RunCommand = { kind: "run"; caseId: CaseId; variant: Variant; timeoutMs: number };
export type Command = RunCommand | { kind: "summary"; sinceMs: number };

function integerIn(text: string | undefined, min: number, max: number): number | undefined {
  if (text === undefined || !/^[0-9]{1,16}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

function parseFlags(args: readonly string[], allowed: readonly string[]): Map<string, string> | undefined {
  if (args.length % 2 !== 0) return undefined;
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? "";
    if (!allowed.includes(name) || flags.has(name)) return undefined;
    flags.set(name, args[index + 1] ?? "");
  }
  return flags;
}

function parseRun(args: readonly string[]): Command | undefined {
  const [caseId, ...rest] = args;
  const flags = parseFlags(rest, ["--variant", "--timeout-seconds"]);
  const variant = flags?.get("--variant");
  if (!flags || !isMember(CASE_IDS, caseId) || !isMember(VARIANTS, variant)) return undefined;
  const seconds = flags.has("--timeout-seconds")
    ? integerIn(flags.get("--timeout-seconds"), 1, MAX_TIMEOUT_SECONDS)
    : DEFAULT_TIMEOUT_SECONDS;
  return seconds === undefined ? undefined : { kind: "run", caseId, variant, timeoutMs: seconds * 1000 };
}

function parseSummary(args: readonly string[]): Command | undefined {
  const flags = parseFlags(args, ["--since-ms"]);
  if (!flags) return undefined;
  const sinceMs = flags.has("--since-ms") ? integerIn(flags.get("--since-ms"), 0, Number.MAX_SAFE_INTEGER) : 0;
  return sinceMs === undefined ? undefined : { kind: "summary", sinceMs };
}

export function parseArgs(argv: readonly string[]): Command | undefined {
  const [verb, ...rest] = argv;
  if (verb === "run") return parseRun(rest);
  return verb === "summary" ? parseSummary(rest) : undefined;
}

export function runIdFor(now: Date, caseId: CaseId, variant: Variant, random: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.[0-9]+Z$/, "Z");
  return `${stamp}-${caseId}-${variant}-${random}`;
}

// A profile that sets anything else would change more than the effort being compared, including
// settings no session record shows.
export function lightProfileProblem(parsed: unknown): string | undefined {
  const keys = Object.keys(asRow(parsed));
  return keys.length === 1 && keys[0] === "model_reasoning_effort"
    ? undefined
    : "model_reasoning_effort だけを設定していない";
}

// ---- One turn of the native CLI.

export type TurnRequest = {
  variant: Variant;
  schemaPath: string;
  outputPath: string;
  prompt: string;
  threadId?: string;
};

// `--profile` belongs to `exec` and has to be repeated on resume: a resumed thread otherwise returns
// to the configured effort (measured on codex-cli 0.167.0). No sandbox, approval, trust, or hook
// flag appears here, so both variants run under the configured boundaries.
export function turnArgv(codex: string, turn: TurnRequest): string[] {
  const profile = turn.variant === "light" ? ["--profile", LIGHT_PROFILE] : [];
  const io = ["--json", "--output-schema", turn.schemaPath, "-o", turn.outputPath];
  return turn.threadId === undefined
    ? [codex, "exec", ...profile, ...io, turn.prompt]
    : [codex, "exec", ...profile, "resume", ...io, turn.threadId, turn.prompt];
}

export type TurnFacts = { threadId?: string; completed: number; failed: number };

// Only the turn's own end events decide. An `error` item can arrive in a turn that goes on to
// succeed (a configuration warning does, measured on codex-cli 0.167.0), and one that never ends
// shows up as a missing turn.completed.
export function parseEvents(text: string): TurnFacts {
  const facts: TurnFacts = { completed: 0, failed: 0 };
  for (const line of text.split("\n")) {
    const event = asRow(parseJson(line));
    if (event.type === "turn.completed") facts.completed += 1;
    else if (event.type === "turn.failed") facts.failed += 1;
    else if (event.type === "thread.started" && typeof event.thread_id === "string" && UUID.test(event.thread_id)) {
      facts.threadId ??= event.thread_id;
    }
  }
  return facts;
}

export const INCOMPLETE_REASONS = [
  "interrupted",
  "timeout",
  "output-limit",
  "launch-failed",
  "exit-nonzero",
  "turn-failed",
  "turn-missing",
  "thread-missing",
  "thread-mismatch",
  "output-missing",
  "output-malformed",
  "harness-error",
] as const;
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number];

export type ChildResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  interrupted: boolean;
  overLimit: boolean;
  launchError: boolean;
};
export type FinalOutput = { state: "missing" } | { state: "malformed" } | { state: "ok"; value: unknown };

export function turnProblem(
  child: ChildResult,
  facts: TurnFacts,
  output: FinalOutput,
  expectedThread?: string,
): IncompleteReason | undefined {
  const rules: [boolean, IncompleteReason][] = [
    [child.interrupted, "interrupted"],
    [child.timedOut, "timeout"],
    [child.overLimit, "output-limit"],
    [child.launchError, "launch-failed"],
    [child.exitCode !== 0, "exit-nonzero"],
    [facts.failed > 0, "turn-failed"],
    [facts.completed < 1, "turn-missing"],
    [facts.threadId === undefined, "thread-missing"],
    [expectedThread !== undefined && facts.threadId !== expectedThread, "thread-mismatch"],
    [output.state === "missing", "output-missing"],
    [output.state === "malformed", "output-malformed"],
  ];
  return rules.find(([hit]) => hit)?.[1];
}

// ---- Identity: what the CLI's own session record says ran, never what the agent says about itself.

const IDENTITY_FIELDS = [
  "cli",
  "cliVersion",
  "provider",
  "model",
  "effort",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "serviceTier",
] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];
export type Identity = Record<IdentityField, string>;

export const UNKNOWN_IDENTITY: Identity = {
  cli: "codex",
  cliVersion: UNKNOWN,
  provider: UNKNOWN,
  model: UNKNOWN,
  effort: UNKNOWN,
  approvalPolicy: UNKNOWN,
  approvalsReviewer: UNKNOWN,
  sandbox: UNKNOWN,
  serviceTier: UNKNOWN,
};

type RolloutReader = (payload: Row) => Partial<Record<IdentityField, unknown>>;

const ROLLOUT_READERS = new Map<unknown, RolloutReader>([
  ["session_meta", (payload) => ({ cliVersion: payload.cli_version, provider: payload.model_provider })],
  [
    "turn_context",
    (payload) => ({
      model: payload.model,
      effort: payload.effort,
      approvalPolicy: payload.approval_policy,
      approvalsReviewer: payload.approvals_reviewer,
      sandbox: asRow(payload.sandbox_policy).type,
    }),
  ],
  [
    "event_msg",
    (payload) =>
      payload.type === "thread_settings_applied" ? { serviceTier: asRow(payload.thread_settings).service_tier } : {},
  ],
]);

function collapse(values: ReadonlySet<string> | undefined): string {
  if (!values) return UNKNOWN;
  return values.size === 1 ? ([...values][0] ?? UNKNOWN) : MIXED;
}

export function parseRollout(text: string): Identity {
  const seen = new Map<IdentityField, Set<string>>();
  for (const line of text.split("\n")) {
    const row = asRow(parseJson(line));
    const fields = ROLLOUT_READERS.get(row.type)?.(asRow(row.payload)) ?? {};
    for (const [field, value] of Object.entries(fields) as [IdentityField, unknown][]) {
      seen.set(field, (seen.get(field) ?? new Set<string>()).add(isToken(value) ? value : UNKNOWN));
    }
  }
  const identity: Identity = { ...UNKNOWN_IDENTITY };
  for (const field of IDENTITY_FIELDS) {
    if (field !== "cli") identity[field] = collapse(seen.get(field));
  }
  return identity;
}

// ---- Run records.

export type Assertion = { id: string; pass: boolean; count?: number };
export type Outcome = "pass" | "fail" | "incomplete";

export type RunRecord = {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  caseId: CaseId;
  caseRevision: string;
  variant: Variant;
  startedAt: string;
  elapsedMs: number;
  outcome: Outcome;
  incompleteReason: IncompleteReason | null;
  exitCode: number | null;
  signal: string | null;
  identity: Identity;
  assertions: Assertion[];
  evidence: string;
};

export function outcomeOf(assertions: readonly Assertion[]): "pass" | "fail" {
  return assertions.length > 0 && assertions.every((assertion) => assertion.pass) ? "pass" : "fail";
}

function validAssertion(value: unknown): boolean {
  const row = asRow(value);
  const countOk = row.count === undefined || (Number.isInteger(row.count) && Number(row.count) >= 0);
  return typeof row.id === "string" && ASSERTION_ID.test(row.id) && typeof row.pass === "boolean" && countOk;
}

function validIdentity(value: unknown): boolean {
  const row = asRow(value);
  return IDENTITY_FIELDS.every((field) => isToken(row[field]));
}

// The stated outcome has to follow from the assertions beside it, so a record cannot claim a pass
// its own checks do not support.
function outcomeConsistent(row: Row): boolean {
  if (!Array.isArray(row.assertions) || row.assertions.length > MAX_ASSERTIONS) return false;
  if (!row.assertions.every(validAssertion)) return false;
  if (row.outcome === "incomplete") return isMember(INCOMPLETE_REASONS, row.incompleteReason);
  const assertions = row.assertions as Assertion[];
  return row.incompleteReason === null && assertions.length > 0 && row.outcome === outcomeOf(assertions);
}

const RECORD_RULES: ((row: Row, stem: string) => boolean)[] = [
  (row) => row.schemaVersion === SCHEMA_VERSION,
  (row, stem) => row.runId === stem && RUN_ID.test(stem),
  (row) => isMember(CASE_IDS, row.caseId),
  (row) => isMember(VARIANTS, row.variant),
  (row) => typeof row.caseRevision === "string" && REVISION.test(row.caseRevision),
  (row) => typeof row.startedAt === "string" && Number.isFinite(Date.parse(row.startedAt)),
  (row) => Number.isInteger(row.elapsedMs) && Number(row.elapsedMs) >= 0 && Number(row.elapsedMs) <= MAX_ELAPSED_MS,
  (row) => row.exitCode === null || Number.isInteger(row.exitCode),
  (row) => row.signal === null || isToken(row.signal),
  (row) => validIdentity(row.identity),
  (row, stem) => row.evidence === `evidence/${stem}`,
  (row) => outcomeConsistent(row),
];

export function parseRecord(value: unknown, stem: string): RunRecord | undefined {
  const row = asRow(value);
  return RECORD_RULES.every((rule) => rule(row, stem)) ? (row as unknown as RunRecord) : undefined;
}

// ---- Workspace and check results.

export function changedPaths(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string | null>,
): string[] {
  const changed = new Set<string>();
  for (const [path, text] of expected) {
    if (actual.get(path) !== text) changed.add(path);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

export type CheckOutput = { started: boolean; values: ReadonlyMap<string, unknown> };

// The child reports what it saw and this reads nothing else, so a `pass` on a line means nothing.
// `started` separates a harness that never ran from agent code that broke it. Lines naming anything
// else are ignored, and a check reported twice has no value: one of the two came from the agent.
export function parseCheckOutput(text: string, ids: readonly string[]): CheckOutput {
  const values = new Map<string, unknown>();
  const repeated = new Set<string>();
  let started = false;
  for (const line of text.split("\n")) {
    const row = asRow(parseJson(line));
    const id = row[CHECK_MARKER];
    if (id === CHECK_STARTED) started = true;
    else if (isMember(ids, id)) {
      if (values.has(id)) repeated.add(id);
      values.set(id, row.value);
    }
  }
  for (const id of repeated) values.delete(id);
  return { started, values };
}

const endedByItself = (child: ChildResult) =>
  child.exitCode === 0 &&
  child.signal === null &&
  !child.timedOut &&
  !child.interrupted &&
  !child.overLimit &&
  !child.launchError;

// A value counts only from a run that ended by itself with success, so code that crashes or stops the
// harness early earns nothing for what it printed first.
// ponytail: a module that prints every right value and exits 0 still passes. That is the same as
// hard-coding the fixed table, which no black-box check can tell apart; random inputs if it ever matters.
export function judgeChecks(
  checks: readonly { id: string; want: unknown }[],
  output: CheckOutput,
  child: ChildResult,
): Map<string, boolean> {
  const clean = endedByItself(child);
  return new Map(checks.map(({ id, want }) => [id, clean && isDeepStrictEqual(output.values.get(id), want)]));
}

// ---- Summary: counts per comparable group. It prints no speed difference, so a small sample
// cannot read as a speed improvement.

const SUMMARY_HEADER = [
  "case",
  "variant",
  "revision",
  "cli",
  "model",
  "effort",
  "settings",
  "runs",
  "pass",
  "fail",
  "incomplete",
  "median_pass_ms",
  "ms_per_pass",
  "comparison",
].join("\t");

type Group = { caseId: CaseId; variant: Variant; revision: string; identity: Identity; runs: RunRecord[] };

function groupRuns(records: readonly RunRecord[]): Group[] {
  const groups = new Map<string, Group>();
  for (const record of records) {
    const key = JSON.stringify([
      record.caseId,
      record.variant,
      record.caseRevision,
      ...IDENTITY_FIELDS.map((field) => record.identity[field]),
    ]);
    const group = groups.get(key) ?? {
      caseId: record.caseId,
      variant: record.variant,
      revision: record.caseRevision,
      identity: record.identity,
      runs: [],
    };
    group.runs.push(record);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function settingsOf(identity: Identity): string {
  const { provider, approvalPolicy, approvalsReviewer, sandbox, serviceTier } = identity;
  return [provider, approvalPolicy, approvalsReviewer, sandbox, serviceTier].join(",");
}

function isObserved(identity: Identity): boolean {
  return IDENTITY_FIELDS.every((field) => identity[field] !== UNKNOWN && identity[field] !== MIXED);
}

function incomparableReasons(a: Group, b: Group): string[] {
  const rules: [string, boolean][] = [
    ["case-revision", a.revision !== b.revision],
    ["cli-version", a.identity.cliVersion !== b.identity.cliVersion],
    ["model", a.identity.model !== b.identity.model],
    ["settings", settingsOf(a.identity) !== settingsOf(b.identity)],
    ["unknown-identity", !isObserved(a.identity) || !isObserved(b.identity)],
    ["same-effort", a.identity.effort === b.identity.effort],
  ];
  return rules.filter(([, hit]) => hit).map(([reason]) => reason);
}

function latestStart(group: Group): number {
  return Math.max(...group.runs.map((run) => Date.parse(run.startedAt)));
}

function comparisonOf(group: Group, groups: readonly Group[]): string {
  const others = groups.filter((other) => other.caseId === group.caseId && other.variant !== group.variant);
  if (others.length === 0) return "no-counterpart";
  if (others.some((other) => incomparableReasons(group, other).length === 0)) return "comparable";
  const newest = others.reduce((best, other) => (latestStart(other) > latestStart(best) ? other : best));
  return `incomparable:${incomparableReasons(group, newest).join("+")}`;
}

function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return undefined;
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : Math.round(((sorted[middle - 1] ?? 0) + upper) / 2);
}

function renderGroup(group: Group, groups: readonly Group[]): string {
  const count = (outcome: Outcome) => group.runs.filter((run) => run.outcome === outcome).length;
  const passTimes = group.runs.filter((run) => run.outcome === "pass").map((run) => run.elapsedMs);
  // Failed runs stay in the cost of a pass: a faster setting that needs a rerun is not faster.
  const judgedMs = group.runs
    .filter((run) => run.outcome !== "incomplete")
    .reduce((sum, run) => sum + run.elapsedMs, 0);
  return [
    group.caseId,
    group.variant,
    group.revision,
    group.identity.cliVersion,
    group.identity.model,
    group.identity.effort,
    settingsOf(group.identity),
    group.runs.length,
    count("pass"),
    count("fail"),
    count("incomplete"),
    median(passTimes) ?? "-",
    passTimes.length > 0 ? Math.round(judgedMs / passTimes.length) : "-",
    comparisonOf(group, groups),
  ].join("\t");
}

function groupOrder(a: Group, b: Group): number {
  return (
    CASE_IDS.indexOf(a.caseId) - CASE_IDS.indexOf(b.caseId) ||
    VARIANTS.indexOf(a.variant) - VARIANTS.indexOf(b.variant) ||
    latestStart(b) - latestStart(a)
  );
}

export function renderSummary(input: { records: readonly RunRecord[]; malformed: number; omitted: number }): string {
  const groups = groupRuns(input.records).sort(groupOrder);
  const lines =
    groups.length > 0 ? [SUMMARY_HEADER, ...groups.map((group) => renderGroup(group, groups))] : [NO_RECORDS];
  if (input.malformed > 0) lines.push(`malformed_records: ${input.malformed} (pass に数えない)`);
  if (input.omitted > 0) lines.push(`omitted_records: ${input.omitted} (古い順に読み飛ばした)`);
  return lines.join("\n");
}
