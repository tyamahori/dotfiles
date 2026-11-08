// Pure decisions behind scripts/tool-restart: parse native CLI output once, judge which
// processes are stale, and judge whether a local Herdr session may be stopped. The I/O
// lives in tool-restart.ts.
import { basename, join } from "node:path";

export const TOOL_IDS = ["omp", "herdr", "sheprd", "claude", "codex", "grok"] as const;
export type ToolId = (typeof TOOL_IDS)[number];
const AGENT_IDS = ["omp", "claude", "codex", "grok"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const TOOL_LABELS: Record<ToolId, string> = {
  omp: "OMP",
  herdr: "Herdr",
  sheprd: "Sheprd",
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

export type Proc = {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  state: string;
  started: string;
  name: string;
};
export type Exe = { path: string; inode: string };
export type Installed = { path?: string; inode?: string; version?: string };
export type ExeState = "current" | "pending" | "unknown" | "external";
export type Role = "cli" | "server" | "client" | "gui" | "daemon" | "embedded";
export type Backend = "current" | "old" | "unknown" | "absent";
export type AgentRef = { agent: string; kind: string; value: string };
export type Pane = {
  id: string;
  terminalId: string;
  agent?: string;
  status: string;
  cwd?: string;
  foregroundCwd?: string;
  ref?: AgentRef;
  restoreError?: string;
  launchPending: boolean;
  stateSeq: number;
};
export type FgProcess = { pid: number; name: string; argv0?: string; argv?: string[] };
export type PaneProcesses = { shellPid?: number; fgGroup?: number; foreground: FgProcess[] };
export type ServerStatus = { version?: string; stale: boolean; socket?: string };
export type SessionEntry = {
  name: string;
  isDefault: boolean;
  running: boolean;
  socket: string;
  connectionError?: string;
  invalid?: string;
};
export type SessionObservation = {
  entry: SessionEntry;
  status?: ServerStatus;
  panes?: Pane[];
  processes: Map<string, PaneProcesses | undefined>;
  serverPid?: number;
};
export type GuiStatus = { known: boolean; running: boolean; pid?: number; version?: string; remoteHosts: number };
export type World = {
  procs: Map<number, Proc>;
  children: Map<number, Proc[]>;
  exes: Map<number, Exe>;
  installed: Record<ToolId, Installed>;
  home: string;
};
export type Observed = { world: World; sessions: SessionObservation[]; gui: GuiStatus; backend: Backend };
export type OmpInventory = { owned: Map<string, string[]>; infra: Set<number> };
export type McpServer = { command: string; args: string[] };
export type CommandFiles = { resolve(command: string): string | undefined; head(path: string): string | undefined };
export type SavedRef = { ok: true; sessionId: string } | { ok: false; reason: string };
export type AssessEnv = {
  world: World;
  uid: number;
  omp?: OmpInventory;
  backend: Backend;
  grokLeaders?: number;
  restoreOn: boolean;
  recovering: ReadonlySet<string>;
  mcpArgvs(agent: AgentId, cwd: string): ReadonlySet<string>;
  savedRef(agent: AgentId, ref: AgentRef, cwd: string): SavedRef;
  dirExists(path: string): boolean;
  socketOwned(path: string): boolean;
};
export type RunningRow = {
  tool: ToolId;
  pid: number;
  role: Role;
  state: ExeState;
  version?: string;
  path?: string;
  session?: string;
  pane?: string;
};
export type Blocker = { pane?: string; reason: string };
export type RecoveryPane = {
  id: string;
  terminalId: string;
  agent?: string;
  cwd?: string;
  foregroundCwd?: string;
  ref?: AgentRef;
};
export type RecoveryRecord = {
  session: string;
  server: { pid: number; started: string };
  panes: RecoveryPane[];
  failure?: string[];
};
export type SessionPlan = {
  name: string;
  isDefault: boolean;
  running: boolean;
  note?: string;
  reasons: string[];
  blockers: Blocker[];
  helpers: string[];
  paneCount: number;
  fingerprint: string;
  record: RecoveryRecord;
};
export type GuiPlan = {
  state: "absent" | "current" | "pending" | "unknown" | "skipped";
  pid?: number;
  started?: string;
  version?: string;
  installed?: string;
  bundle?: string;
  identity: string;
  blockers: string[];
  remoteHosts: number;
};
export type RecoveryState = "restored" | "not-stopped" | "needs-client" | "corrupt";
export type RecoveryView = {
  session: string;
  state: RecoveryState;
  mismatches: string[];
  file: string;
  record?: RecoveryRecord;
};
export type Plan = {
  rows: RunningRow[];
  installed: Record<ToolId, Installed>;
  sessions: SessionPlan[];
  gui: GuiPlan;
  recovery: RecoveryView[];
};

type Json = Record<string, unknown>;
const NO_PIDS: ReadonlySet<number> = new Set();
const VERSION = /\d+\.\d+(?:\.\d+)*/;
const VERSION_ANYWHERE = /\d+\.\d+(?:\.\d+)*/g;
const VERSION_SEGMENT = /\d+\.\d+[^/]*/g;
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/;
const BREW_PATH = /\/(?:Cellar|Caskroom)\//;
const INACTIVE_DAEMON = /^(?:exited|stopped|dead|failed|crashed)$/i;
const HERDR_PROCESS = /^(?:herdr|sheprd)/;
const DAEMON_DIR = ".codex/packages/app-server-daemon/";
const DAEMON_STATE: Record<Backend, ExeState> = {
  current: "current",
  old: "pending",
  unknown: "unknown",
  absent: "unknown",
};
const CODEX_BACKEND_BLOCKERS: Record<Backend, string[]> = {
  current: [],
  absent: [],
  old: ["Codex 共有デーモンが旧版。作業の区切りで codex app-server daemon update を手動で実行してから再実行する"],
  unknown: ["Codex 共有デーモンの版を確認できない"],
};
// A launcher that does nothing but replace itself with another file, so ps shows that file instead.
const EXEC_SHIM = /^#![^\n]*\n\s*exec "(\/[^"\n]+)" "\$@"\s*$/;
const REF_KIND: Record<AgentId, string> = { omp: "path", claude: "id", codex: "id", grok: "id" };
// Native restore keeps the conversation but not other flags (measured: OMP comes back as
// `omp --allow-home --resume=<path>`), so anything outside these lists is deferred before a stop.
const PLAIN_ARGS: Record<AgentId, readonly string[]> = { omp: ["--allow-home"], claude: [], codex: [], grok: [] };
const RESUME_FLAGS: Record<AgentId, readonly string[]> = {
  omp: ["--resume", "-r"],
  claude: ["--resume", "-r"],
  codex: [],
  grok: ["--resume"],
};
const STATE_LABELS: Record<ExeState, string> = {
  current: "最新",
  pending: "更新待ち",
  unknown: "不明",
  external: "対象外",
};

// Terminal control characters from session data must not reach the operator's terminal.
function inert(text: string): string {
  return text.replace(/\p{C}/gu, "?").slice(0, 120);
}

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const unique = (items: readonly string[]) => [...new Set(items)];

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function extractVersion(text: string): string | undefined {
  return VERSION.exec(text)?.[0];
}

function versionInPath(path: string): string | undefined {
  return [...path.matchAll(VERSION_ANYWHERE)].at(-1)?.[0];
}

function procName(comm: string): string {
  return basename(comm.trim()).replace(/^-/, "");
}

export function parseProcs(text: string): Proc[] {
  return text.split("\n").flatMap((line) => {
    const match = PS_LINE.exec(line);
    if (!match) return [];
    const [, pid, ppid, pgid, uid, state, started, comm] = match;
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        uid: Number(uid),
        state: state ?? "",
        started: (started ?? "").replace(/\s+/g, " "),
        name: procName(comm ?? ""),
      },
    ];
  });
}

