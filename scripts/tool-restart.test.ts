import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Ctx, main } from "./tool-restart.ts";
import {
  buildWorld,
  extractVersion,
  type Installed,
  notificationKey,
  parseMappedExes,
  parseProcs,
  type RunningRow,
  runningRows,
  type ToolId,
} from "./tool-restart-core.ts";

// Every native CLI is a stub on PATH, driven by fixture files, so the production code spawns
// real subprocesses without any real session in reach: HOME and PATH never leave this tree.
const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-restart-")));
const fifoWriters: Bun.Subprocess[] = [];
afterAll(() => {
  for (const writer of fifoWriters) writer.kill();
  rmSync(root, { recursive: true, force: true });
});

const UID = process.getuid?.() ?? 0;
const STARTED = "Sun Nov  8 10:00:00 2026";
// Built at runtime: the repository's pre-commit guard rejects literal UUIDs.
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const OMP_ID = uuid("a");
const CLAUDE_ID = uuid("b");
const CODEX_ID = uuid("c");
const GROK_ID = uuid("d");

type FakeProc = {
  pid: number;
  ppid: number;
  pgid?: number;
  uid?: number;
  state?: string;
  started?: string;
  name: string;
  exe?: string;
  inode?: string;
  noInode?: boolean;
  command?: string;
  channel?: string;
};
type FakePane = {
  id: string;
  terminalId: string;
  agent?: string;
  status?: string;
  cwd: string;
  foregroundCwd?: string;
  ref?: { agent: string; kind: string; value: string };
  shellPid?: number;
  fgGroup?: number;
  foreground?: { pid: number; name: string; argv?: (string | number)[] }[];
  restoreError?: string;
  launchPending?: boolean;
  stateSeq?: number;
};
type FakeSession = {
  name: string;
  isDefault?: boolean;
  running?: boolean;
  socket?: string;
  serverPid?: number;
  stale?: boolean;
  panes: FakePane[];
};
type FakeWorld = {
  procs: FakeProc[];
  sessions: FakeSession[];
  gui?: { pid: number; version: string; hosts?: string[] };
  omp?: unknown;
  grokLeaders?: unknown;
  codexDaemon?: unknown;
};

function writeText(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function writeStub(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n[ -f "$STUB/hook.sh" ] && . "$STUB/hook.sh" "$(basename "$0") $*"\n${body}\n`);
  chmodSync(path, 0o755);
}

// An executable file nothing here ever runs. The default content has no shebang, so it reads as a
// compiled program rather than as a script with an interpreter.
function writeProgram(path: string, content = "\u007fELF\n") {
  writeText(path, content);
  chmodSync(path, 0o755);
}

const HERDR_STUB = `echo "herdr $*" >>"$STUB/calls.log"
[ -n "\${HERDR_PANE_ID:-}" ] && echo "leaked" >>"$STUB/calls.log"
c="$STUB/current"
d="$c/$(basename "$(dirname "\${HERDR_SOCKET_PATH:-/none/none}")")"
case "$*" in
--version) echo "herdr 2.0.0" ;;
"session list --json") cat "$c/sessions.json" ;;
"status --json") cat "$d/status.json" ;;
"api snapshot") cat "$d/snapshot.json" ;;
"pane process-info --pane "*) cat "$d/pi_\${4//[^A-Za-z0-9]/_}.json" ;;
"session stop "*)
  [ -e "$STUB/stop-fails" ] && exit 1
  cp -R "$STUB/after-stop/." "$c/"
  ;;
"session attach "* | "")
  trap 'kill "$p" 2>/dev/null; echo "client closed" >>"$STUB/calls.log"; exit 0' TERM
  cp -R "$STUB/after-attach/." "$c/"
  sleep 30 &
  p=$!
  wait "$p"
  ;;
*) exit 64 ;;
esac`;

const TOOL_STUBS: Record<string, string> = {
  omp: `echo "omp $*" >>"$STUB/calls.log"
case "$*" in
--version) echo 2.0.0 ;;
"ps list --all --json") cat "$STUB/current/omp-ps.json" ;;
*) exit 64 ;;
esac`,
  claude: `echo "claude $*" >>"$STUB/calls.log"
[ "$*" = --version ] && echo "2.0.0 (Claude Code)"`,
  codex: `echo "codex $*" >>"$STUB/calls.log"
case "$*" in
--version) echo "codex-cli 2.0.0" ;;
"app-server daemon version")
  [ -e "$STUB/codex-fails" ] && exit 1
  cat "$STUB/current/codex-daemon.json"
  ;;
*) exit 64 ;;
esac`,
  grok: `echo "grok $*" >>"$STUB/calls.log"
case "$*" in
--version) echo "grok 2.0.0 (abc) [stable]" ;;
"leader list --json") cat "$STUB/current/grok-leaders.json" ;;
*) exit 64 ;;
esac`,
  sheprd: `echo "sheprd $*" >>"$STUB/calls.log"
c="$STUB/current"
case "$*" in
"status --json")
  cat "$c/sheprd-status.json"
  exit "$(cat "$c/sheprd-status.code")"
  ;;
"app quit --json")
  code=$(cat "$STUB/quit-code" 2>/dev/null || echo 0)
  [ "$code" = 0 ] && cp -R "$STUB/after-quit/." "$c/"
  exit "$code"
  ;;
*) exit 64 ;;
esac`,
};

function setup(attempts = 20) {
  const home = mkdtempSync(join(root, "h"));
  const stub = join(home, "stub");
  const bin = join(stub, "bin");
  const work = join(home, "work");
  mkdirSync(bin, { recursive: true });
  mkdirSync(work);
  mkdirSync(join(stub, "current"));

  const bundle = join(home, "Applications/Herdr.app");
  const exe = (tool: string, version = "2.0.0") =>
    ({
      omp: `${home}/opt/Cellar/omp/${version}/bin/omp`,
      herdr: `${home}/opt/Cellar/herdr/${version}/bin/herdr`,
      claude: `${home}/opt/Caskroom/claude-code@latest/${version}/claude`,
      codex: `${home}/opt/Caskroom/codex/${version}/bin/codex`,
      grok: `${home}/.grok/downloads/grok-${version}-macos`,
      sheprd: `${bundle}/Contents/MacOS/sheprd`,
    })[tool] ?? "";

  writeStub(exe("herdr"), HERDR_STUB);
  symlinkSync(exe("herdr"), join(bin, "herdr"));
  for (const [tool, body] of Object.entries(TOOL_STUBS)) {
    writeStub(exe(tool), body);
    symlinkSync(exe(tool), join(bin, tool));
  }
  writeStub(
    join(bin, "ps"),
    `case "$*" in
*command=*)
  cat "$STUB/current/ps-commands.txt"
  exit 0
  ;;
esac
[ -e "$STUB/ps-fails" ] && exit 1
cat "$STUB/current/ps.txt"
parent=$(cat "$STUB/self-ppid" 2>/dev/null || echo 1)
echo "$PPID $parent $PPID $(id -u) S ${STARTED} bun"`,
  );
  writeStub(
    join(bin, "lsof"),
    `case "$*" in
*-U*) cat "$STUB/current/lsof-sockets" ;;
*"-d 0,1"*) cat "$STUB/current/lsof-stdio" ;;
*) cat "$STUB/current/lsof-txt" ;;
esac`,
  );
  writeStub(join(bin, "plutil"), 'cat "$STUB/sheprd-version" 2>/dev/null || echo 2.0.0');
  writeText(
    join(stub, "hook.sh"),
    `if [ "$(cat "$STUB/hook-call" 2>/dev/null)" = "$1" ]; then
  rm -f "$STUB/hook-call"
  if [ -f "$STUB/hook-action" ]; then . "$STUB/hook-action"; else cp -R "$STUB/after-hook/." "$STUB/current/"; fi
fi`,
  );
  writeStub(join(bin, "terminal-notifier"), 'printf "terminal-notifier %s\\n" "$*" >>"$STUB/calls.log"');
  writeStub(join(bin, "open"), 'echo "open $*" >>"$STUB/calls.log"\ncp -R "$STUB/after-open/." "$STUB/current/"');

  // before() runs this server under its OMP agent, mapping the node that PATH finds here.
  writeProgram(join(bin, "node"));
  writeProgram(join(bin, "mcp-tool"));
  writeText(join(home, ".omp/agent/mcp.json"), { mcpServers: { web: { command: "node", args: ["server.js"] } } });
  const ompSession = join(home, ".omp/agent/sessions/work/s.jsonl");
  const claudeTranscript = join(home, ".claude/projects", work.replace(/[^A-Za-z0-9]/g, "-"), `${CLAUDE_ID}.jsonl`);
  writeText(
    ompSession,
    `${JSON.stringify({ type: "title", title: "private title" })}\n${JSON.stringify({ type: "session", id: OMP_ID, cwd: work })}\n`,
  );
  writeText(
    claudeTranscript,
    `${JSON.stringify({ type: "mode", sessionId: CLAUDE_ID, cwd: null })}\n${JSON.stringify({ type: "user", sessionId: CLAUDE_ID, cwd: work })}\n`,
  );
  writeText(
    join(home, `.codex/sessions/2026/11/08/rollout-2026-11-08T10-00-00-${CODEX_ID}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: work } })}\n`,
  );
  const grokDir = join(home, ".grok/sessions", encodeURIComponent(work), GROK_ID);
  writeText(join(grokDir, "chat_history.jsonl"), "{}\n");
  writeText(join(grokDir, "summary.json"), {
    info: { id: GROK_ID, cwd: work },
    grok_home: join(home, ".grok"),
    session_summary: "private summary",
  });

  const socketOf = (session: FakeSession) =>
    session.socket ??
    (session.isDefault
      ? `${home}/.config/herdr/herdr.sock`
      : `${home}/.config/herdr/sessions/${session.name}/herdr.sock`);

  const renderSession = (session: FakeSession, dir: string) => {
    const socket = socketOf(session);
    if (socket.startsWith(home)) writeText(socket, "");
    const key = join(dir, session.isDefault ? "herdr" : session.name);
    writeText(join(key, "status.json"), {
      client: { version: "2.0.0" },
      server: {
        running: true,
        status: "running",
        version: session.stale ? "1.0.0" : "2.0.0",
        socket,
        restart_needed: session.stale === true,
        server_binary_stale: session.stale === true,
      },
      update: { restart_needed: false, server_binary_stale: false },
    });
    const panes = session.panes.map((pane) => ({
      pane_id: pane.id,
      terminal_id: pane.terminalId,
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: false,
      revision: 1,
      agent: pane.agent ?? null,
      agent_status: pane.status ?? (pane.agent ? "idle" : "unknown"),
      agent_session: pane.ref ? { source: `herdr:${pane.ref.agent}`, ...pane.ref } : null,
      cwd: pane.cwd,
      foreground_cwd: pane.foregroundCwd ?? (pane.agent ? pane.cwd : null),
      restore_error: pane.restoreError ?? null,
    }));
    const agents = session.panes.map((pane) => ({
      pane_id: pane.id,
      terminal_id: pane.terminalId,
      agent_status: pane.status ?? "idle",
      launch_pending: pane.launchPending === true,
      state_change_seq: pane.stateSeq ?? 1,
    }));
    writeText(join(key, "snapshot.json"), {
      id: "1",
      result: { type: "session_snapshot", snapshot: { panes, agents, layouts: [], tabs: [], workspaces: [] } },
    });
    for (const pane of session.panes) {
      writeText(join(key, `pi_${pane.id.replace(/[^A-Za-z0-9]/g, "_")}.json`), {
        id: "1",
        result: {
          type: "pane_process_info",
          process_info: {
            pane_id: pane.id,
            shell_pid: pane.shellPid ?? null,
            foreground_process_group_id: pane.fgGroup ?? null,
            tty: "/dev/ttys001",
            foreground_processes: (pane.foreground ?? []).map((proc) => ({
              ...proc,
              argv0: proc.argv?.[0] ?? null,
              cmdline: proc.argv?.join(" ") ?? null,
              cwd: pane.cwd,
            })),
          },
        },
      });
    }
  };

  const inodeOf = (proc: FakeProc) => {
    if (proc.inode) return proc.inode;
    return proc.exe && existsSync(proc.exe) ? String(statSync(proc.exe).ino) : "1";
  };

  const render = (world: FakeWorld, dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeText(
      join(dir, "ps.txt"),
      world.procs
        .map(
          (proc) =>
            `${proc.pid} ${proc.ppid} ${proc.pgid ?? proc.pid} ${proc.uid ?? UID} ${proc.state ?? "S"} ${proc.started ?? STARTED} ${proc.name}\n`,
        )
        .join(""),
    );
    writeText(
      join(dir, "lsof-txt"),
      world.procs
        .filter((proc) => proc.exe)
        .map((proc) => {
          const inode = proc.noInode ? "" : `i${inodeOf(proc)}\n`;
          return `p${proc.pid}\nftxt\n${inode}n${proc.exe}\nftxt\ni7\nn/usr/lib/dyld\n`;
        })
        .join(""),
    );
    writeText(
      join(dir, "ps-commands.txt"),
      world.procs
        .filter((proc) => proc.command)
        .map((proc) => `${proc.pid} ${proc.command}\n`)
        .join(""),
    );
    writeText(
      join(dir, "lsof-stdio"),
      world.procs
        .filter((proc) => proc.channel)
        .map((proc) => `p${proc.pid}\nf0\ntunix\nd${proc.channel}-in\nf1\ntunix\nd${proc.channel}-out\n`)
        .join(""),
    );
    writeText(
      join(dir, "lsof-sockets"),
      world.sessions
        .filter((session) => session.serverPid !== undefined)
        .map((session) => `p${session.serverPid}\nf3\nn${socketOf(session)}\nf4\nn->0x1234\n`)
        .join(""),
    );
    writeText(join(dir, "sessions.json"), {
      sessions: world.sessions.map((session) => ({
        default: session.isDefault === true,
        name: session.name,
        running: session.running !== false,
        session_dir: dirname(socketOf(session)),
        socket_path: socketOf(session),
      })),
    });
    for (const session of world.sessions) renderSession(session, dir);
    writeText(
      join(dir, "sheprd-status.json"),
      world.gui
        ? {
            version: world.gui.version,
            protocol: 11,
            pid: world.gui.pid,
            windows: [{ id: "window", hosts: (world.gui.hosts ?? ["local"]).map((id) => ({ id })) }],
          }
        : { error: { code: "not_running" } },
    );
    writeText(join(dir, "sheprd-status.code"), world.gui ? "0" : "3");
    writeText(join(dir, "omp-ps.json"), world.omp ?? []);
    writeText(join(dir, "grok-leaders.json"), world.grokLeaders ?? []);
    writeText(join(dir, "codex-daemon.json"), world.codexDaemon ?? "");
  };

  const calls = () => {
    const log = join(stub, "calls.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  };
  const recoveryFile = (session: string) => join(home, ".local/state/tool-restart/recovery", `${session}.json`);

  const run = async (
    args: string[],
    options: { answer?: string; tty?: boolean; env?: Record<string, string>; beforeAnswer?: () => unknown } = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    let asked = 0;
    const ctx: Ctx = {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, STUB: stub, ...options.env },
      pid: process.pid,
      uid: UID,
      isTty: options.tty ?? true,
      restoreAttempts: attempts,
      sleep: () => Bun.sleep(5),
      ask: async () => {
        asked++;
        await options.beforeAnswer?.();
        return options.answer ?? "yes";
      },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    };
    const code = await main(args, ctx);
    return { code, out: out.join("\n"), err: err.join("\n"), asked };
  };

  return {
    home,
    stub,
    bin,
    work,
    bundle,
    ompSession,
    claudeTranscript,
    exe,
    calls,
    recoveryFile,
    run,
    stops: () => calls().filter((call) => call.startsWith("herdr session stop")),
    attaches: () => calls().filter((call) => call === "herdr " || call.startsWith("herdr session attach")),
    world: (world: FakeWorld) => render(world, join(stub, "current")),
    afterStop: (world: FakeWorld) => render(world, join(stub, "after-stop")),
    afterAttach: (world: FakeWorld) => render(world, join(stub, "after-attach")),
    afterQuit: (world: FakeWorld) => render(world, join(stub, "after-quit")),
    afterOpen: (world: FakeWorld) => render(world, join(stub, "after-open")),
    // The world changes while the named native command runs, for the first such call from now on.
    mutateOn: (call: string, world: FakeWorld) => {
      render(world, join(stub, "after-hook"));
      writeText(join(stub, "hook-call"), call);
    },
    // A shell command runs while the named native command runs, for changes outside the fixture world.
    runOn: (call: string, command: string) => {
      writeText(join(stub, "hook-action"), command);
      writeText(join(stub, "hook-call"), call);
    },
    // The world changes while the code reads this absent file, a moment no native command marks. The
    // writer's open of the pipe returns only once a reader has opened it, and the reader sees the end
    // of the file only after the change. The file is absent again afterwards. The moment of the read
    // goes in the call log.
    mutateDuringRead: (path: string, world: FakeWorld) => {
      const changed = join(stub, "after-hook");
      render(world, changed);
      mkdirSync(dirname(path), { recursive: true });
      Bun.spawnSync(["mkfifo", path]);
      const script = 'exec 3>"$0"; echo "opened $0" >>"$3"; cp -R "$1/." "$2/"; rm -f "$0"';
      const argv = ["/bin/bash", "-c", script, path, changed, join(stub, "current"), join(stub, "calls.log")];
      fifoWriters.push(Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }));
    },
    installVersion: (tool: string, version: string) =>
      writeStub(exe(tool, version), (TOOL_STUBS[tool] ?? "").replace("2.0.0", version)),
    useInstalled: (tool: string, version: string) => {
      rmSync(join(bin, tool));
      symlinkSync(exe(tool, version), join(bin, tool));
    },
    status: async () => {
      const result = await run(["--status", "--json"]);
      return JSON.parse(result.out);
    },
  };
}
type Box = ReturnType<typeof setup>;

const pane = (world: FakeWorld, id: string, session = 0) => {
  const found = world.sessions[session]?.panes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no pane ${id}`);
  return found;
};
const proc = (world: FakeWorld, pid: number) => {
  const found = world.procs.find((candidate) => candidate.pid === pid);
  if (!found) throw new Error(`no proc ${pid}`);
  return found;
};
const nodeExe = (box: Box) => join(box.bin, "node");
const toolExe = (box: Box) => join(box.bin, "mcp-tool");

