// Detects tools whose running processes are older than what is installed, and after one
// interactive approval restarts whole local Herdr sessions through Herdr's native restore.
// See "Tool restarts" in README.md. Decisions live in tool-restart-core.ts.
import { dlopen } from "bun:ffi";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import {
  type AgentId,
  type AgentRef,
  type AssessEnv,
  agentsInAffectedSessions,
  approvalHolds,
  attentionRows,
  type Backend,
  buildWorld,
  claudeHeadMatches,
  cleanupBlockers,
  codexHeadMatches,
  extractVersion,
  type GuiPlan,
  type GuiStatus,
  grokSummaryMatches,
  guiActionable,
  guiApprovalHolds,
  hasCodexDaemon,
  hasWork,
  herdrContainment,
  type Installed,
  judgeRecovery,
  type McpServer,
  mcpArgvKeys,
  notificationKey,
  notificationMessage,
  type Observed,
  type OmpInventory,
  ompHeaderId,
  type PaneProcesses,
  type Plan,
  type Proc,
  parseClaudeMcpServers,
  parseCodexBackend,
  parseGrokLeaders,
  parseGuiStatus,
  parseJson,
  parseMappedExes,
  parseMcpServers,
  parseOmpInventory,
  parseProcessInfo,
  parseProcs,
  parseRecoveryRecord,
  parseServerStatus,
  parseSessionList,
  parseSnapshot,
  parseSocketOwners,
  planGui,
  planJson,
  planSession,
  type RecoveryRecord,
  type RecoveryView,
  readySessions,
  recoveriesToRun,
  remaining,
  renderPlan,
  restoreEnabled,
  restoreMismatches,
  runningRows,
  type SavedRef,
  sameProcessView,
  scopePlan,
  type SessionEntry,
  type SessionObservation,
  type SessionPlan,
  socketServer,
  TOOL_IDS,
  TOOL_LABELS,
  type ToolId,
} from "./tool-restart-core";

export type Ctx = {
  env: Record<string, string | undefined>;
  pid: number;
  uid: number;
  isTty: boolean;
  restoreAttempts: number;
  sleep(ms: number): Promise<unknown>;
  ask(prompt: string): Promise<string>;
  out(text: string): void;
  err(text: string): void;
};

type RunOptions = { env?: Record<string, string>; timeoutMs?: number };
type RunResult = { code: number; stdout: string };

const EXIT = { ok: 0, failed: 1, usage: 2, deferred: 3 } as const;
const USAGE = "usage: tool-restart [--status [--json] | --notify | --cleanup-check | --apply [--session <name>]]";
const COMMAND_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const POLL_MS = 1_000;
const STOP_ATTEMPTS = 30;
const CLIENT_CLOSE_MS = 3_000;
const HEAD_BYTES = 1024 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PANE_ID = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const PS_FORMAT = "pid=,ppid=,pgid=,uid=,stat=,lstart=,comm=";
const LOCK_EX_NB = 2 | 4;

function homeOf(ctx: Ctx): string {
  const home = ctx.env.HOME;
  if (!home) throw new Error("HOME が設定されていない");
  return home;
}

// HERDR_* would retarget every call at whichever session this process inherited.
function cleanEnv(ctx: Ctx): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx.env)) {
    if (value !== undefined && !key.startsWith("HERDR_")) env[key] = value;
  }
  return env;
}