// lsof lists the executable as a process's first txt entry, before dyld and dylibs.
export function parseMappedExes(text: string): Map<number, Exe> {
  const exes = new Map<number, Exe>();
  let pid = 0;
  let inode = "";
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = Number(value);
    else if (line.startsWith("i")) inode = value;
    else if (line.startsWith("n") && !exes.has(pid)) exes.set(pid, { path: value, inode });
  }
  return exes;
}

export function parseSocketOwners(text: string): Map<string, number[]> {
  const owners = new Map<string, number[]>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n/")) owners.set(line.slice(1), [...(owners.get(line.slice(1)) ?? []), pid]);
  }
  return owners;
}

// A server may fork children that inherit its listening socket; the owner is the one whose parent is not a holder.
export function socketServer(holders: readonly number[] | undefined, procs: readonly Proc[]): number | undefined {
  const pids = new Set(holders ?? []);
  const roots = procs.filter((proc) => pids.has(proc.pid) && !pids.has(proc.ppid));
  return roots.length === 1 ? roots[0]?.pid : undefined;
}

function invalidSession(name: string, isDefault: boolean, socket: string, root: string): string | undefined {
  if (!SESSION_NAME.test(name)) return "セッション名を扱えない";
  const expected = isDefault ? root : join(root, "sessions", name);
  return socket.startsWith(`${expected}/`) && !socket.includes("/../") ? undefined : "ローカルの既定パスにないソケット";
}

export function parseSessionList(json: unknown, herdrRoot: string): SessionEntry[] {
  return asArray(asObject(json).sessions).map((item) => {
    const session = asObject(item);
    const name = asString(session.name) ?? "";
    const isDefault = session.default === true;
    const socket = asString(session.socket_path) ?? "";
    return {
      name,
      isDefault,
      socket,
      running: session.running === true,
      connectionError: asString(session.connection_error),
      invalid: invalidSession(name, isDefault, socket, herdrRoot),
    };
  });
}

export function parseServerStatus(json: unknown): ServerStatus {
  const root = asObject(json);
  const server = asObject(root.server);
  const update = asObject(root.update);
  const flags = [server.restart_needed, server.server_binary_stale, update.restart_needed, update.server_binary_stale];
  return { version: asString(server.version), socket: asString(server.socket), stale: flags.includes(true) };
}

function parseRef(value: unknown): AgentRef | undefined {
  const ref = asObject(value);
  const [agent, kind, text] = [asString(ref.agent), asString(ref.kind), asString(ref.value)];
  return agent && kind && text ? { agent, kind, value: text } : undefined;
}

function parsePane(pane: Json, agents: Map<string, Json>): Pane {
  const id = asString(pane.pane_id) ?? "";
  const agentInfo = agents.get(id) ?? {};
  return {
    id,
    terminalId: asString(pane.terminal_id) ?? "",
    agent: asString(pane.agent),
    status: asString(pane.agent_status) ?? "unknown",
    cwd: asString(pane.cwd),
    foregroundCwd: asString(pane.foreground_cwd),
    ref: parseRef(pane.agent_session),
    restoreError: asString(pane.restore_error),
    launchPending: agentInfo.launch_pending === true,
    stateSeq: asNumber(agentInfo.state_change_seq) ?? 0,
  };
}

export function parseSnapshot(json: unknown): Pane[] | undefined {
  const snapshot = asObject(asObject(asObject(json).result).snapshot);
  if (!Array.isArray(snapshot.panes)) return undefined;
  const agents = new Map(
    asArray(snapshot.agents).map((item) => {
      const agent = asObject(item);
      return [asString(agent.pane_id) ?? "", agent] as const;
    }),
  );
  return snapshot.panes.map((pane) => parsePane(asObject(pane), agents));
}

// One malformed entry voids the whole list: dropping it would shift the boundaries that identify a process.
function parseArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((arg): arg is string => typeof arg === "string") ? value : undefined;
}

function parseForeground(item: unknown): FgProcess[] {
  const proc = asObject(item);
  const pid = asNumber(proc.pid);
  if (pid === undefined) return [];
  return [{ pid, name: asString(proc.name) ?? "", argv0: asString(proc.argv0), argv: parseArgv(proc.argv) }];
}

export function parseProcessInfo(json: unknown): PaneProcesses | undefined {
  const info = asObject(asObject(asObject(json).result).process_info);
  if (asString(info.pane_id) === undefined) return undefined;
  return {
    shellPid: asNumber(info.shell_pid),
    fgGroup: asNumber(info.foreground_process_group_id),
    foreground: asArray(info.foreground_processes).flatMap(parseForeground),
  };
}

// Keeps only ownership and pids: the inventory also holds service command lines, which may carry secrets.
// Returns false for a running entry whose owner is neither a session nor OMP's explicit null: that
// entry might be this session's work, so the inventory as a whole cannot clear anything.
function addOmpDaemon(inventory: OmpInventory, daemon: Json): boolean {
  if (INACTIVE_DAEMON.test(asString(daemon.state) ?? "")) return true;
  const owner = daemon.owner;
  if (typeof owner === "string" && owner) {
    inventory.owned.set(owner, [...(inventory.owned.get(owner) ?? []), inert(asString(daemon.name) ?? "?")]);
    return true;
  }
  if (owner !== null) return false;
  const pid = asNumber(daemon.pid);
  if (pid !== undefined) inventory.infra.add(pid);
  return true;
}

export function parseOmpInventory(json: unknown): OmpInventory | undefined {
  if (!Array.isArray(json)) return undefined;
  const inventory: OmpInventory = { owned: new Map(), infra: new Set() };
  for (const item of json) {
    const scope = asObject(item);
    const broker = asNumber(scope.brokerPid);
    if (broker !== undefined) inventory.infra.add(broker);
    if (!asArray(scope.daemons).every((daemon) => addOmpDaemon(inventory, asObject(daemon)))) return undefined;
  }
  return inventory;
}