// default session: an OMP on an old keg, a current Claude, and an empty shell.
function before(box: Box): FakeWorld {
  return {
    procs: [
      { pid: 100, ppid: 1, name: "herdr", exe: box.exe("herdr") },
      { pid: 200, ppid: 100, name: "zsh" },
      { pid: 201, ppid: 200, name: "omp", exe: box.exe("omp", "1.0.0") },
      { pid: 202, ppid: 201, pgid: 201, name: "node", exe: nodeExe(box) },
      { pid: 210, ppid: 100, name: "zsh" },
      { pid: 211, ppid: 210, name: "claude", exe: box.exe("claude") },
      { pid: 220, ppid: 100, name: "zsh" },
    ],
    sessions: [
      {
        name: "default",
        isDefault: true,
        serverPid: 100,
        panes: [
          {
            id: "w1:p1",
            terminalId: "t1",
            agent: "omp",
            cwd: box.work,
            ref: { agent: "omp", kind: "path", value: box.ompSession },
            shellPid: 200,
            fgGroup: 201,
            foreground: [
              { pid: 201, name: "omp", argv: ["omp", "--allow-home"] },
              { pid: 202, name: "node", argv: ["node", "server.js"] },
            ],
          },
          {
            id: "w1:p2",
            terminalId: "t2",
            agent: "claude",
            cwd: box.work,
            ref: { agent: "claude", kind: "id", value: CLAUDE_ID },
            shellPid: 210,
            fgGroup: 211,
            foreground: [{ pid: 211, name: "claude", argv: ["claude"] }],
          },
          {
            id: "w1:p3",
            terminalId: "t3",
            cwd: box.work,
            shellPid: 220,
            fgGroup: 220,
            foreground: [{ pid: 220, name: "zsh" }],
          },
        ],
      },
    ],
  };
}

const stopped = (): FakeWorld => ({
  procs: [],
  sessions: [{ name: "default", isDefault: true, running: false, panes: [] }],
});

// The same panes and conversations on a new server, new terminals, and current executables.
function restored(box: Box): FakeWorld {
  return {
    procs: [
      { pid: 300, ppid: 1, name: "herdr", exe: box.exe("herdr") },
      { pid: 400, ppid: 300, name: "zsh" },
      { pid: 401, ppid: 400, name: "omp", exe: box.exe("omp") },
      { pid: 410, ppid: 300, name: "zsh" },
      { pid: 411, ppid: 410, name: "claude", exe: box.exe("claude") },
      { pid: 420, ppid: 300, name: "zsh" },
    ],
    sessions: [
      {
        name: "default",
        isDefault: true,
        serverPid: 300,
        panes: [
          {
            id: "w1:p1",
            terminalId: "t11",
            agent: "omp",
            cwd: box.work,
            ref: { agent: "omp", kind: "path", value: box.ompSession },
            shellPid: 400,
            fgGroup: 401,
            foreground: [{ pid: 401, name: "omp", argv: ["omp", "--allow-home", `--resume=${box.ompSession}`] }],
          },
          {
            id: "w1:p2",
            terminalId: "t12",
            agent: "claude",
            cwd: box.work,
            ref: { agent: "claude", kind: "id", value: CLAUDE_ID },
            shellPid: 410,
            fgGroup: 411,
            foreground: [{ pid: 411, name: "claude", argv: ["claude", "--resume", CLAUDE_ID] }],
          },
          {
            id: "w1:p3",
            terminalId: "t13",
            cwd: box.work,
            shellPid: 420,
            fgGroup: 420,
            foreground: [{ pid: 420, name: "zsh" }],
          },
        ],
      },
    ],
  };
}

// restored() brought back once more: every process and terminal is new again.
function relaunched(box: Box): FakeWorld {
  const world = restored(box);
  for (const candidate of world.procs) {
    candidate.pid += 1000;
    if (candidate.ppid !== 1) candidate.ppid += 1000;
  }
  for (const session of world.sessions) {
    session.serverPid = 1300;
    for (const candidate of session.panes) {
      candidate.terminalId = `${candidate.terminalId}x`;
      candidate.shellPid = (candidate.shellPid ?? 0) + 1000;
      candidate.fgGroup = (candidate.fgGroup ?? 0) + 1000;
      candidate.foreground = candidate.foreground?.map((entry) => ({ ...entry, pid: entry.pid + 1000 }));
    }
  }
  return world;
}

function restartable(attempts?: number): Box {
  const box = setup(attempts);
  box.world(before(box));
  box.afterStop(stopped());
  box.afterAttach(restored(box));
  return box;
}

function useCodex(world: FakeWorld, box: Box, argv = ["codex"]) {
  Object.assign(pane(world, "w1:p2"), {
    agent: "codex",
    ref: { agent: "codex", kind: "id", value: CODEX_ID },
    foreground: [{ pid: 211, name: "codex", argv }],
  });
  Object.assign(proc(world, 211), { name: "codex", exe: box.exe("codex") });
  world.codexDaemon = { status: "notRunning" };
}

function useGrok(world: FakeWorld, box: Box, argv = ["grok"]) {
  Object.assign(pane(world, "w1:p2"), {
    agent: "grok",
    ref: { agent: "grok", kind: "id", value: GROK_ID },
    foreground: [{ pid: 211, name: "grok", argv }],
  });
  Object.assign(proc(world, 211), { name: "grok", exe: box.exe("grok") });
}

const daemonExe = (box: Box, version: string) =>
  `${box.home}/.codex/packages/app-server-daemon/releases/${version}-aarch64/bin/codex`;

test("first run reports old, current, unmapped, and bundled executables separately, without session secrets", async () => {
  const box = setup();
  const world = before(box);
  world.procs.push(
    { pid: 500, ppid: 1, name: "grok" },
    { pid: 501, ppid: 1, name: "codex", exe: "/Applications/ChatGPT.app/Contents/Resources/codex" },
    { pid: 502, ppid: 1, name: "codex", exe: daemonExe(box, "1.0.0") },
  );
  world.codexDaemon = { cliVersion: "2.0.0", appServerVersion: "1.0.0" };
  box.world(world);

  const result = await box.run(["--status", "--json"]);
  const status = JSON.parse(result.out);
  const tool = (id: string) => status.tools.find((candidate: { id: string }) => candidate.id === id);

  expect(result.code).toBe(0);
  expect(tool("omp").running.map((row: { state: string }) => row.state)).toEqual(["pending"]);
  expect(tool("omp").running[0].version).toBe("1.0.0");
  expect(tool("omp").installed.version).toBe("2.0.0");
  expect(tool("claude").running.map((row: { state: string }) => row.state)).toEqual(["current"]);
  expect(tool("grok").running.map((row: { state: string }) => row.state)).toEqual(["unknown"]);
  expect(tool("codex").running.map((row: { role: string; state: string }) => [row.role, row.state])).toEqual([
    ["embedded", "external"],
    ["daemon", "pending"],
  ]);
  for (const secret of [CLAUDE_ID, box.ompSession, "--allow-home", "private title"]) {
    expect(result.out).not.toContain(secret);
  }
});

test("a binary replaced in place at the same path counts as pending", async () => {
  const box = setup();
  const world = restored(box);
  proc(world, 411).inode = "999";
  box.world(world);

  const status = await box.status();
  const claude = status.tools.find((tool: { id: string }) => tool.id === "claude");

  expect(claude.running[0].state).toBe("pending");
});

test("an unreadable process table is a failure, not an all-clear", async () => {
  const box = setup();
  box.world(before(box));
  writeText(join(box.stub, "ps-fails"), "");

  const result = await box.run(["--status"]);

  expect(result.code).toBe(1);
  expect(result.out).toBe("");
});

test("a process line gives every column, one space inside the start time, and the command's own spaces", () => {
  const line = " 123\t45  67 501 Ss+ Sun Nov  8 10:00:00 2026   /opt/My App/bin/my tool  \n";

  expect(parseProcs(line)).toEqual([
    { pid: 123, ppid: 45, pgid: 67, uid: 501, state: "Ss+", started: "Sun Nov 8 10:00:00 2026", name: "my tool" },
  ]);
});