function run(ctx: Ctx, argv: readonly string[], options: RunOptions = {}): RunResult {
  const [command, ...args] = argv;
  const path = Bun.which(command ?? "", { PATH: ctx.env.PATH ?? "" });
  if (!path) return { code: 127, stdout: "" };
  const result = Bun.spawnSync([path, ...args], {
    env: { ...cleanEnv(ctx), ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return { code: result.exitCode ?? 124, stdout: result.stdout?.toString() ?? "" };
}

function jsonOf(ctx: Ctx, argv: readonly string[], options?: RunOptions): unknown {
  return parseJson(run(ctx, argv, options).stdout);
}

function herdrRoot(ctx: Ctx): string {
  return join(homeOf(ctx), ".config/herdr");
}

function readProcs(ctx: Ctx): Proc[] {
  const result = run(ctx, ["ps", "-Ao", PS_FORMAT], { env: { LC_ALL: "C" } });
  const procs = parseProcs(result.stdout);
  if (result.code !== 0 || procs.length === 0) throw new Error("プロセス一覧を読めない");
  return procs;
}

function readSessions(ctx: Ctx): SessionEntry[] {
  const result = run(ctx, ["herdr", "session", "list", "--json"]);
  if (result.code === 127) return [];
  if (result.code !== 0) throw new Error("herdr session list に失敗した");
  return parseSessionList(parseJson(result.stdout), herdrRoot(ctx));
}

function readPaneProcesses(ctx: Ctx, paneId: string, env: Record<string, string>): PaneProcesses | undefined {
  if (!PANE_ID.test(paneId)) return undefined;
  return parseProcessInfo(jsonOf(ctx, ["herdr", "pane", "process-info", "--pane", paneId], { env }));
}

function observeSession(
  ctx: Ctx,
  entry: SessionEntry,
  owners: Map<string, number[]>,
  procs: readonly Proc[],
): SessionObservation {
  const processes = new Map<string, PaneProcesses | undefined>();
  if (entry.invalid || !entry.running) return { entry, processes };
  const env = { HERDR_SOCKET_PATH: entry.socket };
  const serverPid = socketServer(owners.get(entry.socket), procs);
  const status = parseServerStatus(jsonOf(ctx, ["herdr", "status", "--json"], { env }));
  // The session named by the socket must be the one answering, or the panes below belong to another.
  if (status.socket !== entry.socket) return { entry, processes, serverPid };
  const panes = parseSnapshot(jsonOf(ctx, ["herdr", "api", "snapshot"], { env }));
  for (const pane of panes ?? []) processes.set(pane.id, readPaneProcesses(ctx, pane.id, env));
  return { entry, status, panes, processes, serverPid };
}

function readGui(ctx: Ctx): GuiStatus {
  const result = run(ctx, ["sheprd", "status", "--json"]);
  return parseGuiStatus(result.code, parseJson(result.stdout));
}

function resolveEntry(ctx: Ctx, tool: ToolId): { path: string; inode: string } | undefined {
  const entry = Bun.which(tool, { PATH: ctx.env.PATH ?? "" });
  if (!entry) return undefined;
  try {
    const path = realpathSync(entry);
    return { path, inode: String(statSync(path).ino) };
  } catch {
    return undefined;
  }
}

function sheprdVersion(ctx: Ctx, exePath: string): string | undefined {
  const plist = join(exePath, "../../Info.plist");
  return run(ctx, ["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]).stdout.trim();
}

function readInstalledTool(ctx: Ctx, tool: ToolId): Installed {
  const entry = resolveEntry(ctx, tool);
  if (!entry) return {};
  const version =
    tool === "sheprd" ? sheprdVersion(ctx, entry.path) : extractVersion(run(ctx, [tool, "--version"]).stdout);
  return { ...entry, version: version || undefined };
}

function readInstalled(ctx: Ctx): Record<ToolId, Installed> {
  return Object.fromEntries(TOOL_IDS.map((tool) => [tool, readInstalledTool(ctx, tool)])) as Record<ToolId, Installed>;
}

function interestingPids(procs: readonly Proc[], sessions: readonly SessionObservation[], gui: GuiStatus): number[] {
  const named = procs.filter((proc) => TOOL_IDS.some((tool) => tool === proc.name)).map((proc) => proc.pid);
  const inPanes = sessions.flatMap((session) => [
    ...(session.serverPid === undefined ? [] : [session.serverPid]),
    ...[...session.processes.values()].flatMap((info) => (info?.foreground ?? []).map((proc) => proc.pid)),
  ]);
  return [...new Set([...named, ...inPanes, ...(gui.pid === undefined ? [] : [gui.pid])])];
}

function readExes(ctx: Ctx, pids: readonly number[]) {
  if (pids.length === 0) return new Map();
  return parseMappedExes(run(ctx, ["lsof", "-nP", "-a", "-d", "txt", "-Fpin", "-p", pids.join(",")]).stdout);
}

function readBackend(ctx: Ctx): Backend {
  const result = run(ctx, ["codex", "app-server", "daemon", "version"]);
  return result.code === 0 ? parseCodexBackend(parseJson(result.stdout)) : "unknown";
}

type SlowFacts = { installed: Record<ToolId, Installed>; backend: Backend };

// Launching every tool takes seconds and says nothing about the panes, so it goes first: what a
// decision rests on is then the newest thing read rather than the oldest.
function readSlowFacts(ctx: Ctx): SlowFacts {
  return { installed: readInstalled(ctx), backend: readBackend(ctx) };
}

function observeNow(ctx: Ctx, slow: SlowFacts, only?: string): Observed {
  const procs = readProcs(ctx);
  const owners = parseSocketOwners(run(ctx, ["lsof", "-nP", "-a", "-U", "-c", "herdr", "-Fpn"]).stdout);
  const entries = readSessions(ctx).filter((entry) => only === undefined || entry.name === only);
  const sessions = entries.map((entry) => observeSession(ctx, entry, owners, procs));
  const gui = readGui(ctx);
  const exes = readExes(ctx, interestingPids(procs, sessions, gui));
  const world = buildWorld({ procs, exes, installed: slow.installed, home: homeOf(ctx) });
  // A daemon executable mapped right now contradicts a daemon reporting itself absent.
  const backend = slow.backend === "absent" && hasCodexDaemon(world) ? "unknown" : slow.backend;
  return { world, sessions, gui, backend };
}

function observe(ctx: Ctx): Observed {
  return observeNow(ctx, readSlowFacts(ctx));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isOwnedSocket(ctx: Ctx, path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.uid === ctx.uid && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function ownedFileSize(ctx: Ctx, path: string): number {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.uid === ctx.uid ? stat.size : 0;
  } catch {
    return 0;
  }
}

// Bounded, and refuses symlinks and other users' files: the path comes from Herdr's session data.
function readOwnedHead(ctx: Ctx, path: string): string | undefined {
  try {
    const size = ownedFileSize(ctx, path);
    if (size === 0) return undefined;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size, HEAD_BYTES));
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const NOT_SAVED: SavedRef = { ok: false, reason: "保存された会話が見つからない" };
const MALFORMED_REF: SavedRef = { ok: false, reason: "会話の参照が不正" };
const MISMATCHED: SavedRef = { ok: false, reason: "保存された会話の ID または cwd が一致しない" };

function savedOmp(ctx: Ctx, ref: AgentRef, cwd: string): SavedRef {
  const path = ref.value;
  if (!isAbsolute(path) || normalize(path) !== path || !path.endsWith(".jsonl")) return MALFORMED_REF;
  const head = readOwnedHead(ctx, path);
  if (!head) return NOT_SAVED;
  const sessionId = ompHeaderId(head, cwd);
  return sessionId ? { ok: true, sessionId } : MISMATCHED;
}

// A profile set through CLAUDE_CONFIG_DIR saves elsewhere; missing here defers rather than
// reading the pane's environment or guessing at other profiles.
function savedClaude(ctx: Ctx, ref: AgentRef, cwd: string): SavedRef {
  if (!UUID.test(ref.value)) return MALFORMED_REF;
  const project = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const head = readOwnedHead(ctx, join(homeOf(ctx), ".claude/projects", project, `${ref.value}.jsonl`));
  if (!head) return NOT_SAVED;
  return claudeHeadMatches(head, ref.value, cwd) ? { ok: true, sessionId: ref.value } : MISMATCHED;
}

function codexRollout(root: string, id: string): string | undefined {
  try {
    const matches = [...new Bun.Glob(`*/*/*/rollout-*-${id}.jsonl`).scanSync({ cwd: root })];
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function savedCodex(ctx: Ctx, ref: AgentRef, cwd: string): SavedRef {
  if (!UUID.test(ref.value)) return MALFORMED_REF;
  const root = join(homeOf(ctx), ".codex/sessions");
  const rollout = codexRollout(root, ref.value);
  const head = rollout && readOwnedHead(ctx, join(root, rollout));
  if (!head) return NOT_SAVED;
  return codexHeadMatches(head, ref.value, cwd) ? { ok: true, sessionId: ref.value } : MISMATCHED;
}

// The metadata beside the transcript identifies the conversation, so the transcript is never read.
function savedGrok(ctx: Ctx, ref: AgentRef, cwd: string): SavedRef {
  if (!UUID.test(ref.value)) return MALFORMED_REF;
  const grokHome = join(homeOf(ctx), ".grok");
  const dir = join(grokHome, "sessions", encodeURIComponent(cwd), ref.value);
  const summary = readOwnedHead(ctx, join(dir, "summary.json"));
  if (!summary || ownedFileSize(ctx, join(dir, "chat_history.jsonl")) === 0) return NOT_SAVED;
  return grokSummaryMatches(summary, { id: ref.value, cwd, grokHome })
    ? { ok: true, sessionId: ref.value }
    : MISMATCHED;
}

const SAVED_REF_READERS: Record<AgentId, (ctx: Ctx, ref: AgentRef, cwd: string) => SavedRef> = {
  omp: savedOmp,
  claude: savedClaude,
  codex: savedCodex,
  grok: savedGrok,
};

function readRestoreSetting(ctx: Ctx): boolean {
  const path = join(herdrRoot(ctx), "config.toml");
  if (!existsSync(path)) return true;
  try {
    return restoreEnabled(Bun.TOML.parse(readFileSync(path, "utf8")));
  } catch {
    return false;
  }
}

function readToml(path: string): unknown {
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function claudeServers(ctx: Ctx, cwd: string): McpServer[] {
  return parseClaudeMcpServers(parseJson(readText(join(homeOf(ctx), ".claude.json"))), cwd);
}

function grokServers(ctx: Ctx, cwd: string): McpServer[] {
  const own = parseMcpServers(readToml(join(homeOf(ctx), ".grok/config.toml")), "mcp_servers");
  return [...own, ...claudeServers(ctx, cwd)];
}

// The agent's own user-level configuration only. A repository's .mcp.json is not read: it is
// content the repository controls, and it must not be able to declare a job harmless. What an
// agent imports from other tools (OMP from Claude's config, say) is not followed either: which
// imports apply is that agent's own logic, so those servers stay unidentified and defer.
const MCP_SOURCES: Record<AgentId, (ctx: Ctx, cwd: string) => McpServer[]> = {
  claude: claudeServers,
  codex: (ctx) => parseMcpServers(readToml(join(homeOf(ctx), ".codex/config.toml")), "mcp_servers"),
  omp: (ctx) => parseMcpServers(parseJson(readText(join(homeOf(ctx), ".omp/agent/mcp.json"))), "mcpServers"),
  grok: grokServers,
};

function commandHead(ctx: Ctx, path: string): string | undefined {
  try {
    return readOwnedHead(ctx, realpathSync(path));
  } catch {
    return undefined;
  }
}

function mcpArgvs(ctx: Ctx, agent: AgentId, cwd: string): ReadonlySet<string> {
  const files = {
    resolve: (command: string) => Bun.which(command, { PATH: ctx.env.PATH ?? "" }) ?? undefined,
    head: (path: string) => commandHead(ctx, path),
  };
  return new Set(MCP_SOURCES[agent](ctx, cwd).flatMap((server) => mcpArgvKeys(server, files)));
}

type Inventories = { omp?: OmpInventory; grokLeaders?: number; restoreOn: boolean };

function readInventories(ctx: Ctx, agents: ReadonlySet<string>): Inventories {
  return {
    restoreOn: readRestoreSetting(ctx),
    omp: agents.has("omp") ? parseOmpInventory(jsonOf(ctx, ["omp", "ps", "list", "--all", "--json"])) : undefined,
    grokLeaders: agents.has("grok") ? parseGrokLeaders(jsonOf(ctx, ["grok", "leader", "list", "--json"])) : undefined,
  };
}

function assessEnv(ctx: Ctx, observed: Observed, recovering: ReadonlySet<string>, inventories: Inventories): AssessEnv {
  return {
    ...inventories,
    world: observed.world,
    uid: ctx.uid,
    backend: observed.backend,
    recovering,
    mcpArgvs: (agent, cwd) => mcpArgvs(ctx, agent, cwd),
    savedRef: (agent, ref, cwd) => SAVED_REF_READERS[agent](ctx, ref, cwd),
    dirExists: isDirectory,
    socketOwned: (path) => isOwnedSocket(ctx, path),
  };
}

function stateRoot(ctx: Ctx): string {
  return join(homeOf(ctx), ".local/state/tool-restart");
}

function recoveryDir(ctx: Ctx): string {
  return join(stateRoot(ctx), "recovery");
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function recoveryView(file: string, stem: string, observed: Observed): RecoveryView {
  const record = parseRecoveryRecord(parseJson(readText(file)), stem);
  if (!record) return { session: stem, state: "corrupt", mismatches: ["復旧記録を読めない"], file };
  const session = observed.sessions.find((candidate) => candidate.entry.name === record.session);
  return { session: stem, file, record, ...judgeRecovery(record, session, observed.world) };
}

// A record only ever feeds comparisons and a client attach: it is never authority to stop anything.
function readRecovery(ctx: Ctx, observed: Observed): RecoveryView[] {
  const dir = recoveryDir(ctx);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  return files.map((file) => recoveryView(join(dir, file), file.slice(0, -".json".length), observed));
}

function unresolved(views: readonly RecoveryView[]): string[] {
  return views.filter((task) => task.state === "needs-client" || task.state === "corrupt").map((task) => task.session);
}

function buildPlan(
  ctx: Ctx,
  observed: Observed,
  inventories = readInventories(ctx, agentsInAffectedSessions(observed)),
): Plan {
  const recovery = readRecovery(ctx, observed);
  const env = assessEnv(ctx, observed, new Set(unresolved(recovery)), inventories);
  return {
    rows: runningRows(observed),
    installed: observed.world.installed,
    sessions: observed.sessions.map((session) => planSession(session, observed, env)),
    gui: planGui(observed),
    recovery,
  };
}

function runStatus(ctx: Ctx, json: boolean): number {
  const plan = buildPlan(ctx, observe(ctx));
  ctx.out(json ? JSON.stringify(planJson(plan)) : renderPlan(plan));
  return EXIT.ok;
}

function runNotify(ctx: Ctx): number {
  const observed = observe(ctx);
  const rows = attentionRows(runningRows(observed));
  const recovering = unresolved(readRecovery(ctx, observed));
  const key = JSON.stringify(notificationKey(rows, recovering, observed.world.installed));
  const file = join(stateRoot(ctx), "notified.json");
  if (rows.length === 0 && recovering.length === 0) {
    rmSync(file, { force: true });
    return EXIT.ok;
  }
  if (readText(file) === key) return EXIT.ok;
  const message = notificationMessage(rows, recovering, observed.world.installed);
  const sent = run(ctx, ["terminal-notifier", "-title", "tool-restart", "-message", message, "-group", "tool-restart"]);
  if (sent.code !== 0) {
    ctx.err("tool-restart: 通知を送れなかった。次回の実行で再試行する");
    return EXIT.failed;
  }
  ensurePrivateDir(stateRoot(ctx));
  writePrivate(file, key);
  return EXIT.ok;
}

function runCleanupCheck(ctx: Ctx): number {
  const rows = cleanupBlockers(runningRows(observe(ctx)));
  if (rows.length === 0) return EXIT.ok;
  for (const row of rows) {
    ctx.err(`tool-restart: ${TOOL_LABELS[row.tool]} ${row.role} ${row.version ?? "?"} (pid ${row.pid}) が残っている`);
  }
  ctx.err("tool-restart: Herdr の外で tool-restart --apply を実行してから scripts/brewUpdate を再実行する");
  return EXIT.failed;
}

// flock(2) belongs to this open file and the kernel drops it however the process ends, so no stale
// lock can exist and the file's content, or a half-written one, decides nothing. The file stays:
// deleting it would let a later run lock a new file while an earlier one still holds the old one.
// Node's fs has no flock. Files Bun opens are close-on-exec, so a server started by our client
// cannot inherit the lock (measured).
function acquireLock(ctx: Ctx): number | undefined {
  ensurePrivateDir(stateRoot(ctx));
  const libc = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  const { symbols } = dlopen(libc, { flock: { args: ["i32", "i32"], returns: "i32" } });
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(join(stateRoot(ctx), "apply.lock"), flags, 0o600);
  if (symbols.flock(fd, LOCK_EX_NB) === 0) return fd;
  closeSync(fd);
  return undefined;
}

async function waitUntil(ctx: Ctx, check: () => boolean, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return true;
    await ctx.sleep(POLL_MS);
  }
  return false;
}

function attachArgv(session: string): string[] {
  return session === "default" ? [] : ["session", "attach", session];
}

// Native restore only starts once a client attaches. This client owns its PTY, discards what
// it receives (pane_history stays off), and closing it leaves the server and panes running.
function openClient(ctx: Ctx, session: string): { close(): Promise<void> } {
  const herdr = Bun.which("herdr", { PATH: ctx.env.PATH ?? "" });
  if (!herdr) throw new Error("herdr が見つからない");
  const proc = Bun.spawn([herdr, ...attachArgv(session)], {
    env: { TERM: "xterm-256color", ...cleanEnv(ctx) },
    terminal: {
      cols: 120,
      rows: 40,
      data() {
        // Screen content is never kept.
      },
    },
  });
  return {
    async close() {
      proc.kill();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(CLIENT_CLOSE_MS).then(() => false)]);
      if (!exited) proc.kill("SIGKILL");
      proc.terminal?.close();
    },
  };
}

function mismatchesNow(ctx: Ctx, record: RecoveryRecord): string[] {
  const observed = observe(ctx);
  const session = observed.sessions.find((candidate) => candidate.entry.name === record.session);
  return restoreMismatches(record, session, observed.world);
}

async function awaitRestored(ctx: Ctx, record: RecoveryRecord): Promise<void> {
  await waitUntil(ctx, () => mismatchesNow(ctx, record).length === 0, ctx.restoreAttempts);
}

function recordFailure(ctx: Ctx, record: RecoveryRecord, file: string, problems: readonly string[]): void {
  writePrivate(file, JSON.stringify({ ...record, failure: problems }));
  ctx.err(`tool-restart: ${record.session} の復元を確認できなかった。元の参照は ${file} にある`);
  for (const problem of problems) ctx.err(`  ${problem}`);
}

async function restoreAndVerify(ctx: Ctx, record: RecoveryRecord, file: string): Promise<boolean> {
  const client = openClient(ctx, record.session);
  try {
    await awaitRestored(ctx, record);
  } finally {
    await client.close();
  }
  // Checked again after the client is gone, since a server that dies with its client is a failure.
  const problems = mismatchesNow(ctx, record);
  if (problems.length > 0) {
    recordFailure(ctx, record, file, problems);
    return false;
  }
  rmSync(file, { force: true });
  ctx.out(`${record.session}: 同じペインと会話への復元を確認した`);
  return true;
}

function sessionStopped(ctx: Ctx, name: string): boolean {
  return readSessions(ctx).find((entry) => entry.name === name)?.running === false;
}

function serverUnchanged(ctx: Ctx, record: RecoveryRecord): boolean {
  const observed = observe(ctx);
  const session = observed.sessions.find((candidate) => candidate.entry.name === record.session);
  return judgeRecovery(record, session, observed.world).state === "not-stopped";
}

async function stopSession(ctx: Ctx, record: RecoveryRecord, file: string): Promise<boolean> {
  run(ctx, ["herdr", "session", "stop", record.session, "--json"], { timeoutMs: STOP_TIMEOUT_MS });
  const stopped = await waitUntil(ctx, () => sessionStopped(ctx, record.session), STOP_ATTEMPTS);
  if (stopped || !serverUnchanged(ctx, record)) return true;
  rmSync(file, { force: true });
  ctx.err(`tool-restart: ${record.session} を停止できなかった。何も変わっていない`);
  return false;
}

type Outcome = "ok" | "changed" | "failed";

// The last look before a stop. Slow reads come first, then the process table and native pane state,
// then the process table once more to catch whatever started while the rest was being read.
// `herdr session stop` has no conditional form, so a job starting between that last read and the
// stop still stops with the session: this narrows the window and cannot close it.
function latestPlan(ctx: Ctx, approved: SessionPlan): SessionPlan | undefined {
  const name = approved.record.session;
  const slow = readSlowFacts(ctx);
  const inventories = readInventories(ctx, new Set(approved.record.panes.flatMap((pane) => pane.agent ?? [])));
  const observed = observeNow(ctx, slow, name);
  const session = observed.sessions.find((candidate) => candidate.entry.name === name);
  const plan = buildPlan(ctx, observed, inventories).sessions.find((candidate) => candidate.record.session === name);
  if (!session || !plan) return undefined;
  const { exes, installed, home } = observed.world;
  const again = buildWorld({ procs: readProcs(ctx), exes, installed, home });
  return sameProcessView(session, observed.world, again) ? plan : undefined;
}

// Approval covers exactly what the operator saw: anything different now voids it.
async function restartSession(ctx: Ctx, approved: SessionPlan): Promise<Outcome> {
  const fresh = latestPlan(ctx, approved);
  if (!approvalHolds(approved, fresh)) {
    ctx.err(`tool-restart: 承認後に ${approved.name} の状態が変わったため止めなかった。再実行して確認する`);
    return "changed";
  }
  const record = fresh.record;
  ensurePrivateDir(recoveryDir(ctx));
  const file = join(recoveryDir(ctx), `${record.session}.json`);
  writePrivate(file, JSON.stringify(record));
  if (!(await stopSession(ctx, record, file))) return "failed";
  return (await restoreAndVerify(ctx, record, file)) ? "ok" : "failed";
}

function guiRestarted(ctx: Ctx, approved: GuiPlan): boolean {
  const gui = planGui(observe(ctx));
  return gui.state === "current" && gui.pid !== approved.pid;
}

async function waitForGuiExit(ctx: Ctx): Promise<boolean> {
  return waitUntil(ctx, () => !readGui(ctx).running, STOP_ATTEMPTS);
}

async function quitGui(ctx: Ctx): Promise<"ok" | "busy" | "failed"> {
  const quit = run(ctx, ["sheprd", "app", "quit", "--json"]).code;
  if (quit === 6) {
    ctx.err("tool-restart: Sheprd がダイアログ表示中で終了できない。閉じてから再実行する");
    return "busy";
  }
  if (quit !== 0 && quit !== 3) {
    ctx.err(`tool-restart: Sheprd を終了できなかった (exit ${quit})`);
    return "failed";
  }
  return (await waitForGuiExit(ctx)) ? "ok" : "failed";
}

async function restartGui(ctx: Ctx, approved: GuiPlan): Promise<Outcome> {
  const fresh = planGui(observe(ctx));
  if (!guiApprovalHolds(approved, fresh) || !fresh.bundle) {
    ctx.err("tool-restart: 承認後に Sheprd の状態が変わったため止めなかった");
    return "changed";
  }
  const quit = await quitGui(ctx);
  if (quit !== "ok") return quit === "busy" ? "changed" : "failed";
  if (run(ctx, ["open", fresh.bundle]).code === 0) {
    if (await waitUntil(ctx, () => guiRestarted(ctx, approved), ctx.restoreAttempts)) return "ok";
  }
  ctx.err("tool-restart: Sheprd の起動を確認できなかった");
  return "failed";
}

function exitFor(plan: Plan): number {
  return remaining(plan) ? EXIT.deferred : EXIT.ok;
}

async function runRecoveries(ctx: Ctx, plan: Plan): Promise<boolean> {
  for (const task of recoveriesToRun(plan)) {
    if (task.record && !(await restoreAndVerify(ctx, task.record, task.file))) return false;
  }
  return true;
}

type PlanView = (plan: Plan) => Plan;

async function executeWork(ctx: Ctx, plan: Plan, view: PlanView): Promise<number> {
  if (!(await runRecoveries(ctx, plan))) return EXIT.failed;
  for (const session of readySessions(plan)) {
    const outcome = await restartSession(ctx, session);
    if (outcome !== "ok") return outcome === "changed" ? EXIT.deferred : EXIT.failed;
  }
  if (guiActionable(plan) && (await restartGui(ctx, plan.gui)) === "failed") return EXIT.failed;
  const final = view(buildPlan(ctx, observe(ctx)));
  ctx.out(renderPlan(final));
  return exitFor(final);
}

// Records of a stop that never happened or a restore that has since finished need no action.
function settleRecoveries(ctx: Ctx, observed: Observed): void {
  for (const task of readRecovery(ctx, observed)) {
    if (task.state === "restored" || task.state === "not-stopped") rmSync(task.file, { force: true });
    if (task.state === "restored") ctx.out(`${task.session}: 前回の再起動は復元済みと確認した`);
  }
}

async function applyLocked(ctx: Ctx, observed: Observed, only?: string): Promise<number> {
  settleRecoveries(ctx, observed);
  const view: PlanView = only === undefined ? (full) => full : (full) => scopePlan(full, only);
  const plan = view(buildPlan(ctx, observed));
  if (only !== undefined && plan.sessions.length === 0) {
    ctx.err("tool-restart: 指定されたローカルセッションが見つからない");
    return EXIT.usage;
  }
  ctx.out(renderPlan(plan));
  if (!hasWork(plan)) return exitFor(plan);
  if (!ctx.isTty) {
    ctx.err("tool-restart: --apply には対話端末での承認が必要。無人実行の経路はない");
    return EXIT.failed;
  }
  const answer = await ctx.ask("上記をすべて実行するなら yes と入力: ");
  if (answer.trim() !== "yes") {
    ctx.out("中止した。何も変更していない");
    return EXIT.deferred;
  }
  return executeWork(ctx, plan, view);
}

async function runApply(ctx: Ctx, only?: string): Promise<number> {
  const observed = observe(ctx);
  if (herdrContainment(ctx.pid, observed) !== "outside") {
    ctx.err("tool-restart: --apply は Herdr と Sheprd の外で実行する。Terminal.app を開いて次を実行する:");
    ctx.err("  ~/.local/bin/tool-restart --apply");
    return EXIT.failed;
  }
  const lock = acquireLock(ctx);
  if (lock === undefined) {
    ctx.err("tool-restart: 別の --apply が実行中");
    return EXIT.failed;
  }
  try {
    return await applyLocked(ctx, observed, only);
  } finally {
    closeSync(lock);
  }
}

function scopedSession(argv: readonly string[]): string | undefined {
  const [mode, flag, session] = argv;
  return argv.length === 3 && mode === "--apply" && flag === "--session" ? session : undefined;
}

function dispatch(argv: readonly string[], ctx: Ctx): Promise<number> | number {
  const session = scopedSession(argv);
  if (session) return runApply(ctx, session);
  switch (argv.join(" ")) {
    case "":
    case "--status":
      return runStatus(ctx, false);
    case "--json":
    case "--status --json":
      return runStatus(ctx, true);
    case "--notify":
      return runNotify(ctx);
    case "--cleanup-check":
      return runCleanupCheck(ctx);
    case "--apply":
      return runApply(ctx);
    default:
      ctx.err(USAGE);
      return EXIT.usage;
  }
}

export async function main(argv: readonly string[], ctx: Ctx): Promise<number> {
  try {
    return await dispatch(argv, ctx);
  } catch (error) {
    ctx.err(`tool-restart: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  }
}

function askTerminal(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    reader.once("close", () => resolve(""));
    reader.question(prompt, (answer) => {
      resolve(answer);
      reader.close();
    });
  });
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    pid: process.pid,
    uid: process.getuid?.() ?? -1,
    isTty: process.stdin.isTTY === true,
    restoreAttempts: 180,
    sleep: Bun.sleep,
    ask: askTerminal,
    out: console.log,
    err: console.error,
  });
  process.exit(code);
}