function parseMcpTable(table: unknown): McpServer[] {
  return Object.values(asObject(table)).flatMap((item) => {
    const server = asObject(item);
    const command = asString(server.command);
    const args = server.args ?? [];
    if (!command || server.enabled === false || !Array.isArray(args)) return [];
    return args.every((arg): arg is string => typeof arg === "string") ? [{ command, args }] : [];
  });
}

export function parseMcpServers(config: unknown, key: "mcpServers" | "mcp_servers"): McpServer[] {
  return parseMcpTable(asObject(config)[key]);
}

// Claude keeps user-level servers at the root and local-scope servers under the project's path.
export function parseClaudeMcpServers(config: unknown, cwd: string): McpServer[] {
  const root = asObject(config);
  return [...parseMcpTable(root.mcpServers), ...parseMcpTable(asObject(asObject(root.projects)[cwd]).mcpServers)];
}

function shebang(head: string): string[] {
  const line = /^#![ \t]*([^\n]+)/.exec(head)?.[1];
  if (!line) return [];
  const tokens = line.trim().split(/\s+/);
  return tokens[0] === "/usr/bin/env" ? tokens.slice(1) : tokens;
}

function launchArgv(argv0: string, entry: string, args: readonly string[], head: string): string[] {
  const interpreter = shebang(head);
  return interpreter.length > 0 ? [...interpreter, entry, ...args] : [argv0, ...args];
}