const PS_HEAD = "1 1 1 0 S Sun Nov  8 10:00:00 2026";

test.each([
  ["columns separated by non-ASCII whitespace", "　1 1 1 0 S Sun Nov 8 10:00:00 2026 omp", "omp"],
  ["a command of nothing but spaces, since it is still a process", `${PS_HEAD}  `, ""],
])("a process line is kept with %s", (_name, line, name) => {
  expect(parseProcs(line).map((found) => found.name)).toEqual([name]);
});

test.each([
  ["only one space after the start time", `${PS_HEAD} `],
  ["nothing after the start time", PS_HEAD],
  ["a carriage return inside the command", `${PS_HEAD} omp\r`],
  ["a blank command ending in a carriage return", `${PS_HEAD}  \r`],
  ["a pid that is not all digits", "1a 1 1 0 S Sun Nov 8 10:00:00 2026 omp"],
  ["a weekday that is not three characters", "1 1 1 0 S Sunday Nov 8 10:00:00 2026 omp"],
  ["a day that is not all digits", "1 1 1 0 S Sun Nov 8th 10:00:00 2026 omp"],
  ["a time with other characters", "1 1 1 0 S Sun Nov 8 10-00-00 2026 omp"],
  ["a year of five digits", "1 1 1 0 S Sun Nov 8 10:00:00 20261 omp"],
])("a process line is dropped with %s", (_name, line) => {
  expect(parseProcs(line)).toEqual([]);
});

test.each([
  ["codex-cli 2.0.0", "2.0.0"],
  ["v18.1", "18.1"],
  ["1.2.3.4-beta", "1.2.3.4"],
  ["build 123456 then 7.8", "7.8"],
  ["1..2.3", "2.3"],
  ["1. 2.3", "2.3"],
  ["only 12 here", undefined],
  ["123456", undefined],
  ["", undefined],
])("the version in %j is %j", (text, version) => {
  expect(extractVersion(text)).toBe(version);
});

const onlyOmpInstalled = (omp: Installed): Record<ToolId, Installed> => ({
  omp,
  herdr: {},
  sheprd: {},
  claude: {},
  codex: {},
  grok: {},
});

const KEG = "/opt/Cellar/omp/2.0.0/bin/omp";
const DOWNLOAD = "/home/.grok/downloads/grok-2.0.0-macos";

const statesRunning = (running: string, installedPath: string) =>
  runningRows({
    world: buildWorld({
      procs: [{ pid: 1, ppid: 0, pgid: 1, uid: 0, state: "S", started: "", name: "omp" }],
      exes: new Map([[1, { path: running, inode: "1" }]]),
      installed: onlyOmpInstalled({ path: installedPath, inode: "2", version: "2.0.0" }),
      home: "/home",
    }),
    sessions: [],
    gui: { known: true, running: false, remoteHosts: 0 },
    backend: "absent",
  }).map((row) => [row.state, row.version]);

test.each([
  ["a two-part version on another keg", KEG, "/opt/Cellar/omp/1.9/bin/omp", "1.9"],
  ["a keg with a revision suffix", KEG, "/opt/Cellar/omp/18.18.1_1/bin/omp", "18.18.1"],
  ["a version at the end of a file name", DOWNLOAD, "/home/.grok/downloads/grok-1.5.0-macos", "1.5.0"],
  ["a segment holding two versions", "/opt/omp-2.0.0/omp", "/opt/omp-1.0-3.4/omp", "3.4"],
])("a process running from %s waits for its update", (_name, installedPath, running, version) => {
  expect(statesRunning(running, installedPath)).toEqual([["pending", version]]);
});

test.each([
  ["a v before the version", KEG, "/opt/Cellar/omp/v1.0.0/bin/omp", "1.0.0"],
  ["a number with no dot", KEG, "/opt/Cellar/omp/100/bin/omp", undefined],
  ["a number with no dot before the version", "/opt/omp-2.0.0/omp", "/opt/omp-12345-1.0/omp", "1.0"],
  ["another directory below the version", KEG, "/opt/Cellar/omp/1.0.0/libexec/omp", "1.0.0"],
])("a process running from %s stays unidentified", (_name, installedPath, running, version) => {
  expect(statesRunning(running, installedPath)).toEqual([["unknown", version]]);
});

test("the notification key ignores row order and repeats, even for paths a locale treats as the same", () => {
  const installed = onlyOmpInstalled({ path: "/p", inode: "2", version: "2.0.0" });
  const row = (path: string): RunningRow => ({ tool: "omp", pid: 1, role: "cli", state: "unknown", path });
  const composed = row("/café");
  const decomposed = row("/café");
  const key = ["omp:cli:unknown:/café:2.0.0:/p:2", "omp:cli:unknown:/café:2.0.0:/p:2", "recovery:session"];

  expect(notificationKey([composed, decomposed], ["session"], installed)).toEqual(key);
  expect(notificationKey([decomposed, composed, decomposed], ["session"], installed)).toEqual(key);
});

test("the plain report lists every tool and session", async () => {
  const box = setup();
  box.world(before(box));

  const result = await box.run([]);

  expect(result.code).toBe(0);
  for (const heading of ["OMP", "Herdr", "Sheprd", "Claude Code", "Codex", "Grok", "default"]) {
    expect(result.out).toContain(heading);
  }
});

test("--notify alerts once per stale state on the first run and stops nothing", async () => {
  const box = setup();
  box.world(before(box));
  const notes = () => box.calls().filter((call) => call.startsWith("terminal-notifier"));

  expect((await box.run(["--notify"])).code).toBe(0);
  expect((await box.run(["--notify"])).code).toBe(0);

  expect(notes()).toHaveLength(1);
  expect(notes()[0]).not.toContain(box.home);
  expect(notes()[0]).not.toContain(CLAUDE_ID);
  expect(box.stops()).toEqual([]);
  expect(box.attaches()).toEqual([]);

  // A different stale version is new information.
  const world = before(box);
  proc(world, 201).exe = box.exe("omp", "1.5.0");
  box.world(world);
  await box.run(["--notify"]);
  expect(notes()).toHaveLength(2);

  // Clearing resets the dedup, so the same version going stale again is reported.
  box.world(restored(box));
  await box.run(["--notify"]);
  box.world(world);
  await box.run(["--notify"]);
  expect(notes()).toHaveLength(3);
});

test("--notify stays silent when everything is current", async () => {
  const box = setup();
  box.world(restored(box));

  expect((await box.run(["--notify"])).code).toBe(0);
  expect(box.calls().filter((call) => call.startsWith("terminal-notifier"))).toEqual([]);
});

test("--notify retries a notification that could not be sent", async () => {
  const box = setup();
  box.world(before(box));
  rmSync(join(box.bin, "terminal-notifier"));

  expect((await box.run(["--notify"])).code).toBe(1);

  writeStub(join(box.bin, "terminal-notifier"), 'printf "terminal-notifier %s\\n" "$*" >>"$STUB/calls.log"');
  expect((await box.run(["--notify"])).code).toBe(0);
  expect(box.calls().filter((call) => call.startsWith("terminal-notifier"))).toHaveLength(1);
});

test.each([
  [
    "pending on a Homebrew keg",
    (world: FakeWorld, box: Box) => void (proc(world, 411).exe = box.exe("claude", "1.0.0")),
    1,
  ],
  ["an unmapped executable", (world: FakeWorld) => void delete proc(world, 411).exe, 1],
  ["an executable mapped from a foreign path", (world: FakeWorld) => void (proc(world, 411).exe = "/tmp/claude"), 0],
  [
    "a bundled copy in another app",
    (world: FakeWorld) =>
      void world.procs.push({ pid: 501, ppid: 1, name: "codex", exe: "/Applications/ChatGPT.app/codex" }),
    0,
  ],
  [
    "an old Codex daemon outside Homebrew",
    (world: FakeWorld, box: Box) => {
      world.procs.push({ pid: 502, ppid: 1, name: "codex", exe: daemonExe(box, "1.0.0") });
      world.codexDaemon = { cliVersion: "2.0.0", appServerVersion: "1.0.0" };
    },
    0,
  ],
  ["nothing stale", () => undefined, 0],
] as const)("--cleanup-check with %s", async (_name, mutate, code) => {
  const box = setup();
  const world = restored(box);
  mutate(world, box);
  box.world(world);

  expect((await box.run(["--cleanup-check"])).code).toBe(code);
});

test("an accepted restart stops the whole session once, attaches a client, and verifies the same conversations", async () => {
  const box = restartable();
  const other: FakeSession = {
    name: "other",
    serverPid: 150,
    panes: [
      {
        id: "w9:p1",
        terminalId: "t9",
        cwd: box.work,
        shellPid: 151,
        fgGroup: 151,
        foreground: [{ pid: 151, name: "zsh" }],
      },
    ],
  };
  const addOther = (world: FakeWorld) => {
    world.procs.push({ pid: 150, ppid: 1, name: "herdr", exe: box.exe("herdr") }, { pid: 151, ppid: 150, name: "zsh" });
    world.sessions.push(other);
    return world;
  };
  box.world(addOther(before(box)));
  box.afterStop(addOther(stopped()));
  box.afterAttach(addOther(restored(box)));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(0);
  expect(result.asked).toBe(1);
  // Only the session with a stale agent; the current Claude and the shell go with it.
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
  expect(box.attaches()).toEqual(["herdr "]);
  const log = box.calls();
  expect(log.indexOf("herdr session stop default --json")).toBeLessThan(log.indexOf("herdr "));
  expect(log).toContain("client closed");
  for (const forbidden of ["send-keys", "agent start", "agent.start", "server stop", "update --handoff", "--restore"]) {
    expect(log.filter((call) => call.includes(forbidden))).toEqual([]);
  }
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
}, 30_000);

test("a named session is attached by name", async () => {
  const box = setup();
  const rename = (world: FakeWorld) => {
    for (const session of world.sessions) {
      session.name = "smoke";
      session.isDefault = false;
    }
    return world;
  };
  box.world(rename(before(box)));
  box.afterStop(rename(stopped()));
  box.afterAttach(rename(restored(box)));

  expect((await box.run(["--apply"])).code).toBe(0);

  expect(box.stops()).toEqual(["herdr session stop smoke --json"]);
  expect(box.attaches()).toEqual(["herdr session attach smoke"]);
}, 30_000);

test("a stale Herdr server alone restarts its session even when every agent is current", async () => {
  const box = setup();
  const world = restored(box);
  proc(world, 300).exe = box.exe("herdr", "1.0.0");
  box.world(world);
  box.afterStop(stopped());
  box.afterAttach(relaunched(box));

  expect((await box.run(["--apply"])).code).toBe(0);
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
});

test("a server reporting restart_needed restarts its session", async () => {
  const box = restartable();
  const world = restored(box);
  for (const session of world.sessions) session.stale = true;
  box.world(world);
  const status = await box.status();

  expect(status.sessions[0].affected).toBe(true);
});