// JSON keeps argument boundaries, so ["a b"] and ["a", "b"] never share a key. Text joined with
// spaces, which is all ps prints, would give both the same one.
function argvKey(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

// The exact argument lists a stdio server configured this way can run with: the kernel puts a
// script's interpreter first, and a shim that only execs another file runs with that file's list.
export function mcpArgvKeys(server: McpServer, files: CommandFiles): string[] {
  const entry = files.resolve(server.command) ?? server.command;
  const head = files.head(entry) ?? "";
  const lists = [launchArgv(server.command, entry, server.args, head)];
  const target = EXEC_SHIM.exec(head)?.[1];
  if (target) lists.push(launchArgv(target, target, server.args, files.head(target) ?? ""));
  return lists.map(argvKey);
}

// Only the daemon's own "notRunning" means absent: a failed query says nothing either way.
export function parseCodexBackend(json: unknown): Backend {
  const daemon = asObject(json);
  if (daemon.status === "notRunning") return "absent";
  const running = extractVersion(asString(daemon.appServerVersion) ?? "");
  const cli = extractVersion(asString(daemon.cliVersion) ?? "");
  if (!running || !cli) return "unknown";
  return running === cli ? "current" : "old";
}

export function parseGrokLeaders(json: unknown): number | undefined {
  return Array.isArray(json) ? json.length : undefined;
}

function countRemoteHosts(status: Json): number {
  const hosts = asArray(status.windows).flatMap((window) => asArray(asObject(window).hosts));
  const ids = hosts.map((host) => asString(asObject(host).id) ?? "");
  return new Set(ids.filter((id) => id !== "local")).size;
}

export function parseGuiStatus(code: number, json: unknown): GuiStatus {
  const notRunning = { known: true, running: false, remoteHosts: 0 };
  if (code === 127 || code === 3) return notRunning;
  const status = asObject(json);
  const pid = asNumber(status.pid);
  if (code !== 0 || pid === undefined) return { known: false, running: false, remoteHosts: 0 };
  return { known: true, running: true, pid, version: asString(status.version), remoteHosts: countRemoteHosts(status) };
}

export function restoreEnabled(config: unknown): boolean {
  return asObject(asObject(config).session).resume_agents_on_restore !== false;
}

function parseRecoveryPane(item: unknown): RecoveryPane {
  const pane = asObject(item);
  return {
    id: asString(pane.id) ?? "",
    terminalId: asString(pane.terminalId) ?? "",
    agent: asString(pane.agent),
    cwd: asString(pane.cwd),
    foregroundCwd: asString(pane.foregroundCwd),
    ref: parseRef(pane.ref),
  };
}

export function parseRecoveryRecord(json: unknown, stem: string): RecoveryRecord | undefined {
  const record = asObject(json);
  const server = asObject(record.server);
  const pid = asNumber(server.pid);
  const started = asString(server.started);
  const valid = record.session === stem && SESSION_NAME.test(stem) && Array.isArray(record.panes);
  if (!valid || pid === undefined || started === undefined) return undefined;
  return { session: stem, server: { pid, started }, panes: asArray(record.panes).map(parseRecoveryPane) };
}

function firstLineWhere(head: string, match: (line: Json) => boolean): Json | undefined {
  for (const line of head.split("\n")) {
    const entry = asObject(parseJson(line));
    if (match(entry)) return entry;
  }
  return undefined;
}

// OMP's first line can be a title record, so the session header is searched for.
export function ompHeaderId(head: string, cwd: string): string | undefined {
  const header = firstLineWhere(head, (line) => line.type === "session");
  return header?.cwd === cwd ? asString(header.id) : undefined;
}

export function claudeHeadMatches(head: string, id: string, cwd: string): boolean {
  const withId = firstLineWhere(head, (line) => typeof line.sessionId === "string");
  const withCwd = firstLineWhere(head, (line) => typeof line.cwd === "string");
  return withId?.sessionId === id && (withCwd === undefined || withCwd.cwd === cwd);
}

export function codexHeadMatches(head: string, id: string, cwd: string): boolean {
  const meta = firstLineWhere(head, (line) => line.type === "session_meta");
  const payload = asObject(meta?.payload);
  return payload.id === id && payload.cwd === cwd;
}

// Restore resumes an ordinary interactive conversation, which writes no session_kind (measured on
// saved sessions; "headless" is the only value seen). Any other kind is deferred, not assumed safe.
export function grokSummaryMatches(text: string, expected: { id: string; cwd: string; grokHome: string }): boolean {
  const summary = asObject(parseJson(text));
  const info = asObject(summary.info);
  const identified = info.id === expected.id && info.cwd === expected.cwd;
  return identified && summary.grok_home === expected.grokHome && summary.session_kind === undefined;
}

export function buildWorld(input: {
  procs: readonly Proc[];
  exes: Map<number, Exe>;
  installed: Record<ToolId, Installed>;
  home: string;
}): World {
  const procs = new Map(input.procs.map((proc) => [proc.pid, proc]));
  const children = new Map<number, Proc[]>();
  for (const proc of input.procs) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
  return { procs, children, exes: input.exes, installed: input.installed, home: input.home };
}

function isAgentId(value: string | undefined): value is AgentId {
  return AGENT_IDS.some((id) => id === value);
}

function shape(path: string): string {
  return path.replace(VERSION_SEGMENT, "V");
}

function classifyExe(exe: Exe | undefined, installed: Installed): ExeState {
  if (!exe || !installed.path) return "unknown";
  if (exe.path === installed.path) return exe.inode === installed.inode ? "current" : "pending";
  return shape(exe.path) === shape(installed.path) ? "pending" : "unknown";
}

function isCodexDaemon(exe: Exe | undefined, home: string): boolean {
  return exe?.path.startsWith(`${home}/${DAEMON_DIR}`) === true;
}

export function hasCodexDaemon(world: World): boolean {
  return [...world.exes.values()].some((exe) => isCodexDaemon(exe, world.home));
}

function baseRole(tool: ToolId, exe: Exe | undefined, home: string): Role {
  if (tool === "sheprd") return "gui";
  if (tool === "herdr") return "client";
  if (tool === "codex" && isCodexDaemon(exe, home)) return "daemon";
  return exe?.path.includes(".app/") ? "embedded" : "cli";
}

function ancestry(pid: number, world: World): Proc[] {
  const chain: Proc[] = [];
  const seen = new Set<number>();
  let current = world.procs.get(pid);
  while (current && !seen.has(current.pid)) {
    chain.push(current);
    seen.add(current.pid);
    current = world.procs.get(current.ppid);
  }
  return chain;
}

function isWithin(pid: number, ancestor: number, world: World): boolean {
  return ancestry(pid, world).some((proc) => proc.pid === ancestor);
}

// Walks parents rather than process groups: background jobs can sit in another group. Breadth
// first, so every process comes after its parent.
function liveDescendants(root: number, world: World): Proc[] {
  const found: Proc[] = [];
  const seen = new Set([root]);
  const queue = [root];
  for (const pid of queue) {
    for (const child of world.children.get(pid) ?? []) {
      if (seen.has(child.pid) || child.state.startsWith("Z")) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function isAgentProcess(agent: AgentId, proc: FgProcess): boolean {
  return [proc.name, proc.argv0, proc.argv?.[0]].some((name) => name !== undefined && procName(name) === agent);
}

function findAgentRoot(agent: AgentId, info: PaneProcesses, world: World): Proc | undefined {
  const matches = info.foreground.filter((proc) => isAgentProcess(agent, proc));
  const pids = new Set(matches.map((proc) => proc.pid));
  const roots = matches.filter((proc) => !pids.has(world.procs.get(proc.pid)?.ppid ?? -1));
  return roots.length === 1 && roots[0] ? world.procs.get(roots[0].pid) : undefined;
}

function withoutCodexResume(agent: AgentId, args: readonly string[], ref: string): readonly string[] {
  return agent === "codex" && args[0] === "resume" && args[1] === ref ? args.slice(2) : args;
}

// How many arguments a supported form uses at this position; 0 means unsupported.
function argsConsumed(agent: AgentId, arg: string, next: string | undefined, ref: string): number {
  if (PLAIN_ARGS[agent].includes(arg) || RESUME_FLAGS[agent].some((flag) => arg === `${flag}=${ref}`)) return 1;
  return RESUME_FLAGS[agent].includes(arg) && next === ref ? 2 : 0;
}

function startupArgsSupported(agent: AgentId, args: readonly string[] | undefined, ref: string): boolean {
  if (!args) return false;
  const rest = withoutCodexResume(agent, args, ref);
  let index = 0;
  while (index < rest.length) {
    const used = argsConsumed(agent, rest[index] ?? "", rest[index + 1], ref);
    if (used === 0) return false;
    index += used;
  }
  return true;
}

type AgentPaneFacts = { pane: Pane; agent: AgentId; info: PaneProcesses; root: Proc };

function statusBlockers(pane: Pane): string[] {
  const blockers: string[] = [];
  if (pane.status !== "idle" && pane.status !== "done") blockers.push(`状態が ${inert(pane.status)}`);
  if (pane.launchPending) blockers.push("起動処理の途中");
  if (pane.restoreError) blockers.push("前回の復元でエラーが出ている");
  return blockers;
}

function identityBlockers(facts: AgentPaneFacts, env: AssessEnv): string[] {
  const { agent, info, root } = facts;
  const state = classifyExe(env.world.exes.get(root.pid), env.world.installed[agent]);
  const blockers: string[] = [];
  if (root.uid !== env.uid) blockers.push("別ユーザーのプロセス");
  if (root.pgid !== info.fgGroup) blockers.push("前景プロセスがエージェントではない");
  if (info.shellPid === undefined || !isWithin(root.pid, info.shellPid, env.world)) {
    blockers.push("ペインのシェル配下にない");
  }
  if (state !== "current" && state !== "pending") blockers.push("実行ファイルを判定できない");
  return blockers;
}

function usableCwd(pane: Pane, env: AssessEnv): string | undefined {
  const cwd = pane.foregroundCwd ?? pane.cwd;
  return cwd && pane.cwd && env.dirExists(cwd) && env.dirExists(pane.cwd) ? cwd : undefined;
}

function usableRef(pane: Pane, agent: AgentId): AgentRef | undefined {
  const ref = pane.ref;
  return ref?.agent === agent && ref.kind === REF_KIND[agent] ? ref : undefined;
}

function savedConversation(facts: AgentPaneFacts, env: AssessEnv): { blockers: string[]; sessionId?: string } {
  const cwd = usableCwd(facts.pane, env);
  if (!cwd) return { blockers: ["cwd が存在しない"] };
  const ref = usableRef(facts.pane, facts.agent);
  if (!ref) return { blockers: ["保存された会話の参照がない"] };
  const argv = facts.info.foreground.find((proc) => proc.pid === facts.root.pid)?.argv;
  if (!startupArgsSupported(facts.agent, argv?.slice(1), ref.value)) {
    return { blockers: ["標準の復元で保持されない起動オプションがある"] };
  }
  const saved = env.savedRef(facts.agent, ref, cwd);
  return saved.ok ? { blockers: [], sessionId: saved.sessionId } : { blockers: [saved.reason] };
}

// Herdr's report is the only argument list trusted here: ps prints arguments joined by spaces, so
// different commands can look alike. Herdr lists only the pane's foreground group, so a process it
// does not list, or lists twice, has no identity to compare and stays unidentified.
function nativeArgv(info: PaneProcesses, pid: number): readonly string[] | undefined {
  const listed = info.foreground.filter((proc) => proc.pid === pid);
  return listed.length === 1 ? listed[0]?.argv : undefined;
}

// A configured stdio MCP server is a process the agent itself started with exactly the configured
// arguments. Inherited stdin and stdout do not extend that to its children: a quiet job inherits
// them just as a wrapper's real binary does. Same-uid processes could fake the arguments; this
// guards against mistakes, not against an attacker.
function configuredServers(facts: AgentPaneFacts, tree: readonly Proc[], env: AssessEnv): Set<number> {
  const configured = env.mcpArgvs(facts.agent, facts.pane.foregroundCwd ?? facts.pane.cwd ?? "");
  const started = tree.filter((proc) => {
    const argv = proc.ppid === facts.root.pid ? nativeArgv(facts.info, proc.pid) : undefined;
    return argv !== undefined && configured.has(argvKey(argv));
  });
  return new Set(started.map((proc) => proc.pid));
}

// A process group proves nothing about what a process is doing, so every descendant needs its own
// positive identification: a configured MCP server, or OMP's own listing as infrastructure. That
// exempts the identified process only; its children are judged on their own. Anything else is
// possibly the user's work and defers the session, which ordinary wrappers' children also do.
function workload(facts: AgentPaneFacts, env: AssessEnv): { blockers: string[]; helpers: string[] } {
  const { info, root } = facts;
  const infra = env.omp?.infra ?? NO_PIDS;
  const tree = liveDescendants(info.shellPid ?? root.pid, env.world).filter((proc) => proc.pid !== root.pid);
  const servers = configuredServers(facts, tree, env);
  const identified = (proc: Proc) => infra.has(proc.pid) || servers.has(proc.pid);
  const outsiders = info.foreground.filter(
    (proc) => proc.pid !== root.pid && !isWithin(proc.pid, root.pid, env.world) && !infra.has(proc.pid),
  );
  return {
    blockers: [
      ...tree
        .filter((proc) => !identified(proc))
        .map((proc) => `子プロセス ${inert(proc.name)} (pid ${proc.pid}) の用途を判定できない`),
      ...outsiders.map((proc) => `エージェント外の前景コマンド ${inert(proc.name)} がある`),
    ],
    helpers: tree.filter(identified).map((proc) => inert(proc.name)),
  };
}

function ompWorkBlockers(sessionId: string | undefined, omp: OmpInventory | undefined): string[] {
  if (!omp) return ["OMP のジョブ一覧を取得できない"];
  const owned = sessionId ? omp.owned.get(sessionId) : undefined;
  return owned?.length ? [`このセッションが所有する OMP サービス ${owned.join(", ")} が稼働中`] : [];
}

function grokLeaderBlockers(leaders: number | undefined): string[] {
  if (leaders === undefined) return ["Grok leader の一覧を取得できない"];
  return leaders > 0 ? [`Grok leader が ${leaders} 件稼働中で、用途を判定できない`] : [];
}

function sharedWorkBlockers(agent: AgentId, sessionId: string | undefined, env: AssessEnv): string[] {
  if (agent === "omp") return ompWorkBlockers(sessionId, env.omp);
  if (agent === "codex") return CODEX_BACKEND_BLOCKERS[env.backend];
  if (agent === "grok") return grokLeaderBlockers(env.grokLeaders);
  return [];
}

function assessAgentPane(pane: Pane, agent: AgentId, info: PaneProcesses, env: AssessEnv) {
  const root = findAgentRoot(agent, info, env.world);
  if (!root) return { blockers: ["エージェントのプロセスを特定できない"], helpers: [] };
  const facts = { pane, agent, info, root };
  const saved = savedConversation(facts, env);
  const load = workload(facts, env);
  return {
    blockers: [
      ...statusBlockers(pane),
      ...identityBlockers(facts, env),
      ...saved.blockers,
      ...load.blockers,
      ...sharedWorkBlockers(agent, saved.sessionId, env),
    ],
    helpers: load.helpers,
  };
}

function shellPaneBlockers(pane: Pane, info: PaneProcesses, env: AssessEnv): string[] {
  const shell = info.shellPid === undefined ? undefined : env.world.procs.get(info.shellPid);
  if (!shell || shell.uid !== env.uid) return ["シェルのプロセスを特定できない"];
  const blockers = liveDescendants(shell.pid, env.world).map((proc) => `実行中のジョブ ${inert(proc.name)} がある`);
  const foreground = info.foreground.some((proc) => proc.pid !== shell.pid);
  if (foreground || info.fgGroup !== shell.pgid) blockers.push("前景でコマンドが動いている");
  if (!pane.cwd || !env.dirExists(pane.cwd)) blockers.push("cwd が存在しない");
  return blockers;
}

function assessPane(pane: Pane, info: PaneProcesses | undefined, env: AssessEnv) {
  const helpers: string[] = [];
  if (!info) return { blockers: ["プロセス情報を取得できない"], helpers };
  if (!pane.agent) return { blockers: shellPaneBlockers(pane, info, env), helpers };
  if (!isAgentId(pane.agent)) return { blockers: [`未対応のエージェント ${inert(pane.agent)}`], helpers };
  return assessAgentPane(pane, pane.agent, info, env);
}

function serverProc(session: SessionObservation, world: World): Proc | undefined {
  return session.serverPid === undefined ? undefined : world.procs.get(session.serverPid);
}

function serverBlockers(session: SessionObservation, env: AssessEnv): string[] {
  const server = serverProc(session, env.world);
  if (!server) return ["サーバーのプロセスを特定できない"];
  const state = classifyExe(env.world.exes.get(server.pid), env.world.installed.herdr);
  const blockers: string[] = [];
  if (server.uid !== env.uid) blockers.push("サーバーが別ユーザーのもの");
  if (state !== "current" && state !== "pending") blockers.push("Herdr サーバーの実行ファイルを判定できない");
  return blockers;
}

function sessionBlockers(session: SessionObservation, env: AssessEnv): string[] {
  const blockers = serverBlockers(session, env);
  if (!env.socketOwned(session.entry.socket)) blockers.push("ソケットの所有者を確認できない");
  if (!session.panes) blockers.push("ペイン一覧を取得できない");
  if (!env.restoreOn) blockers.push("標準復元 (session.resume_agents_on_restore) が無効");
  if (env.recovering.has(session.entry.name)) blockers.push("前回の再起動が復旧待ち");
  return blockers;
}

function assessSession(session: SessionObservation, env: AssessEnv) {
  const panes = (session.panes ?? []).map((pane) => ({
    pane: inert(pane.id),
    result: assessPane(pane, session.processes.get(pane.id), env),
  }));
  return {
    blockers: [
      ...sessionBlockers(session, env).map((reason): Blocker => ({ reason })),
      ...panes.flatMap(({ pane, result }) => result.blockers.map((reason): Blocker => ({ pane, reason }))),
    ],
    helpers: unique(panes.flatMap(({ result }) => result.helpers)),
  };
}

function upgradeLabel(tool: ToolId, from: string | undefined, world: World): string {
  return `${TOOL_LABELS[tool]} ${from ?? "?"}→${world.installed[tool].version ?? "?"}`;
}

function agentReasons(session: SessionObservation, world: World): string[] {
  return (session.panes ?? []).flatMap((pane) => {
    const agent = pane.agent;
    if (!isAgentId(agent)) return [];
    const agents = session.processes.get(pane.id)?.foreground.filter((proc) => isAgentProcess(agent, proc)) ?? [];
    return agents.flatMap((proc) => {
      const exe = world.exes.get(proc.pid);
      if (classifyExe(exe, world.installed[agent]) !== "pending") return [];
      return [upgradeLabel(agent, exe && versionInPath(exe.path), world)];
    });
  });
}

function affectedReasons(session: SessionObservation, world: World): string[] {
  const exe = session.serverPid === undefined ? undefined : world.exes.get(session.serverPid);
  const serverPending = classifyExe(exe, world.installed.herdr) === "pending" || session.status?.stale === true;
  const server = serverPending
    ? [upgradeLabel("herdr", session.status?.version ?? (exe && versionInPath(exe.path)), world)]
    : [];
  return unique([...server, ...agentReasons(session, world)]);
}

function affectedSessions(observed: Observed): SessionObservation[] {
  return observed.sessions.filter((session) => affectedReasons(session, observed.world).length > 0);
}

export function agentsInAffectedSessions(observed: Observed): Set<string> {
  const panes = affectedSessions(observed).flatMap((session) => session.panes ?? []);
  return new Set(panes.flatMap((pane) => pane.agent ?? []));
}

function procIdentity(pid: number | undefined, world: World): unknown[] {
  if (pid === undefined) return [];
  const proc = world.procs.get(pid);
  const exe = world.exes.get(pid);
  return [pid, proc?.started, proc?.uid, exe?.path, exe?.inode];
}

function paneFingerprint(pane: Pane, info: PaneProcesses | undefined, world: World): unknown[] {
  const shell = info?.shellPid;
  const tree = shell === undefined ? [] : liveDescendants(shell, world);
  const identities = tree.sort((a, b) => a.pid - b.pid).map((proc) => procIdentity(proc.pid, world));
  return [
    pane.id,
    pane.terminalId,
    pane.agent,
    pane.status,
    pane.stateSeq,
    pane.cwd,
    pane.foregroundCwd,
    pane.ref,
    procIdentity(shell, world),
    info?.fgGroup,
    identities,
  ];
}

function installedIdentity(tool: ToolId, world: World): unknown[] {
  const { path, inode, version } = world.installed[tool];
  return [tool, path, inode, version];
}

// Covers what the operator approved: the processes and panes, and also which update it was for.
function fingerprintOf(session: SessionObservation, world: World): string {
  const panes = (session.panes ?? []).map((pane) => paneFingerprint(pane, session.processes.get(pane.id), world));
  const agents = (session.panes ?? []).flatMap((pane) => (isAgentId(pane.agent) ? [pane.agent] : []));
  const tools: ToolId[] = ["herdr", ...new Set(agents)];
  return JSON.stringify({
    socket: session.entry.socket,
    server: procIdentity(session.serverPid, world),
    panes,
    installed: tools.sort().map((tool) => installedIdentity(tool, world)),
    reasons: affectedReasons(session, world),
  });
}

// False when the process table moved between two reads of the same native session state.
export function sameProcessView(session: SessionObservation, before: World, after: World): boolean {
  return fingerprintOf(session, before) === fingerprintOf(session, after);
}

// Approval covers what the operator saw, and only while it is still work the safety checks passed.
export function approvalHolds(approved: SessionPlan, fresh: SessionPlan | undefined): fresh is SessionPlan {
  if (!fresh || fresh.reasons.length === 0 || fresh.blockers.length > 0) return false;
  return fresh.fingerprint === approved.fingerprint;
}

export function guiApprovalHolds(approved: GuiPlan, fresh: GuiPlan): boolean {
  return fresh.state === "pending" && fresh.blockers.length === 0 && fresh.identity === approved.identity;
}

function toRecoveryRecord(session: SessionObservation, world: World): RecoveryRecord {
  const server = serverProc(session, world);
  return {
    session: session.entry.name,
    server: { pid: server?.pid ?? 0, started: server?.started ?? "" },
    panes: (session.panes ?? []).map((pane) => ({
      id: pane.id,
      terminalId: pane.terminalId,
      agent: pane.agent,
      cwd: pane.cwd,
      foregroundCwd: pane.foregroundCwd,
      ref: pane.ref,
    })),
  };
}

export function planSession(session: SessionObservation, observed: Observed, env: AssessEnv): SessionPlan {
  const reasons = affectedReasons(session, observed.world);
  const assessed = reasons.length > 0 ? assessSession(session, env) : { blockers: [], helpers: [] };
  return {
    name: inert(session.entry.name),
    isDefault: session.entry.isDefault,
    running: session.entry.running,
    note: session.entry.invalid ?? (session.entry.connectionError && "接続を確認できない"),
    reasons,
    blockers: assessed.blockers,
    helpers: assessed.helpers,
    paneCount: session.panes?.length ?? 0,
    fingerprint: fingerprintOf(session, observed.world),
    record: toRecoveryRecord(session, observed.world),
  };
}

function trustedBundle(path: string | undefined, home: string): string | undefined {
  const bundle = /^(.+\/Herdr\.app)\/Contents\/MacOS\/sheprd$/.exec(path ?? "")?.[1];
  return bundle === "/Applications/Herdr.app" || bundle === `${home}/Applications/Herdr.app` ? bundle : undefined;
}

function guiState(observed: Observed): GuiPlan["state"] {
  const { gui, world } = observed;
  if (!gui.known) return "unknown";
  if (!gui.running || gui.pid === undefined) return "absent";
  const state = classifyExe(world.exes.get(gui.pid), world.installed.sheprd);
  if (state === "pending" || gui.version !== world.installed.sheprd.version) return "pending";
  return state === "current" ? "current" : "unknown";
}

export function planGui(observed: Observed): GuiPlan {
  const { gui, world } = observed;
  const bundle = trustedBundle(world.installed.sheprd.path, world.home);
  const state = guiState(observed);
  const started = gui.pid === undefined ? undefined : world.procs.get(gui.pid)?.started;
  return {
    state,
    pid: gui.pid,
    started,
    version: gui.version,
    installed: world.installed.sheprd.version,
    bundle,
    identity: JSON.stringify([gui.pid, started, gui.version, gui.remoteHosts, installedIdentity("sheprd", world)]),
    blockers: state === "pending" && !bundle ? ["Sheprd の導入先が想定の場所にない"] : [],
    remoteHosts: gui.remoteHosts,
  };
}

function placeAgents(observed: Observed): Map<number, { agent: AgentId; session: string; pane: string }> {
  const placed = new Map<number, { agent: AgentId; session: string; pane: string }>();
  for (const session of observed.sessions) {
    for (const pane of session.panes ?? []) {
      if (!isAgentId(pane.agent)) continue;
      const info = session.processes.get(pane.id);
      const root = info && findAgentRoot(pane.agent, info, observed.world);
      if (root) placed.set(root.pid, { agent: pane.agent, session: session.entry.name, pane: pane.id });
    }
  }
  return placed;
}

type RowInput = { tool: ToolId; role: Role; exe?: Exe; server?: SessionObservation };

function rowState(input: RowInput, observed: Observed): ExeState {
  const { tool, role, exe, server } = input;
  if (role === "embedded") return "external";
  if (role === "daemon") return DAEMON_STATE[observed.backend];
  const state = classifyExe(exe, observed.world.installed[tool]);
  if (state !== "current") return state;
  const guiStale = role === "gui" && observed.gui.version !== observed.world.installed.sheprd.version;
  return guiStale || server?.status?.stale === true ? "pending" : "current";
}

function rowVersion(input: RowInput, observed: Observed): string | undefined {
  if (input.server?.status?.version) return input.server.status.version;
  if (input.role === "gui" && observed.gui.version) return observed.gui.version;
  return input.exe && versionInPath(input.exe.path);
}

type FoundProcess = {
  proc: Proc;
  tool: ToolId;
  placement?: { session: string; pane: string };
  server?: SessionObservation;
};

function toRow(found: FoundProcess, observed: Observed): RunningRow {
  const { proc, tool, placement, server } = found;
  const exe = observed.world.exes.get(proc.pid);
  const input: RowInput = { tool, exe, server, role: server ? "server" : baseRole(tool, exe, observed.world.home) };
  return {
    tool,
    pid: proc.pid,
    role: input.role,
    state: rowState(input, observed),
    version: rowVersion(input, observed),
    path: exe && inert(exe.path),
    session: placement?.session ?? server?.entry.name,
    pane: placement?.pane,
  };
}

export function runningRows(observed: Observed): RunningRow[] {
  const placed = placeAgents(observed);
  const servers = new Map(observed.sessions.map((session) => [session.serverPid, session]));
  return [...observed.world.procs.values()].flatMap((proc) => {
    const placement = placed.get(proc.pid);
    const tool = placement?.agent ?? TOOL_IDS.find((id) => id === proc.name);
    return tool ? [toRow({ proc, tool, placement, server: servers.get(proc.pid) }, observed)] : [];
  });
}

// A process mapped from outside Homebrew is not affected by cleanup and cannot be fixed by a
// restart, so it stays visible in --status without demanding attention.
export function attentionRows(rows: readonly RunningRow[]): RunningRow[] {
  return rows.filter(
    (row) => row.state === "pending" || (row.state === "unknown" && (!row.path || BREW_PATH.test(row.path))),
  );
}

export function cleanupBlockers(rows: readonly RunningRow[]): RunningRow[] {
  return attentionRows(rows).filter((row) => row.role !== "daemon");
}

// Names the installed target too: 1→2 and 1→3 are different news with the same process running.
export function notificationKey(
  rows: readonly RunningRow[],
  recovering: readonly string[],
  installed: Record<ToolId, Installed>,
): string[] {
  const items = rows.map((row) => {
    const { version, path, inode } = installed[row.tool];
    return `${row.tool}:${row.role}:${row.state}:${row.version ?? row.path ?? "?"}:${version}:${path}:${inode}`;
  });
  return unique([...items, ...recovering.map((session) => `recovery:${session}`)]).sort();
}

export function notificationMessage(
  rows: readonly RunningRow[],
  recovering: readonly string[],
  installed: Record<ToolId, Installed>,
): string {
  const items = unique(
    rows.map((row) =>
      row.state === "pending"
        ? `${TOOL_LABELS[row.tool]} ${row.version ?? "?"}→${installed[row.tool].version ?? "?"}`
        : `${TOOL_LABELS[row.tool]} 判定不能`,
    ),
  );
  const recovery = recovering.length > 0 ? [`復旧待ち ${recovering.length} 件`] : [];
  return `${[...items, ...recovery].join(", ")}。tool-restart --apply で確認する`;
}

function sameRef(a: AgentRef | undefined, b: AgentRef | undefined): boolean {
  return a?.agent === b?.agent && a?.kind === b?.kind && a?.value === b?.value;
}

function agentExeMismatch(current: Pane, session: SessionObservation, world: World): string[] {
  const info = session.processes.get(current.id);
  const agent = current.agent;
  if (!info || !isAgentId(agent)) return ["エージェントのプロセスを特定できない"];
  const root = findAgentRoot(agent, info, world);
  if (!root) return ["エージェントのプロセスを特定できない"];
  return classifyExe(world.exes.get(root.pid), world.installed[agent]) === "current"
    ? []
    : ["実行ファイルが最新でない"];
}

function agentMismatches(
  expected: RecoveryPane,
  current: Pane,
  scope: { session: SessionObservation; world: World },
): string[] {
  if (!current.agent) return ["エージェントが戻らず通常のシェルになっている"];
  const problems: string[] = [];
  if (current.agent !== expected.agent) problems.push("別のエージェントが動いている");
  if (!sameRef(current.ref, expected.ref)) problems.push("会話の参照が一致しない");
  if (current.foregroundCwd !== expected.foregroundCwd) problems.push("エージェントの cwd が一致しない");
  if (current.terminalId === expected.terminalId) problems.push("端末が入れ替わっていない");
  if (current.restoreError) problems.push("復元エラーが報告された");
  if (current.status === "unknown") problems.push("状態を確認できない");
  return [...problems, ...agentExeMismatch(current, scope.session, scope.world)];
}

function paneMismatches(
  expected: RecoveryPane,
  current: Pane | undefined,
  scope: { session: SessionObservation; world: World },
): string[] {
  const label = inert(expected.id);
  if (!current) return [`${label}: ペインが戻っていない`];
  const cwd = current.cwd === expected.cwd ? [] : ["cwd が一致しない"];
  const occupant = expected.agent
    ? agentMismatches(expected, current, scope)
    : current.agent
      ? ["シェルだった場所でエージェントが動いている"]
      : [];
  return [...cwd, ...occupant].map((problem) => `${label}: ${problem}`);
}

function serverMismatches(record: RecoveryRecord, session: SessionObservation, world: World): string[] {
  const server = serverProc(session, world);
  if (!server) return ["サーバーのプロセスを特定できない"];
  const problems: string[] = [];
  if (server.pid === record.server.pid && server.started === record.server.started) {
    problems.push("サーバーが入れ替わっていない");
  }
  if (classifyExe(world.exes.get(server.pid), world.installed.herdr) !== "current" || session.status?.stale) {
    problems.push("Herdr サーバーが最新でない");
  }
  return problems;
}

export function restoreMismatches(
  record: RecoveryRecord,
  session: SessionObservation | undefined,
  world: World,
): string[] {
  if (!session?.entry.running || !session.panes) return ["サーバーまたはペインが戻っていない"];
  const panes = new Map(session.panes.map((pane) => [pane.id, pane]));
  const known = new Set(record.panes.map((pane) => pane.id));
  const extra = session.panes
    .filter((pane) => !known.has(pane.id))
    .map((pane) => `${inert(pane.id)}: 記録にないペインがある`);
  return [
    ...serverMismatches(record, session, world),
    ...record.panes.flatMap((pane) => paneMismatches(pane, panes.get(pane.id), { session, world })),
    ...extra,
  ];
}

// Crash between recording intent and the stop: the same server still running means nothing happened.
export function judgeRecovery(
  record: RecoveryRecord,
  session: SessionObservation | undefined,
  world: World,
): { state: RecoveryState; mismatches: string[] } {
  const server = session && serverProc(session, world);
  if (session?.entry.running && server?.pid === record.server.pid && server.started === record.server.started) {
    return { state: "not-stopped", mismatches: [] };
  }
  const mismatches = restoreMismatches(record, session, world);
  return { state: mismatches.length > 0 ? "needs-client" : "restored", mismatches };
}

// Outside only when the chain reaches init: one cut short by a missing parent or a cycle could
// be hiding a Herdr above the part that is visible.
export function herdrContainment(pid: number, observed: Observed): "inside" | "outside" | "unknown" {
  const chain = ancestry(pid, observed.world);
  const shells = new Set(
    observed.sessions.flatMap((session) => [...session.processes.values()].flatMap((info) => info?.shellPid ?? [])),
  );
  if (chain.some((proc) => HERDR_PROCESS.test(proc.name) || shells.has(proc.pid))) return "inside";
  const top = chain.at(-1);
  return top && top.ppid <= 1 ? "outside" : "unknown";
}

export function readySessions(plan: Plan): SessionPlan[] {
  return plan.sessions.filter((session) => session.reasons.length > 0 && session.blockers.length === 0);
}

export function guiActionable(plan: Plan): boolean {
  return plan.gui.state === "pending" && plan.gui.blockers.length === 0;
}

export function recoveriesToRun(plan: Plan): RecoveryView[] {
  return plan.recovery.filter((task) => task.state === "needs-client");
}

export function hasWork(plan: Plan): boolean {
  return readySessions(plan).length > 0 || guiActionable(plan) || recoveriesToRun(plan).length > 0;
}

// One session only: everything else, the GUI included, is neither acted on nor counted as left over.
export function scopePlan(plan: Plan, only: string): Plan {
  return {
    ...plan,
    rows: plan.rows.filter((row) => row.session === only),
    sessions: plan.sessions.filter((session) => session.name === only),
    gui: { ...plan.gui, state: "skipped", blockers: [] },
    recovery: plan.recovery.filter((task) => task.session === only),
  };
}

export function remaining(plan: Plan): boolean {
  const open = plan.sessions.some((session) => session.reasons.length > 0) || plan.recovery.length > 0;
  return open || plan.gui.state === "pending" || attentionRows(plan.rows).length > 0;
}

function toolLine(tool: ToolId, plan: Plan): string {
  const groups = new Map<string, number>();
  for (const row of plan.rows.filter((candidate) => candidate.tool === tool)) {
    const key = `${row.role} ${row.version ?? "?"} ${STATE_LABELS[row.state]}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const running = [...groups].map(([key, count]) => `${key} ×${count}`).join(", ") || "なし";
  return `  ${TOOL_LABELS[tool]}: 導入済み ${plan.installed[tool].version ?? "未導入"} / 実行中 ${running}`;
}

function sessionLines(session: SessionPlan): string[] {
  const heading = session.reasons.length === 0 ? "影響なし" : session.blockers.length > 0 ? "保留" : "再起動対象";
  const reasons = session.reasons.length > 0 ? `（${session.reasons.join(", ")}）` : "";
  const panes = session.paneCount > 0 ? ` ペイン ${session.paneCount} 件` : "";
  const note = session.note ? ` [${session.note}]` : "";
  const helpers = session.helpers.length > 0 ? [`    同時に止まる補助プロセス: ${session.helpers.join(", ")}`] : [];
  const blockers = session.blockers.map((blocker) =>
    blocker.pane ? `    ${blocker.pane}: ${blocker.reason}` : `    ${blocker.reason}`,
  );
  return [`  ${session.name}: ${heading}${reasons}${panes}${note}`, ...helpers, ...blockers];
}

function guiLines(gui: GuiPlan): string[] {
  const remote = gui.remoteHosts > 0 ? `。リモート host ${gui.remoteHosts} 件は止めず再接続だけ` : "";
  if (gui.state === "pending") {
    const action = gui.blockers.length > 0 ? `保留: ${gui.blockers.join(", ")}` : "GUI だけ再起動する";
    return [`  Sheprd ${gui.version ?? "?"}→${gui.installed ?? "?"}: ${action}${remote}`];
  }
  const labels = { absent: "起動していない", current: "最新", unknown: "状態を確認できない", skipped: "今回は対象外" };
  return [`  Sheprd: ${labels[gui.state]}`];
}

function recoveryLines(view: RecoveryView): string[] {
  return [
    `  ${inert(view.session)}: ${view.state}（記録: ${inert(view.file)}）`,
    ...view.mismatches.map((problem) => `    ${problem}`),
    ...(view.state === "corrupt" ? ["    内容を確かめてからこの記録を削除すると、再び対象になる"] : []),
  ];
}

function manualLines(plan: Plan): string[] {
  const rows = attentionRows(plan.rows).filter((row) => !row.session && row.role !== "gui");
  const lines = rows.map(
    (row) =>
      `  ${TOOL_LABELS[row.tool]} ${row.role} ${row.version ?? "?"} (pid ${row.pid}): ${STATE_LABELS[row.state]}`,
  );
  return lines.length > 0 ? ["Herdr 外のプロセス（自動では止めない）", ...lines] : [];
}

export function renderPlan(plan: Plan): string {
  return [
    "ツール",
    ...TOOL_IDS.map((tool) => toolLine(tool, plan)),
    "ローカル Herdr セッション",
    ...(plan.sessions.length > 0 ? plan.sessions.flatMap(sessionLines) : ["  なし"]),
    "GUI",
    ...guiLines(plan.gui),
    ...(plan.recovery.length > 0 ? ["復旧待ち", ...plan.recovery.flatMap(recoveryLines)] : []),
    ...manualLines(plan),
  ].join("\n");
}

// The JSON view carries no conversation references, argv, or fingerprints.
export function planJson(plan: Plan) {
  return {
    tools: TOOL_IDS.map((id) => {
      const running = plan.rows.filter((row) => row.tool === id);
      return {
        id,
        label: TOOL_LABELS[id],
        installed: { version: plan.installed[id].version, path: plan.installed[id].path },
        running,
        pending: running.filter((row) => row.state === "pending").length,
        unknown: running.filter((row) => row.state === "unknown").length,
      };
    }),
    sessions: plan.sessions.map((session) => ({
      name: session.name,
      default: session.isDefault,
      running: session.running,
      note: session.note,
      affected: session.reasons.length > 0,
      ready: session.reasons.length > 0 && session.blockers.length === 0,
      reasons: session.reasons,
      blockers: session.blockers,
      helpers: session.helpers,
      panes: session.paneCount,
    })),
    gui: {
      state: plan.gui.state,
      version: plan.gui.version,
      installed: plan.gui.installed,
      blockers: plan.gui.blockers,
      remoteHosts: plan.gui.remoteHosts,
    },
    recovery: plan.recovery.map(({ session, state, mismatches, file }) => ({ session, state, mismatches, file })),
  };
}