test("declining changes nothing", async () => {
  const box = restartable();

  const result = await box.run(["--apply"], { answer: "no" });

  expect(result.code).toBe(3);
  expect(result.asked).toBe(1);
  expect(box.stops()).toEqual([]);
  expect(box.attaches()).toEqual([]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
});

test("--apply without a terminal is refused even when yes is available", async () => {
  const box = restartable();

  const result = await box.run(["--apply"], { tty: false });

  expect(result.code).toBe(1);
  expect(result.asked).toBe(0);
  expect(box.stops()).toEqual([]);
});

test.each(["--apply --yes", "--yes", "--force", "--apply --status", "--apply --session"])(
  "%s is not an accepted form",
  async (args) => {
    const box = restartable();

    const result = await box.run(args.split(" "));

    expect(result.code).toBe(2);
    expect(box.stops()).toEqual([]);
  },
);

test.each([
  ["a herdr ancestor", 100],
  ["a pane shell whose own parent is hidden", 200],
  ["a Sheprd ancestor", 600],
])("--apply under %s is refused with the remedy, whatever HERDR_ENV says", async (_name, parent) => {
  const box = restartable();
  const world = before(box);
  world.procs.push({ pid: 600, ppid: 1, name: "sheprd", exe: box.exe("sheprd") });
  proc(world, 200).ppid = 1;
  box.world(world);
  writeText(join(box.stub, "self-ppid"), String(parent));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(1);
  expect(result.asked).toBe(0);
  expect(result.err).toContain("tool-restart --apply");
  expect(box.stops()).toEqual([]);
});

test("a target that changed after approval voids it", async () => {
  const box = restartable();
  const changed = before(box);
  pane(changed, "w1:p2").terminalId = "t2-new";

  const result = await box.run(["--apply"], { beforeAnswer: () => box.world(changed) });

  expect(result.code).toBe(3);
  expect(result.asked).toBe(1);
  expect(box.stops()).toEqual([]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
});

test("an agent that started working after approval voids it", async () => {
  const box = restartable();
  const changed = before(box);
  pane(changed, "w1:p2").status = "working";

  const result = await box.run(["--apply"], { beforeAnswer: () => box.world(changed) });

  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
});

// A bare command, so it resolves on PATH to the program setup() puts there.
const TOOL_SERVER = { type: "stdio", command: "mcp-tool", args: ["mcp", "--flag"], env: { TOKEN: "env-secret" } };
const TOOL_ARGV = ["mcp-tool", "mcp", "--flag"];
const TOOL_LINE = TOOL_ARGV.join(" ");
const TOOL_TOML = '[mcp_servers.tool]\ncommand = "mcp-tool"\nargs = ["mcp", "--flag"]\n';
// Where the kernel really found bash, which is also where lsof reports it.
const BASH = realpathSync("/bin/bash");

const claudeMcp = (box: Box, servers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  writeText(join(box.home, ".claude.json"), { mcpServers: servers, ...extra });
const configureTool = (box: Box) => claudeMcp(box, { tool: TOOL_SERVER });
const toolChild = (box: Box): FakeProc => ({ pid: 212, ppid: 211, pgid: 211, name: "tool", exe: toolExe(box) });

// A process Herdr lists in the pane's foreground, with the exact argument list it reports.
function inForeground(world: FakeWorld, paneId: string, child: FakeProc, argv: (string | number)[]) {
  world.procs.push(child);
  pane(world, paneId).foreground?.push({ pid: child.pid, name: child.name, argv });
}

// A real program outside PATH, for a child that shares a command's name and arguments but not its file.
function programElsewhere(box: Box, name: string) {
  const path = join(box.home, "elsewhere", name);
  writeProgram(path);
  return path;
}

// A script configured as the server, whose shebang names this interpreter.
function configuredScript(box: Box, interpreter: string) {
  const script = join(box.home, "mcp/server.js");
  writeProgram(script, `#!/usr/bin/env ${interpreter}\n`);
  claudeMcp(box, { server: { command: script, args: [] } });
  return script;
}

// A launcher that only execs a script. Returns the script, and the argument list it then runs with.
function execLauncher(box: Box) {
  const script = join(box.home, "mcp/run.sh");
  const launcher = join(box.home, "mcp/launcher");
  writeProgram(script, "#!/bin/bash\nperl -e 'system @ARGV' binary \"$@\"\n");
  writeProgram(launcher, `#!/bin/bash\nexec "${script}" "$@"\n`);
  claudeMcp(box, { server: { command: launcher, args: ["mcp"] } });
  return ["/bin/bash", script, "mcp"];
}

// A launcher that only execs this file, so the server then runs as that file.
function execLauncherOf(box: Box, target: string) {
  const launcher = join(box.home, "mcp/launcher");
  writeProgram(launcher, `#!/bin/bash\nexec "${target}" "$@"\n`);
  claudeMcp(box, { server: { command: launcher, args: ["mcp"] } });
}

// bash -> perl -> binary, the shape of a real configured wrapper. All three share the group and the
// stdio, and ps shows each plainly: if either ever counted again, this would look safe.
function wrappedServer(world: FakeWorld, box: Box) {
  const shared = { pgid: 211, channel: "chan" };
  const argv = execLauncher(box);
  const perl = ["perl", "-e", "system @ARGV", "binary", "mcp"];
  const binary = ["binary", "mcp"];
  inForeground(
    world,
    "w1:p2",
    { ...shared, pid: 212, ppid: 211, name: "bash", command: argv.join(" "), exe: BASH },
    argv,
  );
  inForeground(world, "w1:p2", { ...shared, pid: 213, ppid: 212, name: "perl", command: perl.join(" ") }, perl);
  inForeground(world, "w1:p2", { ...shared, pid: 214, ppid: 213, name: "binary", command: binary.join(" ") }, binary);
}

// ps prints both of these as `node /work/mcp server.js`; only the argument lists tell them apart.
const SPLIT_ARGS = ["/work/mcp", "server.js"];
const SPACED_ARGS = ["/work/mcp server.js"];
const NODE_LINE = "node /work/mcp server.js";
const serverChild = (box: Box): FakeProc => ({
  pid: 212,
  ppid: 211,
  pgid: 211,
  name: "node",
  command: NODE_LINE,
  exe: nodeExe(box),
});

const grokSession = (box: Box) => join(box.home, ".grok/sessions", encodeURIComponent(box.work), GROK_ID);

type Deferral = [string, string | undefined, (world: FakeWorld, box: Box) => void];

const grokRefusal = (what: string, summary: (box: Box) => unknown): Deferral => [
  `the saved Grok metadata ${what}`,
  "w1:p2",
  (world, box) => {
    useGrok(world, box);
    writeText(join(grokSession(box), "summary.json"), summary(box));
  },
];
const grokHome = (box: Box) => `${box.home}/.grok`;

const GROK_METADATA_REFUSALS: Deferral[] = [
  grokRefusal("names another conversation", (box) => ({
    info: { id: CODEX_ID, cwd: box.work },
    grok_home: grokHome(box),
  })),
  grokRefusal("names another directory", (box) => ({
    info: { id: GROK_ID, cwd: "/elsewhere" },
    grok_home: grokHome(box),
  })),
  grokRefusal("names another Grok home", (box) => ({
    info: { id: GROK_ID, cwd: box.work },
    grok_home: "/elsewhere/.grok",
  })),
  grokRefusal("belongs to a headless run", (box) => ({
    info: { id: GROK_ID, cwd: box.work },
    grok_home: grokHome(box),
    session_kind: "headless",
  })),
  grokRefusal("is not JSON", () => "{not json"),
  grokRefusal("has no identity", () => ({})),
];

const DEFERRED: Deferral[] = [
  ["an agent is working", "w1:p1", (world) => void (pane(world, "w1:p1").status = "working")],
  ["an agent waits for approval", "w1:p2", (world) => void (pane(world, "w1:p2").status = "blocked")],
  ["an agent's state is unknown", "w1:p2", (world) => void (pane(world, "w1:p2").status = "unknown")],
  ["an agent is still launching", "w1:p2", (world) => void (pane(world, "w1:p2").launchPending = true)],
  ["an earlier restore reported an error", "w1:p2", (world) => void (pane(world, "w1:p2").restoreError = "boom")],
  [
    "a job runs in another process group",
    "w1:p2",
    (world) => void world.procs.push({ pid: 212, ppid: 211, pgid: 212, name: "bash" }),
  ],
  [
    "a user's job shares the agent's process group",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", { ...serverChild(box), command: undefined }, ["node", "train.js"]);
    },
  ],
  [
    "a process runs a configured server's command with other arguments",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", toolChild(box), [...TOOL_ARGV, "--other"]);
    },
  ],
  [
    "a child has the configured arguments but runs another file than the command resolves to",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", { ...toolChild(box), exe: programElsewhere(box, "mcp-tool") }, TOOL_ARGV);
    },
  ],
  [
    "a child has the configured arguments but its file was replaced at the same path",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", { ...toolChild(box), inode: "999" }, TOOL_ARGV);
    },
  ],
  [
    "a child has the configured arguments but its executable cannot be mapped",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", { ...toolChild(box), exe: undefined }, TOOL_ARGV);
    },
  ],
  [
    "a configured command is not on PATH",
    "w1:p2",
    (world, box) => {
      claudeMcp(box, { server: { command: "not-installed", args: ["mcp"] } });
      inForeground(world, "w1:p2", toolChild(box), ["not-installed", "mcp"]);
    },
  ],
  [
    "a configured script's interpreter on PATH is not the one the child runs",
    "w1:p2",
    (world, box) => {
      const script = configuredScript(box, "node");
      inForeground(world, "w1:p2", { ...serverChild(box), exe: programElsewhere(box, "node") }, ["node", script]);
    },
  ],
  [
    "a configured script's interpreter is not on PATH",
    "w1:p2",
    (world, box) => {
      const script = configuredScript(box, "not-installed");
      inForeground(world, "w1:p2", serverChild(box), ["not-installed", script]);
    },
  ],
  [
    "a configured launcher execs a file that no longer exists",
    "w1:p2",
    (world, box) => {
      const gone = join(box.home, "mcp/gone");
      execLauncherOf(box, gone);
      inForeground(world, "w1:p2", { ...toolChild(box), exe: gone }, [gone, "mcp"]);
    },
  ],
  [
    "OMP's configured server runs another node than PATH finds",
    "w1:p1",
    (world, box) => void (proc(world, 202).exe = programElsewhere(box, "node")),
  ],
  [
    "one spaced argument prints like a configured pair of arguments",
    "w1:p2",
    (world, box) => {
      claudeMcp(box, { server: { command: "node", args: SPLIT_ARGS } });
      inForeground(world, "w1:p2", serverChild(box), ["node", ...SPACED_ARGS]);
    },
  ],
  [
    "a pair of arguments prints like one configured spaced argument",
    "w1:p2",
    (world, box) => {
      claudeMcp(box, { server: { command: "node", args: SPACED_ARGS } });
      inForeground(world, "w1:p2", serverChild(box), ["node", ...SPLIT_ARGS]);
    },
  ],
  [
    "Herdr reports no argument list for a child ps shows as a configured server",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      world.procs.push({ ...toolChild(box), command: TOOL_LINE });
      pane(world, "w1:p2").foreground?.push({ pid: 212, name: "tool" });
    },
  ],
  [
    "a configured server runs in its own process group, where Herdr does not list it",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      world.procs.push({ ...toolChild(box), pgid: 212, command: TOOL_LINE });
    },
  ],
  [
    "Herdr lists a child twice with different argument lists",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
      pane(world, "w1:p2").foreground?.push({ pid: 212, name: "tool", argv: ["python", "job.py"] });
    },
  ],
  [
    "a child's argument list holds an entry that is not a string",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      const [command, ...args] = TOOL_ARGV;
      inForeground(world, "w1:p2", toolChild(box), [command ?? "", 7, ...args]);
    },
  ],
  [
    "a configured command line runs beside the agent rather than under it",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", { ...toolChild(box), ppid: 210 }, TOOL_ARGV);
    },
  ],
  [
    "the processes under a configured launcher share its group and stdio",
    "w1:p2",
    (world, box) => wrappedServer(world, box),
  ],
  [
    "a job runs under a configured server",
    "w1:p2",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
      inForeground(world, "w1:p2", { pid: 213, ppid: 212, pgid: 211, name: "python" }, ["python", "job.py"]);
    },
  ],
  [
    "only a repository's .mcp.json describes the process",
    "w1:p2",
    (world, box) => {
      writeText(join(box.work, ".mcp.json"), { mcpServers: { tool: TOOL_SERVER } });
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "the only match is a server Codex has disabled",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      writeText(join(box.home, ".codex/config.toml"), `${TOOL_TOML}enabled = false\n`);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "a job in its own group runs under OMP's managed infrastructure",
    "w1:p1",
    (world) => {
      world.procs.push(
        { pid: 204, ppid: 201, pgid: 204, name: "omp" },
        { pid: 205, ppid: 204, pgid: 205, name: "python" },
      );
      world.omp = [{ daemons: [{ name: "lsp", id: "1", state: "running", pid: 204, owner: null }] }];
    },
  ],
  [
    "a job in the same group runs under OMP's managed infrastructure",
    "w1:p1",
    (world) => {
      world.procs.push(
        { pid: 204, ppid: 201, pgid: 204, name: "omp" },
        { pid: 205, ppid: 204, pgid: 204, name: "python" },
      );
      world.omp = [{ daemons: [{ name: "lsp", id: "1", state: "running", pid: 204, owner: null }] }];
    },
  ],
  [
    "a job runs under OMP's broker",
    "w1:p1",
    (world) => {
      world.procs.push(
        { pid: 204, ppid: 201, pgid: 204, name: "omp" },
        { pid: 205, ppid: 204, pgid: 201, name: "python" },
      );
      world.omp = [{ brokerPid: 204, daemons: [] }];
    },
  ],
  [
    "a running OMP service has no owner field",
    "w1:p1",
    (world) => {
      world.procs.push({ pid: 204, ppid: 201, pgid: 204, name: "omp" });
      world.omp = [{ daemons: [{ name: "svc", id: "1", state: "running", pid: 204 }] }];
    },
  ],
  [
    "a running OMP service has a malformed owner",
    "w1:p1",
    (world) => {
      world.omp = [{ daemons: [{ name: "svc", id: "1", state: "running", pid: 999, owner: 7 }] }];
    },
  ],
  [
    "a job descends from a helper in another group",
    "w1:p1",
    (world) => void world.procs.push({ pid: 203, ppid: 202, pgid: 203, name: "python" }),
  ],
  [
    "a shell pane runs a foreground command",
    "w1:p3",
    (world) => {
      world.procs.push({ pid: 221, ppid: 220, name: "vim" });
      Object.assign(pane(world, "w1:p3"), { fgGroup: 221, foreground: [{ pid: 221, name: "vim" }] });
    },
  ],
  [
    "a shell pane has a background job",
    "w1:p3",
    (world) => void world.procs.push({ pid: 221, ppid: 220, name: "sleep" }),
  ],
  ["a shell pane's directory is gone", "w1:p3", (world, box) => void (pane(world, "w1:p3").cwd = `${box.home}/gone`)],
  ["the agent's directory is gone", "w1:p2", (world, box) => void (pane(world, "w1:p2").cwd = `${box.home}/gone`)],
  ["the OMP conversation was never saved", "w1:p1", (_world, box) => rmSync(box.ompSession)],
  ["a Claude transcript is not in the default profile", "w1:p2", (_world, box) => rmSync(box.claudeTranscript)],
  [
    "the saved OMP header belongs to another directory",
    "w1:p1",
    (_world, box) =>
      writeText(box.ompSession, `${JSON.stringify({ type: "session", id: OMP_ID, cwd: "/elsewhere" })}\n`),
  ],
  [
    "the saved Claude transcript belongs to another conversation",
    "w1:p2",
    (_world, box) => writeText(box.claudeTranscript, `${JSON.stringify({ sessionId: GROK_ID })}\n`),
  ],
  ["the pane has no saved reference", "w1:p2", (world) => void delete pane(world, "w1:p2").ref],
  [
    "OMP was started with flags restore drops",
    "w1:p1",
    (world) => {
      const entry = pane(world, "w1:p1").foreground?.[0];
      if (entry) entry.argv = ["omp", "--allow-home", "--prewalk", "--prewalk-into", "@task"];
    },
  ],
  [
    "Claude was started with flags restore drops",
    "w1:p2",
    (world) => {
      const entry = pane(world, "w1:p2").foreground?.[0];
      if (entry) entry.argv = ["claude", "--model", "other"];
    },
  ],
  [
    "the running argv resumes a different conversation",
    "w1:p2",
    (world) => {
      const entry = pane(world, "w1:p2").foreground?.[0];
      if (entry) entry.argv = ["claude", "--resume", GROK_ID];
    },
  ],
  [
    "the argv cannot be read",
    "w1:p2",
    (world) => {
      const entry = pane(world, "w1:p2").foreground?.[0];
      if (entry) delete entry.argv;
    },
  ],
  [
    "the argv is empty",
    "w1:p2",
    (world) => {
      const entry = pane(world, "w1:p2").foreground?.[0];
      if (entry) entry.argv = [];
    },
  ],
  ["the agent kind is not supported", "w1:p2", (world) => void (pane(world, "w1:p2").agent = "copilot")],
  ["the agent process cannot be found", "w1:p2", (world) => void (pane(world, "w1:p2").foreground = [])],
  ["the agent executable cannot be mapped", "w1:p2", (world) => void delete proc(world, 211).exe],
  ["the agent executable is reported without an inode", "w1:p2", (world) => void (proc(world, 211).noInode = true)],
  ["the agent belongs to another user", "w1:p2", (world) => void (proc(world, 211).uid = UID + 1)],
  ["the foreground group is not the agent's", "w1:p2", (world) => void (pane(world, "w1:p2").fgGroup = 999)],
  [
    "this OMP conversation owns a running service",
    "w1:p1",
    (world) => {
      world.omp = [
        { daemons: [{ name: "svc", id: "1", state: "running", pid: 999, owner: OMP_ID, command: "secret" }] },
      ];
    },
  ],
  ["the OMP inventory cannot be read", "w1:p1", (world) => void (world.omp = "not json")],
  [
    "Herdr's native restore is off",
    undefined,
    (_world, box) =>
      writeText(join(box.home, ".config/herdr/config.toml"), "[session]\nresume_agents_on_restore = false\n"),
  ],
  [
    "the Herdr config cannot be parsed",
    undefined,
    (_world, box) => writeText(join(box.home, ".config/herdr/config.toml"), "[[["),
  ],
  ["no process owns the socket", undefined, (world) => void delete world.sessions[0]?.serverPid],
  ["the server belongs to another user", undefined, (world) => void (proc(world, 100).uid = UID + 1)],
  ["the server executable is foreign", undefined, (world) => void (proc(world, 100).exe = "/tmp/herdr")],
  ["the server executable is reported without an inode", undefined, (world) => void (proc(world, 100).noInode = true)],
  [
    "a Codex pane relies on an old shared daemon",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      world.procs.push({ pid: 500, ppid: 1, name: "codex", exe: daemonExe(box, "1.0.0") });
      world.codexDaemon = { cliVersion: "2.0.0", appServerVersion: "1.0.0" };
    },
  ],
  [
    "a Codex pane relies on a daemon of unknown version",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      world.procs.push({ pid: 500, ppid: 1, name: "codex", exe: daemonExe(box, "2.0.0") });
      world.codexDaemon = "";
    },
  ],
  [
    "the Codex daemon reports an old version for a process whose executable cannot be mapped",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      world.procs.push({ pid: 500, ppid: 1, name: "codex" });
      world.codexDaemon = { cliVersion: "2.0.0", appServerVersion: "1.0.0" };
    },
  ],
  [
    "the Codex daemon query fails and no daemon executable is mapped",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      writeText(join(box.stub, "codex-fails"), "");
    },
  ],
  [
    "the Codex daemon query prints nothing usable",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      world.codexDaemon = "";
    },
  ],
  [
    "the Codex daemon reports itself stopped while its executable is mapped",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      world.procs.push({ pid: 500, ppid: 1, name: "codex", exe: daemonExe(box, "2.0.0") });
    },
  ],
  [
    "a saved Codex rollout belongs to another directory",
    "w1:p2",
    (world, box) => {
      useCodex(world, box);
      writeText(
        join(box.home, `.codex/sessions/2026/11/08/rollout-2026-11-08T10-00-00-${CODEX_ID}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: "/elsewhere" } })}\n`,
      );
    },
  ],
  [
    "a Grok leader is running",
    "w1:p2",
    (world, box) => {
      useGrok(world, box);
      world.grokLeaders = [{ id: "leader" }];
    },
  ],
  [
    "the Grok leaders cannot be listed",
    "w1:p2",
    (world, box) => {
      useGrok(world, box);
      world.grokLeaders = "not json";
    },
  ],
  [
    "Grok's saved metadata is missing",
    "w1:p2",
    (world, box) => {
      useGrok(world, box);
      rmSync(join(grokSession(box), "summary.json"));
    },
  ],
  [
    "a Grok conversation was never saved",
    "w1:p2",
    (world, box) => {
      useGrok(world, box);
      rmSync(join(grokSession(box), "chat_history.jsonl"));
    },
  ],
  ...GROK_METADATA_REFUSALS,
];

test.each(DEFERRED)("a session is deferred before any stop when %s", async (_name, blockedPane, mutate) => {
  const box = restartable();
  const world = before(box);
  mutate(world, box);
  box.world(world);

  const applied = await box.run(["--apply"]);
  const status = await box.status();

  expect(applied.code).toBe(3);
  expect(applied.asked).toBe(0);
  expect(box.stops()).toEqual([]);
  expect(status.sessions[0].ready).toBe(false);
  const panes = status.sessions[0].blockers.map((blocker: { pane?: string }) => blocker.pane);
  expect(panes).toContain(blockedPane);
});

const READY: [string, (world: FakeWorld, box: Box) => void][] = [
  ["nothing unusual", () => undefined],
  ["an agent is done rather than idle", (world) => void (pane(world, "w1:p2").status = "done")],
  [
    "Claude runs a resumed conversation",
    (world) => {
      const entry = pane(world, "w1:p2").foreground?.[0];
      if (entry) entry.argv = ["claude", "-r", CLAUDE_ID];
    },
  ],
  [
    "a configured MCP server shares the agent's process group",
    (world, box) => {
      configureTool(box);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "a configured absolute command runs that very file",
    (world, box) => {
      const tool = programElsewhere(box, "tool");
      claudeMcp(box, { server: { command: tool, args: ["mcp"] } });
      inForeground(world, "w1:p2", { ...toolChild(box), exe: tool }, [tool, "mcp"]);
    },
  ],
  [
    "a configured command on PATH is a symlink to the file the child runs",
    (world, box) => {
      const real = programElsewhere(box, "tool");
      symlinkSync(real, join(box.bin, "linked-tool"));
      claudeMcp(box, { server: { command: "linked-tool", args: ["mcp"] } });
      inForeground(world, "w1:p2", { ...toolChild(box), exe: real }, ["linked-tool", "mcp"]);
    },
  ],
  [
    "a configured argument containing a space matches exactly",
    (world, box) => {
      claudeMcp(box, { server: { command: "node", args: SPACED_ARGS } });
      inForeground(world, "w1:p2", serverChild(box), ["node", ...SPACED_ARGS]);
    },
  ],
  [
    "a project's local-scope MCP server is configured for this directory",
    (world, box) => {
      claudeMcp(box, {}, { projects: { [box.work]: { mcpServers: { tool: TOOL_SERVER } } } });
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "a configured script runs through a symlink and its shebang",
    (world, box) => {
      const script = join(box.home, "mcp/server.js");
      const link = join(box.home, "mcp/server");
      writeProgram(script, "#!/usr/bin/env node\n");
      symlinkSync(script, link);
      claudeMcp(box, { server: { command: link, args: ["--headless"] } });
      inForeground(world, "w1:p2", serverChild(box), ["node", link, "--headless"]);
    },
  ],
  [
    "a configured launcher that only execs its script has no children yet",
    (world, box) => inForeground(world, "w1:p2", { ...toolChild(box), name: "bash", exe: BASH }, execLauncher(box)),
  ],
  [
    "a configured launcher has become the program it execs",
    (world, box) => {
      const target = programElsewhere(box, "tool");
      execLauncherOf(box, target);
      inForeground(world, "w1:p2", { ...toolChild(box), exe: target }, [target, "mcp"]);
    },
  ],
  [
    "a Codex pane runs a server from Codex's configuration",
    (world, box) => {
      useCodex(world, box);
      writeText(join(box.home, ".codex/config.toml"), TOOL_TOML);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "a Grok pane runs a server from Grok's configuration",
    (world, box) => {
      useGrok(world, box);
      writeText(join(box.home, ".grok/config.toml"), TOOL_TOML);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "a Grok pane runs a server it takes from Claude's configuration",
    (world, box) => {
      useGrok(world, box);
      configureTool(box);
      inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
    },
  ],
  [
    "OMP lists both a service and the broker above it",
    (world) => {
      world.procs.push(
        { pid: 204, ppid: 201, pgid: 204, name: "omp" },
        { pid: 205, ppid: 204, pgid: 205, name: "lsp" },
      );
      world.omp = [{ brokerPid: 204, daemons: [{ name: "lsp", id: "1", state: "running", pid: 205, owner: null }] }];
    },
  ],
  [
    "a helper exited and only its zombie remains",
    (world) => void world.procs.push({ pid: 212, ppid: 211, pgid: 212, state: "Z", name: "bash" }),
  ],
  [
    "OMP's managed infrastructure runs in another group",
    (world) => {
      world.procs.push({ pid: 204, ppid: 201, pgid: 204, name: "omp" });
      world.omp = [{ daemons: [{ name: "lsp", id: "1", state: "running", pid: 204, owner: null }] }];
    },
  ],
  [
    "OMP's broker is a descendant in another group",
    (world) => {
      world.procs.push({ pid: 204, ppid: 201, pgid: 204, name: "omp" });
      world.omp = [{ brokerPid: 204, daemons: [] }];
    },
  ],
  [
    "a service of another conversation is running",
    (world) => {
      world.omp = [{ daemons: [{ name: "svc", id: "1", state: "running", pid: 999, owner: GROK_ID }] }];
    },
  ],
  [
    "this conversation's service has exited",
    (world) => {
      world.omp = [{ daemons: [{ name: "svc", id: "1", state: "exited", pid: 999, owner: OMP_ID }] }];
    },
  ],
  ["a Codex pane has no shared daemon", (world, box) => useCodex(world, box)],
  ["a Codex pane resumed its conversation", (world, box) => useCodex(world, box, ["codex", "resume", CODEX_ID])],
  [
    "a Codex pane's shared daemon is current",
    (world, box) => {
      useCodex(world, box);
      world.procs.push({ pid: 500, ppid: 1, name: "codex", exe: daemonExe(box, "2.0.0") });
      world.codexDaemon = { cliVersion: "codex-cli 2.0.0", appServerVersion: "2.0.0" };
    },
  ],
  ["a Grok pane has no leaders", (world, box) => useGrok(world, box)],
  ["a Grok pane resumed its conversation", (world, box) => useGrok(world, box, ["grok", `--resume=${GROK_ID}`])],
  [
    "the Herdr config leaves restore on",
    (_world, box) =>
      writeText(join(box.home, ".config/herdr/config.toml"), "[session]\nresume_agents_on_restore = true\n"),
  ],
];

test.each(READY)("a session stays restartable when %s", async (_name, mutate) => {
  const box = setup();
  const world = before(box);
  mutate(world, box);
  box.world(world);

  const status = await box.status();

  expect(status.sessions[0].blockers).toEqual([]);
  expect(status.sessions[0].ready).toBe(true);
});

test("an old agent reported without an inode is no update to restart it for", async () => {
  const box = restartable();
  const world = before(box);
  proc(world, 201).noInode = true;
  box.world(world);

  const result = await box.run(["--apply"]);
  const status = await box.status();

  expect(status.sessions[0].affected).toBe(false);
  expect(result.asked).toBe(0);
  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
});

test("the plan names the helpers that stop with the session", async () => {
  const box = restartable();

  const status = await box.status();

  expect(status.sessions[0].helpers).toEqual(["node"]);
});

const BAD_RESTORES: [string, (world: FakeWorld, box: Box) => void][] = [
  [
    "a fallback shell replaced the agent",
    (world) => {
      const target = pane(world, "w1:p2");
      delete target.agent;
      delete target.ref;
    },
  ],
  [
    "a different conversation came back",
    (world) => void (pane(world, "w1:p2").ref = { agent: "claude", kind: "id", value: GROK_ID }),
  ],
  ["another agent occupies the pane", (world) => void (pane(world, "w1:p2").agent = "codex")],
  ["the terminal was not replaced", (world) => void (pane(world, "w1:p2").terminalId = "t2")],
  ["the restored agent runs an old executable", (world, box) => void (proc(world, 401).exe = box.exe("omp", "1.0.0"))],
  ["the pane returned in another directory", (world, box) => void (pane(world, "w1:p2").cwd = box.home)],
  ["a pane is missing", (world) => void world.sessions[0]?.panes.pop()],
  [
    "an unexpected pane appeared",
    (world, box) => void world.sessions[0]?.panes.push({ id: "w1:p9", terminalId: "t9", cwd: box.work }),
  ],
  ["a shell pane now holds an agent", (world) => void (pane(world, "w1:p3").agent = "omp")],
  ["Herdr reports a restore error", (world) => void (pane(world, "w1:p2").restoreError = "boom")],
];

test.each(BAD_RESTORES)(
  "a failed postcheck keeps a private record and never stops twice when %s",
  async (_name, mutate) => {
    const box = restartable(3);
    const bad = restored(box);
    mutate(bad, box);
    box.afterAttach(bad);

    const first = await box.run(["--apply"]);

    expect(first.code).toBe(1);
    expect(box.stops()).toHaveLength(1);
    const record = box.recoveryFile("default");
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(readFileSync(record, "utf8")).toContain(CLAUDE_ID);
    expect(first.out).not.toContain(CLAUDE_ID);
    expect(first.err).not.toContain(CLAUDE_ID);

    const second = await box.run(["--apply"]);

    expect(second.code).toBe(1);
    expect(box.stops()).toHaveLength(1);
    expect(existsSync(record)).toBe(true);
  },
  30_000,
);

test("a rerun clears the record once the session is really restored, without another stop", async () => {
  const box = restartable(3);
  const bad = restored(box);
  pane(bad, "w1:p2").terminalId = "t2";
  box.afterAttach(bad);
  expect((await box.run(["--apply"])).code).toBe(1);

  box.world(restored(box));
  const result = await box.run(["--apply"]);

  expect(result.code).toBe(0);
  expect(result.asked).toBe(0);
  expect(box.stops()).toHaveLength(1);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
}, 30_000);

test("a rerun after an interrupted restore attaches a client but does not stop again", async () => {
  const box = restartable();
  box.world(stopped());
  writeText(box.recoveryFile("default"), {
    session: "default",
    server: { pid: 100, started: STARTED.replace(/\s+/g, " ") },
    panes: restored(box).sessions[0]?.panes.map((candidate) => ({
      id: candidate.id,
      terminalId: `old-${candidate.terminalId}`,
      agent: candidate.agent,
      cwd: candidate.cwd,
      foregroundCwd: candidate.agent ? candidate.cwd : undefined,
      ref: candidate.ref,
    })),
  });

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(0);
  expect(result.asked).toBe(1);
  expect(box.stops()).toEqual([]);
  expect(box.attaches()).toEqual(["herdr "]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
});

test("a recovery record from a stop that never happened is dropped and planning resumes", async () => {
  const box = restartable();
  writeText(box.recoveryFile("default"), {
    session: "default",
    server: { pid: 100, started: STARTED.replace(/\s+/g, " ") },
    panes: [],
  });

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(0);
  expect(box.stops()).toHaveLength(1);
});

test("a stop that had no effect reports failure, keeps no record, and attaches nothing", async () => {
  const box = restartable();
  writeText(join(box.stub, "stop-fails"), "");

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(1);
  expect(box.attaches()).toEqual([]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
}, 30_000);

test("a failed restart prevents the next session from being stopped", async () => {
  const box = setup(3);
  const add = (world: FakeWorld, serverPid: number) => {
    world.procs.push(
      { pid: serverPid, ppid: 1, name: "herdr", exe: box.exe("herdr", "1.0.0") },
      { pid: serverPid + 1, ppid: serverPid, name: "zsh" },
    );
    world.sessions.push({
      name: "second",
      serverPid,
      panes: [
        {
          id: "w9:p1",
          terminalId: "t9",
          cwd: box.work,
          shellPid: serverPid + 1,
          fgGroup: serverPid + 1,
          foreground: [{ pid: serverPid + 1, name: "zsh" }],
        },
      ],
    });
    return world;
  };
  box.world(add(before(box), 700));
  box.afterStop(add(stopped(), 700));
  const bad = add(restored(box), 700);
  pane(bad, "w1:p2").terminalId = "t2";
  box.afterAttach(bad);

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(1);
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
}, 30_000);

test("--apply --session restarts only that session and leaves the GUI and other stale sessions alone", async () => {
  const box = setup();
  const addSmoke = (world: FakeWorld, serverPid: number, version: string, terminalId: string) => {
    world.procs.push(
      { pid: serverPid, ppid: 1, name: "herdr", exe: box.exe("herdr", version) },
      { pid: serverPid + 1, ppid: serverPid, name: "zsh" },
    );
    world.sessions.push({
      name: "smoke",
      serverPid,
      panes: [
        {
          id: "w9:p1",
          terminalId,
          cwd: box.work,
          shellPid: serverPid + 1,
          fgGroup: serverPid + 1,
          foreground: [{ pid: serverPid + 1, name: "zsh" }],
        },
      ],
    });
    return world;
  };
  const withGui = (world: FakeWorld): FakeWorld => ({
    ...world,
    procs: [...world.procs, { pid: 600, ppid: 1, name: "sheprd", exe: box.exe("sheprd") }],
    gui: { pid: 600, version: "1.0.0" },
  });
  // `default` stays stale and ready throughout; scoping is what keeps it running.
  box.world(withGui(addSmoke(before(box), 700, "1.0.0", "t9")));
  const smokeStopped = withGui(before(box));
  smokeStopped.sessions.push({ name: "smoke", running: false, panes: [] });
  box.afterStop(smokeStopped);
  box.afterAttach(withGui(addSmoke(before(box), 800, "2.0.0", "t10")));

  const result = await box.run(["--apply", "--session", "smoke"]);

  expect(result.code).toBe(0);
  expect(result.asked).toBe(1);
  expect(box.stops()).toEqual(["herdr session stop smoke --json"]);
  expect(box.attaches()).toEqual(["herdr session attach smoke"]);
  expect(box.calls()).not.toContain("sheprd app quit --json");
}, 30_000);

test("--apply --session with an unknown name stops nothing", async () => {
  const box = restartable();

  const result = await box.run(["--apply", "--session", "--all;rm -rf ~"]);

  expect(result.code).toBe(2);
  expect(result.asked).toBe(0);
  expect(box.stops()).toEqual([]);
  expect(box.calls().join("\n")).not.toContain("rm -rf");
});

test("a deferred session is left alone while a ready one restarts", async () => {
  const box = setup();
  const add = (world: FakeWorld) => {
    world.procs.push(
      { pid: 700, ppid: 1, name: "herdr", exe: box.exe("herdr") },
      { pid: 701, ppid: 700, name: "zsh" },
      { pid: 702, ppid: 701, name: "claude", exe: box.exe("claude", "1.0.0") },
    );
    world.sessions.push({
      name: "busy",
      serverPid: 700,
      panes: [
        {
          id: "w9:p1",
          terminalId: "t9",
          agent: "claude",
          status: "working",
          cwd: box.work,
          ref: { agent: "claude", kind: "id", value: CLAUDE_ID },
          shellPid: 701,
          fgGroup: 702,
          foreground: [{ pid: 702, name: "claude", argv: ["claude"] }],
        },
      ],
    });
    return world;
  };
  box.world(add(before(box)));
  box.afterStop(add(stopped()));
  box.afterAttach(add(restored(box)));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(3);
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
}, 30_000);

test("an unidentified child holds only its own session while an independent ready session restarts", async () => {
  const box = setup();
  const add = (world: FakeWorld) => {
    world.procs.push(
      { pid: 700, ppid: 1, name: "herdr", exe: box.exe("herdr") },
      { pid: 701, ppid: 700, name: "zsh" },
      { pid: 702, ppid: 701, name: "claude", exe: box.exe("claude", "1.0.0"), channel: "chan" },
      { pid: 703, ppid: 702, pgid: 702, name: "sleep", command: "sleep 999", channel: "chan" },
    );
    world.sessions.push({
      name: "held",
      serverPid: 700,
      panes: [
        {
          id: "w9:p1",
          terminalId: "t9",
          agent: "claude",
          cwd: box.work,
          ref: { agent: "claude", kind: "id", value: CLAUDE_ID },
          shellPid: 701,
          fgGroup: 702,
          foreground: [
            { pid: 702, name: "claude", argv: ["claude"] },
            { pid: 703, name: "sleep", argv: ["sleep", "999"] },
          ],
        },
      ],
    });
    return world;
  };
  box.world(add(before(box)));
  box.afterStop(add(stopped()));
  box.afterAttach(add(restored(box)));

  const status = await box.status();
  const result = await box.run(["--apply"]);

  const ready = status.sessions.map((session: { name: string; ready: boolean }) => [session.name, session.ready]);
  expect(ready).toEqual([
    ["default", true],
    ["held", false],
  ]);
  expect(result.code).toBe(3);
  expect(result.asked).toBe(1);
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
}, 30_000);

// Two sessions run well over a hundred native commands, more than the default 5 s allows on a busy
// machine. The runner also kills what a timed-out test has running, and a command killed during the
// restore's last check leaves the recovery record behind, so the time limit has to be the real one.
test.each([
  ["the final scan still shows it stale", (box: Box) => before(box)],
  ["the final scan no longer shows it stale", (box: Box) => restored(box)],
])(
  "a session held after approval does not cost the next one its restart when %s",
  async (_name, finalDefault) => {
    const box = setup();
    const second = (world: FakeWorld, serverPid: number, version: string, terminalId: string) => {
      world.procs.push(
        { pid: serverPid, ppid: 1, name: "herdr", exe: box.exe("herdr", version) },
        { pid: serverPid + 1, ppid: serverPid, name: "zsh" },
      );
      world.sessions.push({
        name: "second",
        serverPid,
        panes: [
          {
            id: "w9:p1",
            terminalId,
            cwd: box.work,
            shellPid: serverPid + 1,
            fgGroup: serverPid + 1,
            foreground: [{ pid: serverPid + 1, name: "zsh" }],
          },
        ],
      });
      return world;
    };
    // Both are ready when approved; only then does a job appear under the first session's agent.
    const held = before(box);
    held.procs.push({ pid: 212, ppid: 211, pgid: 212, name: "python" });
    box.world(second(before(box), 700, "1.0.0", "t9"));
    const secondStopped = before(box);
    secondStopped.sessions.push({ name: "second", running: false, panes: [] });
    box.afterStop(secondStopped);
    box.afterAttach(second(finalDefault(box), 800, "2.0.0", "t10"));

    const result = await box.run(["--apply"], {
      beforeAnswer: () => box.mutateOn("omp ps list --all --json", second(held, 700, "1.0.0", "t9")),
    });

    expect(result.asked).toBe(1);
    expect(box.stops()).toEqual(["herdr session stop second --json"]);
    expect(box.attaches()).toEqual(["herdr session attach second"]);
    expect(existsSync(box.recoveryFile("default"))).toBe(false);
    expect(existsSync(box.recoveryFile("second"))).toBe(false);
    expect(result.code).toBe(3);
  },
  30_000,
);

test("a launcher counts as the configured server while what it runs defers the session", async () => {
  const box = setup();
  const world = before(box);
  wrappedServer(world, box);
  box.world(world);

  const status = await box.status();
  const reasons = status.sessions[0].blockers.map((blocker: { reason: string }) => blocker.reason).join("\n");

  expect(status.sessions[0].helpers).toContain("bash");
  expect(reasons).not.toContain("pid 212");
  expect(reasons).toContain("pid 213");
  expect(reasons).toContain("pid 214");
});

// A GUI whose own report names an older version than the installed one.
const guiRunning = (box: Box, process: Partial<FakeProc> = {}): FakeWorld => ({
  ...restored(box),
  procs: [...restored(box).procs, { pid: 600, ppid: 1, name: "sheprd", exe: box.exe("sheprd"), ...process }],
  gui: { pid: 600, version: "1.0.0", hosts: ["local", "ssh:remote"] },
});

function guiOnly(box: Box) {
  box.world(guiRunning(box));
  box.afterQuit(restored(box));
  box.afterOpen({
    ...restored(box),
    procs: [...restored(box).procs, { pid: 601, ppid: 1, name: "sheprd", exe: box.exe("sheprd") }],
    gui: { pid: 601, version: "2.0.0" },
  });
}

test("a GUI-only update reopens the GUI and never stops a server", async () => {
  const box = setup();
  guiOnly(box);

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(0);
  expect(result.asked).toBe(1);
  expect(box.calls()).toContain("sheprd app quit --json");
  expect(box.calls()).toContain(`open ${box.bundle}`);
  expect(box.stops()).toEqual([]);
  expect(box.attaches()).toEqual([]);
  expect(box.calls().filter((call) => call.includes("ssh:") || call.includes("server stop"))).toEqual([]);
});

test.each([
  ["busy with a dialog", "6", 3],
  ["unsupported by this version", "8", 1],
])("when Sheprd is %s it is not reopened or forced", async (_name, quit, code) => {
  const box = setup();
  guiOnly(box);
  writeText(join(box.stub, "quit-code"), quit);

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(code);
  expect(box.calls().filter((call) => call.startsWith("open"))).toEqual([]);
});

test("a GUI that does not come back is a failure", async () => {
  const box = setup(3);
  guiOnly(box);
  box.afterOpen(restored(box));

  expect((await box.run(["--apply"])).code).toBe(1);
}, 30_000);

test("a GUI that changed after approval is not quit", async () => {
  const box = setup();
  guiOnly(box);
  const changed = {
    ...restored(box),
    procs: [...restored(box).procs, { pid: 650, ppid: 1, name: "sheprd", exe: box.exe("sheprd") }],
    gui: { pid: 650, version: "1.0.0" },
  };

  const result = await box.run(["--apply"], { beforeAnswer: () => box.world(changed) });

  expect(result.code).toBe(3);
  expect(box.calls()).not.toContain("sheprd app quit --json");
});

test("a GUI skipped after approval stays reported even when the final scan shows it current", async () => {
  const box = setup();
  guiOnly(box);
  const updatedMeanwhile = {
    ...restored(box),
    procs: [...restored(box).procs, { pid: 650, ppid: 1, name: "sheprd", exe: box.exe("sheprd") }],
    gui: { pid: 650, version: "2.0.0" },
  };

  const result = await box.run(["--apply"], { beforeAnswer: () => box.world(updatedMeanwhile) });

  expect(result.code).toBe(3);
  expect(box.calls()).not.toContain("sheprd app quit --json");
});

test("a process lsof reports no inode for borrows none from the previous process or a later library", () => {
  const exes = parseMappedExes("p1\nftxt\ni42\nn/bin/tool\np2\nftxt\nn/bin/tool\nftxt\ni7\nn/usr/lib/dyld\n");

  expect(exes.get(1)).toEqual({ path: "/bin/tool", inode: "42" });
  expect(exes.get(2)).toEqual({ path: "/bin/tool", inode: "" });
});

test("a Sheprd outside the expected install location is not reopened", async () => {
  const box = setup();
  guiOnly(box);
  rmSync(join(box.bin, "sheprd"));
  const foreign = join(box.home, "elsewhere/sheprd");
  writeStub(foreign, TOOL_STUBS.sheprd ?? "");
  symlinkSync(foreign, join(box.bin, "sheprd"));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(3);
  expect(box.calls()).not.toContain("sheprd app quit --json");
});

test.each([
  ["cannot be mapped", { exe: undefined }],
  ["is reported without an inode", { noInode: true }],
])("a GUI reporting an old version whose executable %s is held, not quit", async (_name, mapping) => {
  const box = setup();
  guiOnly(box);
  box.world(guiRunning(box, mapping));

  const result = await box.run(["--apply"]);
  const status = await box.status();

  expect(status.gui.state).toBe("pending");
  expect(status.gui.blockers).toHaveLength(1);
  expect(result.code).toBe(3);
  expect(result.asked).toBe(0);
  expect(box.calls()).not.toContain("sheprd app quit --json");
});

test("nothing to do needs no approval and exits cleanly", async () => {
  const box = setup();
  box.world(restored(box));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(0);
  expect(result.asked).toBe(0);
});

test("a stale process outside Herdr is reported but cannot be applied", async () => {
  const box = setup();
  const world = restored(box);
  world.procs.push({ pid: 500, ppid: 1, name: "claude", exe: box.exe("claude", "1.0.0") });
  box.world(world);

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(3);
  expect(result.asked).toBe(0);
  expect(result.out).toContain("pid 500");
  expect(box.stops()).toEqual([]);
});

test("hostile session data stays out of commands and off the terminal", async () => {
  const box = restartable();
  const world = before(box);
  world.sessions.push(
    { name: "--all;rm -rf ~", running: true, socket: "/tmp/evil.sock", panes: [] },
    { name: "\u001b[31mred", running: true, socket: "/tmp/red.sock", panes: [] },
    { name: "forwarded", running: true, socket: "/tmp/forwarded.sock", panes: [] },
    { name: "../escape", running: true, socket: `${box.home}/.config/herdr/sessions/../escape/herdr.sock`, panes: [] },
  );
  pane(world, "w1:p3").id = "\u001b]0;x\u0007;rm -rf ~";
  world.omp = [
    {
      daemons: [
        { name: "\u001b[2Jsvc", id: "1", state: "running", pid: 999, owner: OMP_ID, command: "curl secret-token" },
      ],
    },
  ];
  box.world(world);

  const result = await box.run(["--apply"]);
  const status = await box.status();

  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
  for (const text of [result.out, result.err, JSON.stringify(status)]) {
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("secret-token");
  }
  const invoked = box.calls().join("\n");
  for (const hostile of ["rm -rf", "forwarded", "evil.sock", "escape"]) {
    expect(invoked).not.toContain(hostile);
  }
  const ignored = status.sessions.filter((session: { name: string }) => session.name !== "default");
  expect(ignored.every((session: { affected: boolean; note?: string }) => !session.affected && session.note)).toBe(
    true,
  );
});

test.each([
  [
    "a Claude reference climbing out of the projects tree",
    "w1:p2",
    { agent: "claude", kind: "id", value: "../../../etc/passwd" },
  ],
  ["an OMP reference to a file that is not a session", "w1:p1", { agent: "omp", kind: "path", value: "/etc/passwd" }],
  ["an OMP reference with parent segments", "w1:p1", { agent: "omp", kind: "path", value: "/tmp/../etc/x.jsonl" }],
  ["a reference of the wrong kind", "w1:p2", { agent: "claude", kind: "path", value: CLAUDE_ID }],
  ["a reference for another agent", "w1:p2", { agent: "omp", kind: "id", value: CLAUDE_ID }],
])("%s is refused", async (_name, target, ref) => {
  const box = restartable();
  const world = before(box);
  pane(world, target).ref = ref;
  const argv = pane(world, target).foreground?.[0];
  if (argv) argv.argv = [argv.name];
  box.world(world);

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
});

test("a session file that is a symlink is not followed", async () => {
  const box = restartable();
  const elsewhere = join(box.home, "elsewhere.jsonl");
  writeText(elsewhere, readFileSync(box.ompSession, "utf8"));
  rmSync(box.ompSession);
  symlinkSync(elsewhere, box.ompSession);

  const status = await box.status();

  expect(status.sessions[0].ready).toBe(false);
});

test("a malformed recovery record blocks its session and runs nothing", async () => {
  const box = restartable();
  writeText(box.recoveryFile("default"), { session: "other", server: { pid: 1, started: "x" }, panes: [] });

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(3);
  expect(result.asked).toBe(0);
  expect(box.stops()).toEqual([]);
  expect(box.attaches()).toEqual([]);
});

const lockFile = (box: Box) => join(box.home, ".local/state/tool-restart/apply.lock");

test("a second --apply is refused while the first waits for approval, and runs once the first ends", async () => {
  const box = restartable();
  let inner: Awaited<ReturnType<Box["run"]>> | undefined;

  const outer = await box.run(["--apply"], {
    answer: "no",
    beforeAnswer: async () => {
      inner = await box.run(["--apply"]);
    },
  });

  expect(outer.asked).toBe(1);
  expect(inner?.code).toBe(1);
  expect(inner?.asked).toBe(0);
  expect(box.stops()).toEqual([]);
  expect((await box.run(["--apply"], { answer: "no" })).asked).toBe(1);
});

test.each([
  ["empty, as a crash mid-write leaves it", ""],
  ["half-written", '{"pid":'],
  ["naming a live process, as an older version wrote it", JSON.stringify({ pid: 100, started: "x" })],
])("a lock file that is %s decides nothing and survives the run", async (_name, content) => {
  const box = restartable();
  writeText(lockFile(box), content);

  const result = await box.run(["--apply"], { answer: "no" });

  expect(result.asked).toBe(1);
  expect(readFileSync(lockFile(box), "utf8")).toBe(content);
});

test("a lock path that is a symlink is refused and its target left alone", async () => {
  const box = restartable();
  const target = join(box.home, "elsewhere");
  writeText(target, "keep");
  mkdirSync(dirname(lockFile(box)), { recursive: true });
  symlinkSync(target, lockFile(box));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(1);
  expect(result.asked).toBe(0);
  expect(readFileSync(target, "utf8")).toBe("keep");
});

test.each([
  ["a parent missing from the process table", () => [], 7777],
  ["a cycle", () => [{ pid: 800, ppid: process.pid, name: "sh" }], 800],
])("--apply under a process chain cut short by %s is refused", async (_name, procs, parent) => {
  const box = restartable();
  const world = before(box);
  world.procs.push(...procs());
  box.world(world);
  writeText(join(box.stub, "self-ppid"), String(parent));

  const result = await box.run(["--apply"]);

  expect(result.code).toBe(1);
  expect(result.asked).toBe(0);
  expect(box.stops()).toEqual([]);
});

test("--apply under a complete chain to init that holds no Herdr goes ahead", async () => {
  const box = restartable();
  const world = before(box);
  world.procs.push({ pid: 801, ppid: 800, name: "login" }, { pid: 800, ppid: 1, name: "Terminal" });
  box.world(world);
  writeText(join(box.stub, "self-ppid"), "801");

  expect((await box.run(["--apply"], { answer: "no" })).asked).toBe(1);
});

test("--notify alerts again when a newer version arrives while the same old process runs", async () => {
  const box = setup();
  box.installVersion("omp", "3.0.0");
  box.world(before(box));
  const notes = () => box.calls().filter((call) => call.startsWith("terminal-notifier"));

  await box.run(["--notify"]);
  await box.run(["--notify"]);
  expect(notes()).toHaveLength(1);

  box.useInstalled("omp", "3.0.0");
  await box.run(["--notify"]);
  expect(notes()).toHaveLength(2);
  expect(notes()[1]).toContain("1.0.0→3.0.0");

  await box.run(["--notify"]);
  expect(notes()).toHaveLength(2);
});

const VOIDING_CHANGES: [string, (box: Box) => void][] = [
  ["the update it was for was rolled back", (box) => box.useInstalled("omp", "1.0.0")],
  ["a newer version was installed instead", (box) => box.useInstalled("omp", "3.0.0")],
  [
    "native restore was turned off",
    (box) => writeText(join(box.home, ".config/herdr/config.toml"), "[session]\nresume_agents_on_restore = false\n"),
  ],
  [
    "the update was rolled back and native restore turned off",
    (box) => {
      box.useInstalled("omp", "1.0.0");
      writeText(join(box.home, ".config/herdr/config.toml"), "[session]\nresume_agents_on_restore = false\n");
    },
  ],
];

test.each(VOIDING_CHANGES)("approval is void when %s while it was pending", async (_name, change) => {
  const box = setup();
  box.installVersion("omp", "1.0.0");
  box.installVersion("omp", "3.0.0");
  box.world(before(box));
  box.afterStop(stopped());
  box.afterAttach(restored(box));

  const result = await box.run(["--apply"], { beforeAnswer: () => change(box) });

  expect(result.asked).toBe(1);
  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
  expect(box.attaches()).toEqual([]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
});

// A new file takes over the path while the old one still exists, so its inode is certain to differ.
const replaceInPlace = (file: string) => `cp "${file}" "${file}.new" && mv "${file}.new" "${file}"`;

// The stub for each tool's version check runs in turn, so these land after `omp --version` has answered.
const INSTALL_CHANGES: [string, (box: Box) => string][] = [
  ["rolled back to the running version", (box) => `ln -sfn "${box.exe("omp", "1.0.0")}" "${box.bin}/omp"`],
  ["moved on to a newer version", (box) => `ln -sfn "${box.exe("omp", "3.0.0")}" "${box.bin}/omp"`],
  ["replaced in place", (box) => replaceInPlace(box.exe("omp"))],
  ["removed", (box) => `rm -f "${box.bin}/omp"`],
];

test.each(INSTALL_CHANGES)(
  "nothing stops when the approved update is %s during a later check",
  async (_name, change) => {
    const box = setup();
    box.installVersion("omp", "1.0.0");
    box.installVersion("omp", "3.0.0");
    box.world(before(box));
    box.afterStop(stopped());
    box.afterAttach(restored(box));

    const result = await box.run(["--apply"], { beforeAnswer: () => box.runOn("grok --version", change(box)) });

    expect(result.asked).toBe(1);
    expect(result.code).toBe(3);
    expect(box.stops()).toEqual([]);
    expect(box.attaches()).toEqual([]);
    expect(existsSync(box.recoveryFile("default"))).toBe(false);
  },
);

test.each([
  ["its status can no longer be read", (box: Box) => writeText(join(box.stub, "current/sheprd-status.code"), "1")],
  ["a newer Sheprd was installed", (box: Box) => writeText(join(box.stub, "sheprd-version"), "3.0.0")],
  ["the update was rolled back", (box: Box) => writeText(join(box.stub, "sheprd-version"), "1.0.0")],
  [
    "the installed bundle is replaced during a later check",
    (box: Box) => box.runOn("sheprd status --json", replaceInPlace(box.exe("sheprd"))),
  ],
  ["its executable can no longer be mapped", (box: Box) => box.world(guiRunning(box, { exe: undefined }))],
  ["its mapped executable was replaced", (box: Box) => box.world(guiRunning(box, { inode: "999" }))],
])("a GUI approved for restart is not quit when %s", async (_name, change) => {
  const box = setup();
  guiOnly(box);

  const result = await box.run(["--apply"], { beforeAnswer: () => change(box) });

  expect(result.asked).toBe(1);
  expect(box.calls()).not.toContain("sheprd app quit --json");
  expect(box.calls().filter((call) => call.startsWith("open"))).toEqual([]);
});

test.each([
  ["a slow version check", "claude --version"],
  ["the read of OMP's services", "omp ps list --all --json"],
  ["the read of native pane state", "herdr api snapshot"],
])(
  "a job that starts during %s after approval stops nothing",
  async (_name, call) => {
    const box = restartable();
    const changed = before(box);
    changed.procs.push({ pid: 205, ppid: 201, pgid: 201, name: "python", command: "python train.py" });

    const result = await box.run(["--apply"], { beforeAnswer: () => box.mutateOn(call, changed) });

    expect(result.code).toBe(3);
    expect(box.stops()).toEqual([]);
    expect(existsSync(box.recoveryFile("default"))).toBe(false);
  },
  30_000,
);

// Each change lands after approval and before the last read of what it touches, which alone notices it.
const SERVICES = "omp ps list --all --json";
const LAST_PANE_PROCESSES = "herdr pane process-info --pane w1:p3";
const LATE_CHANGES: [string, string, (world: FakeWorld, box: Box) => void][] = [
  ["an agent starts working", SERVICES, (world) => void (pane(world, "w1:p2").status = "working")],
  [
    "an agent starts waiting for approval",
    LAST_PANE_PROCESSES,
    (world) => void (pane(world, "w1:p2").status = "blocked"),
  ],
  ["an agent worked and went idle again", SERVICES, (world) => void (pane(world, "w1:p2").stateSeq = 2)],
  ["an agent begins launching", SERVICES, (world) => void (pane(world, "w1:p2").launchPending = true)],
  ["a restore reports an error", SERVICES, (world) => void (pane(world, "w1:p2").restoreError = "boom")],
  [
    "this conversation starts a detached service",
    LAST_PANE_PROCESSES,
    (world) => {
      world.omp = [{ daemons: [{ name: "svc", id: "1", state: "running", pid: 999, owner: OMP_ID }] }];
    },
  ],
  [
    "the agent's executable mapping changes",
    SERVICES,
    (world, box) => void (proc(world, 201).exe = box.exe("omp", "1.5.0")),
  ],
  ["the agent's executable mapping disappears", SERVICES, (world) => void delete proc(world, 201).exe],
  [
    "another server takes over the socket",
    SERVICES,
    (world, box) => {
      world.procs.push({ pid: 150, ppid: 1, name: "herdr", exe: box.exe("herdr") });
      for (const session of world.sessions) session.serverPid = 150;
    },
  ],
  [
    "a configured server execs another script under the same pid and interpreter",
    SERVICES,
    (world) => {
      const entry = pane(world, "w1:p1").foreground?.[1];
      if (entry) entry.argv = ["node", "job.js"];
    },
  ],
  [
    "the agent execs itself with other arguments it would still be allowed to have",
    SERVICES,
    (world, box) => {
      const entry = pane(world, "w1:p1").foreground?.[0];
      if (entry) entry.argv = ["omp", "--allow-home", `--resume=${box.ompSession}`];
    },
  ],
  ["a configured server moves to its own process group", SERVICES, (world) => void (proc(world, 202).pgid = 202)],
  ["a configured server is handed to another parent", SERVICES, (world) => void (proc(world, 202).ppid = 200)],
];

test.each(LATE_CHANGES)("nothing stops when %s during `%s` after approval", async (_name, call, change) => {
  const box = restartable();
  const changed = before(box);
  change(changed, box);

  const result = await box.run(["--apply"], { beforeAnswer: () => box.mutateOn(call, changed) });

  expect(result.asked).toBe(1);
  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
});

test.each([
  [
    "a Grok leader starts",
    LAST_PANE_PROCESSES,
    useGrok,
    (world: FakeWorld) => void (world.grokLeaders = [{ id: "x" }]),
  ],
  [
    "the shared Codex daemon goes old",
    "claude --version",
    useCodex,
    (world: FakeWorld) => void (world.codexDaemon = { cliVersion: "2.0.0", appServerVersion: "1.0.0" }),
  ],
] as const)("nothing stops when %s during `%s` after approval", async (_name, call, useAgent, change) => {
  const box = restartable();
  const withAgent = () => {
    const world = before(box);
    useAgent(world, box);
    return world;
  };
  box.world(withAgent());
  const changed = withAgent();
  change(changed);

  const result = await box.run(["--apply"], { beforeAnswer: () => box.mutateOn(call, changed) });

  expect(result.asked).toBe(1);
  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
});

const OWNED_SERVICE = [{ daemons: [{ name: "svc", id: "1", state: "running", pid: 999, owner: OMP_ID }] }];
const OLD_DAEMON = { cliVersion: "2.0.0", appServerVersion: "1.0.0" };

// Reading an agent's MCP configuration is part of the work done before the last look, so what it is
// waiting on must not be what the decision trusts.
const DURING_CONFIG_READ: [string, string, (world: FakeWorld, box: Box) => void, (world: FakeWorld) => void][] = [
  ["this conversation starts a detached service", ".claude.json", () => undefined, (w) => void (w.omp = OWNED_SERVICE)],
  ["OMP's services can no longer be listed", ".claude.json", () => undefined, (w) => void (w.omp = "not json")],
  ["a Grok leader starts", ".grok/config.toml", useGrok, (w) => void (w.grokLeaders = [{ id: "x" }])],
  ["Grok's leaders can no longer be listed", ".grok/config.toml", useGrok, (w) => void (w.grokLeaders = "not json")],
  ["the shared Codex daemon goes old", ".codex/config.toml", useCodex, (w) => void (w.codexDaemon = OLD_DAEMON)],
  ["the shared Codex daemon can no longer be read", ".codex/config.toml", useCodex, (w) => void (w.codexDaemon = "")],
];

test.each(DURING_CONFIG_READ)(
  "nothing stops when %s while `%s` is being read after approval",
  async (_name, file, useAgent, change) => {
    const box = restartable();
    const withAgent = () => {
      const world = before(box);
      useAgent(world, box);
      return world;
    };
    box.world(withAgent());
    const changed = withAgent();
    change(changed);

    const result = await box.run(["--apply"], {
      beforeAnswer: () => box.mutateDuringRead(join(box.home, file), changed),
    });

    expect(result.asked).toBe(1);
    expect(result.code).toBe(3);
    expect(box.stops()).toEqual([]);
    expect(existsSync(box.recoveryFile("default"))).toBe(false);
  },
);

test("reading configuration during which nothing changes still restarts the session", async () => {
  const box = restartable();

  const result = await box.run(["--apply"], {
    beforeAnswer: () => box.mutateDuringRead(join(box.home, ".claude.json"), before(box)),
  });

  expect(result.code).toBe(0);
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
});

test("nothing stops when a pane's process list can no longer be read after approval", async () => {
  const box = restartable();
  const processInfo = join(box.stub, "current/herdr/pi_w1_p1.json");

  const result = await box.run(["--apply"], { beforeAnswer: () => box.runOn(SERVICES, `rm -f "${processInfo}"`) });

  expect(result.asked).toBe(1);
  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
});

// A read this late would come after the inventories, so the service it stands for would go unseen.
test.each([
  ["a pane beside the stale one, which keeps the session affected", "pi_w1_p2.json"],
  ["the only stale pane, which leaves nothing looking affected", "pi_w1_p1.json"],
])(
  "nothing stops and no file is read late when the process list of %s is back only for the last look",
  async (_name, file) => {
    const box = restartable();
    const processInfo = join(box.stub, "current/herdr", file);
    const hidden = `${processInfo}.hidden`;
    const config = join(box.home, ".claude.json");
    const withService = before(box);
    withService.omp = OWNED_SERVICE;

    const result = await box.run(["--apply"], {
      beforeAnswer: () => {
        renameSync(processInfo, hidden);
        box.runOn(SERVICES, `mv "${hidden}" "${processInfo}"`);
        box.mutateDuringRead(config, withService);
      },
    });

    expect(result.asked).toBe(1);
    expect(result.code).toBe(3);
    expect(box.stops()).toEqual([]);
    expect(existsSync(box.recoveryFile("default"))).toBe(false);
    // The report after the run opens with its own version checks, and only that report may read the file.
    const calls = box.calls();
    expect(calls.indexOf(`opened ${config}`)).toBeGreaterThan(calls.lastIndexOf("omp --version"));
  },
);

test("nothing stops when a directory missing during the preparation is back for the last look", async () => {
  const box = restartable();
  const away = `${box.work}.away`;

  const result = await box.run(["--apply"], {
    beforeAnswer: () => {
      renameSync(box.work, away);
      box.runOn(SERVICES, `mv "${away}" "${box.work}"`);
    },
  });

  expect(result.asked).toBe(1);
  expect(result.code).toBe(3);
  expect(box.stops()).toEqual([]);
  expect(existsSync(box.recoveryFile("default"))).toBe(false);
});

test("a recovery record keeps conversation references but no argument lists", async () => {
  const box = restartable(3);
  const bad = restored(box);
  pane(bad, "w1:p2").terminalId = "t2";
  box.afterAttach(bad);

  expect((await box.run(["--apply"])).code).toBe(1);

  const record = readFileSync(box.recoveryFile("default"), "utf8");
  expect(record).toContain(CLAUDE_ID);
  expect(record).not.toContain("--allow-home");
  expect(record).not.toContain("server.js");
}, 30_000);

test("the report names an identified helper without its arguments or configured secrets", async () => {
  const box = setup();
  const world = before(box);
  configureTool(box);
  inForeground(world, "w1:p2", toolChild(box), TOOL_ARGV);
  box.world(world);

  const status = await box.status();
  const report = await box.run(["--status"]);

  expect(status.sessions[0].helpers).toContain("tool");
  for (const text of [JSON.stringify(status), report.out, report.err]) {
    expect(text).not.toContain("--flag");
    expect(text).not.toContain("env-secret");
  }
});

test("the saved Grok summary stays out of the report", async () => {
  const box = setup();
  const world = before(box);
  useGrok(world, box);
  box.world(world);

  const status = await box.status();

  expect(status.sessions[0].ready).toBe(true);
  expect(JSON.stringify(status)).not.toContain("private summary");
});

test("an inherited session target is never passed on", async () => {
  const box = restartable();

  const result = await box.run(["--status", "--json"], {
    env: { HERDR_SOCKET_PATH: "/tmp/other.sock", HERDR_PANE_ID: "w0:p0" },
  });

  expect(box.calls()).not.toContain("leaked");
  expect(JSON.parse(result.out).sessions[0].panes).toBe(3);
});

const script = resolve(import.meta.dir, "tool-restart");

test("the command asks on a real terminal and restarts after yes", async () => {
  const box = restartable();
  symlinkSync(process.execPath, join(box.bin, "bun"));
  let output = "";
  let answered = false;

  const child = Bun.spawn([script, "--apply"], {
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, STUB: box.stub },
    terminal: {
      cols: 120,
      rows: 40,
      data(terminal, data) {
        output += Buffer.from(data).toString();
        if (answered || !output.includes("yes")) return;
        answered = true;
        terminal.write("yes\n");
      },
    },
  });

  expect(await child.exited).toBe(0);
  expect(box.stops()).toEqual(["herdr session stop default --json"]);
}, 60_000);

test("a killed --apply leaves no lock behind", async () => {
  const box = restartable();
  symlinkSync(process.execPath, join(box.bin, "bun"));
  const atPrompt = Promise.withResolvers<void>();
  let output = "";
  const child = Bun.spawn([script, "--apply"], {
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, STUB: box.stub },
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        output += Buffer.from(data).toString();
        if (output.includes("yes")) atPrompt.resolve();
      },
    },
  });
  await atPrompt.promise;

  expect((await box.run(["--apply"])).asked).toBe(0);

  child.kill("SIGKILL");
  await child.exited;

  expect((await box.run(["--apply"], { answer: "no" })).asked).toBe(1);
  expect(box.stops()).toEqual([]);
}, 60_000);

test("the command refuses a piped yes", () => {
  const box = restartable();
  symlinkSync(process.execPath, join(box.bin, "bun"));

  const child = Bun.spawnSync([script, "--apply"], {
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, STUB: box.stub },
    stdin: Buffer.from("yes\n"),
  });

  expect(child.exitCode).toBe(1);
  expect(box.stops()).toEqual([]);
}, 30_000);
