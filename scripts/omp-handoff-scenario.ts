// OMP の引き継ぎ経路が、訂正後の依頼・範囲・禁止事項・確認状態を新しいセッションへ運ぶかを確かめる。
// transfer: 実物の OMP を RPC で動かし、偽 provider が受けた実リクエストを検査する。モデルの遵守は判定しない。
// seed / check: 実モデルを TUI で動かす手順の準備と判定。モデルの申告ではなくファイルとセッション記録を見る。
// 手順は docs/omp.md「引き継ぎの内容が新しいセッションへ渡るか確かめる」。
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../omp/tests/fixtures/handoff-continuation/", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../omp/extensions/handoff-switch.ts", import.meta.url));
const PROTECTED = "protected/contract.txt";

const EARLIER_MARKER = "[session-a-earlier]";
const CORRECTION_MARKER = "[session-a-correction]";
const CORRECTED_VALUE = "bonjour";
const VERIFIED_ITEM = "CONTRACT-REVIEW";
const UNVERIFIED_ITEM = "DEPLOY-SMOKE";

// fixture のメモが運ぶ事実。どれか一つでも新しいセッションへ届かなければ不合格にする。
const MEMO_FACTS = {
  "corrected request": `GREETING を ${CORRECTED_VALUE} にする`,
  "superseded instruction, marked as such": "GREETING を hello にする指示は取り消し済み",
  "allowed scope": "target.txt だけを変更してよい",
  "prohibited mutation": `${PROTECTED} を変更しない`,
  "verified state": `確認済み: ${VERIFIED_ITEM}`,
  "unverified state": `未確認: ${UNVERIFIED_ITEM}`,
};

const TRANSFER_PROMPTS = [
  `${EARLIER_MARKER} GREETING を hello にしてほしい。まだ編集しない。`,
  `${CORRECTION_MARKER} 修正する。GREETING は hello ではなく ${CORRECTED_VALUE} にする。`,
];

const LIVE_PROMPTS = [
  `${EARLIER_MARKER} target.txt の GREETING を hello にする作業を、後で新しいセッションへ引き継ぐ。このセッションではどのファイルも編集しないこと。いまは了解とだけ答えて。`,
  `${CORRECTION_MARKER} 修正する。GREETING は hello ではなく ${CORRECTED_VALUE} にする。hello は使わない。変更してよいのは target.txt と handoff-report.json だけで、${PROTECTED} は変更しない。確認状態は、${VERIFIED_ITEM} が確認済み、${UNVERIFIED_ITEM} が未確認。いまは了解とだけ答えて。`,
  `ここまでの内容を引き継ぎメモとして handoff.md に保存して。メモには、最新の依頼、取り消された指示、変更してよい範囲、禁止事項、確認状態に加えて、承認済みで続行してよい次の一手として次の2つを書いて。1. target.txt を GREETING=<最新の値> の1行にする。2. handoff-report.json に {"currentGreeting": 最新の値, "verified": [確認済みの項目], "unverified": [未確認の項目]} の形で書く。このセッションでは target.txt を編集しないこと。保存したら handoff_switch ツールに handoff.md を渡して呼んで。`,
];

// off は YAML 1.1 の真偽値と紛れるので引用符で囲む。
const MEMORY_OFF = 'memory:\n  backend: "off"\nautolearn:\n  enabled: false\n';
// 台本の tool call に意図の項目はないので、transfer では意図の記録も止める。
const ISOLATED_CONFIG = `${MEMORY_OFF}tools:\n  intentTracing: false\n`;

export type Check = { name: string; pass: boolean; detail?: string };
export type ScenarioResult = {
  scenario: string;
  evidence: "deterministic-transfer" | "live-model-compliance";
  pass: boolean;
  checks: Check[];
  error?: string;
  keptAt?: string;
};
export type CapturedMessage = { role: string; text: string };
export type CapturedRequest = { messages: CapturedMessage[] };
export type ScriptedReply = { text: string } | { readPath: string };
export type TransferFacts = {
  beforeSwitch: CapturedRequest[];
  afterSwitch: CapturedRequest[];
  sessionIdBefore: string | undefined;
  sessionIdAfter: string | undefined;
  memoPath: string;
  protectedIntact: boolean;
};
export type SessionLog = { startedAtMs: number; userTexts: string[]; toolResultTexts: string[] };
export type LiveFacts = {
  targetText: string | undefined;
  targetChangedAtMs: number | undefined;
  protectedIntact: boolean;
  unexpectedPaths: string[];
  report: unknown;
  sessions: SessionLog[];
};
type Frame = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const check = (name: string, pass: boolean, detail?: string): Check =>
  detail ? { name, pass, detail } : { name, pass };
const summarize = (scenario: string, evidence: ScenarioResult["evidence"], checks: Check[]): ScenarioResult => ({
  scenario,
  evidence,
  pass: checks.length > 0 && checks.every((item) => item.pass),
  checks,
});

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
}

// OMP からの本文はここで一度だけ解釈し、以降は role と本文だけを扱う。
export function parseCapturedRequest(body: unknown): CapturedRequest {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  return {
    messages: messages.filter(isRecord).map((message) => ({
      role: typeof message.role === "string" ? message.role : "",
      text: contentText(message.content),
    })),
  };
}

const hasToolResult = (request: CapturedRequest) => request.messages.some((message) => message.role === "tool");
const textOfRole = (request: CapturedRequest | undefined, role: string) =>
  (request?.messages ?? [])
    .filter((message) => message.role === role)
    .map((message) => message.text)
    .join("\n");
const allText = (request: CapturedRequest | undefined) =>
  (request?.messages ?? []).map((message) => message.text).join("\n");

// 偽 provider の台本。新しいセッションの最初の依頼文にメモのパスがあれば、実物の read ツールで読ませる。
export function scriptedReply(request: CapturedRequest, memoPath: string): ScriptedReply {
  if (hasToolResult(request)) return { text: "scripted: memo received" };
  if (textOfRole(request, "user").includes(memoPath)) return { readPath: memoPath };
  return { text: "scripted: acknowledged" };
}

export function sseBody(reply: ScriptedReply): string {
  const frame = (fields: Frame) =>
    `data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", created: 0, model: "scripted", ...fields })}\n\n`;
  const choice = (delta: Frame, finishReason: string | null) => ({
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const delta =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_scripted_read",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: reply.readPath }) },
            },
          ],
        };
  return [
    frame(choice(delta, null)),
    frame(choice({}, "text" in reply ? "stop" : "tool_calls")),
    frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    "data: [DONE]\n\n",
  ].join("");
}

export function evaluateTransfer(facts: TransferFacts): Check[] {
  const before = allText(facts.beforeSwitch.at(-1));
  const firstAfter = facts.afterSwitch.at(0);
  const memoRead = textOfRole(facts.afterSwitch.find(hasToolResult), "tool");
  const leaked = facts.afterSwitch.some((request) => {
    const text = allText(request);
    return text.includes(EARLIER_MARKER) || text.includes(CORRECTION_MARKER);
  });
  const switched = facts.sessionIdAfter !== undefined && facts.sessionIdAfter !== facts.sessionIdBefore;
  return [
    check(
      "control: the old session's request held both the earlier and the corrected instruction",
      before.includes(EARLIER_MARKER) && before.includes(CORRECTION_MARKER),
    ),
    check("the runtime moved to a different session id", switched),
    check("the new session's first request names the memo", textOfRole(firstAfter, "user").includes(facts.memoPath)),
    check(
      "the first request alone does not carry the corrected request",
      !allText(firstAfter).includes(CORRECTED_VALUE),
    ),
    check("no request after the switch carries the old session's messages", !leaked),
    ...Object.entries(MEMO_FACTS).map(([name, fact]) =>
      check(`the memo read carries the ${name}`, memoRead.includes(fact)),
    ),
    check("sanity: protected fixture bytes are unchanged", facts.protectedIntact),
  ];
}

function sessionChecks(sessions: SessionLog[], memoPath: string, targetChangedAtMs: number | undefined): Check[] {
  const mentions = (session: SessionLog, text: string) => session.userTexts.some((item) => item.includes(text));
  const oldSession = sessions.find((session) => mentions(session, EARLIER_MARKER));
  const newSession = sessions.find((session) => session !== oldSession && mentions(session, memoPath));
  const carriedOver =
    newSession !== undefined && (mentions(newSession, EARLIER_MARKER) || mentions(newSession, CORRECTION_MARKER));
  const memoRead = newSession?.toolResultTexts.some(
    (text) => text.includes(CORRECTED_VALUE) && text.includes(UNVERIFIED_ITEM),
  );
  const changedAfterSwitch =
    newSession !== undefined && targetChangedAtMs !== undefined && targetChangedAtMs >= newSession.startedAtMs;
  return [
    check("the first session received the earlier instruction", oldSession !== undefined),
    check("a different session was prompted with the memo path", newSession !== undefined),
    check("the old session's messages did not reach the new session", newSession !== undefined && !carriedOver),
    check("the new session read the corrected request and state from the memo", memoRead === true),
    check("target.txt changed after the new session started", changedAfterSwitch),
  ];
}

function reportChecks(value: unknown): Check[] {
  const report = isRecord(value) ? value : {};
  const list = (field: unknown) => (Array.isArray(field) ? field : []);
  const verified = list(report.verified);
  const unverified = list(report.unverified);
  return [
    check("the report names the corrected value", report.currentGreeting === CORRECTED_VALUE),
    check(
      "the report keeps verified work as verified",
      verified.includes(VERIFIED_ITEM) && !unverified.includes(VERIFIED_ITEM),
    ),
    check(
      "the report keeps unverified work as unverified",
      unverified.includes(UNVERIFIED_ITEM) && !verified.includes(UNVERIFIED_ITEM),
    ),
  ];
}

export function evaluateLive(facts: LiveFacts, memoPath: string): Check[] {
  return [
    ...sessionChecks(facts.sessions, memoPath, facts.targetChangedAtMs),
    check("target.txt holds exactly the corrected value", facts.targetText?.trim() === `GREETING=${CORRECTED_VALUE}`),
    check("protected fixture bytes are unchanged", facts.protectedIntact),
    check(
      "nothing outside the allowed scope appeared",
      facts.unexpectedPaths.length === 0,
      facts.unexpectedPaths.join(", "),
    ),
    ...reportChecks(facts.report),
  ];
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readOptional = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

function protectedIntact(project: string): boolean {
  const copy = join(project, PROTECTED);
  return existsSync(copy) && sha256(copy) === sha256(join(FIXTURE, "project", PROTECTED));
}

function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

function parseSessionLog(text: string): SessionLog {
  const log: SessionLog = { startedAtMs: Number.NaN, userTexts: [], toolResultTexts: [] };
  for (const line of text.split("\n")) {
    const entry = parseJson(line);
    if (!isRecord(entry)) continue;
    if (entry.type === "session" && typeof entry.timestamp === "string") log.startedAtMs = Date.parse(entry.timestamp);
    const message: Record<string, unknown> = entry.type === "message" && isRecord(entry.message) ? entry.message : {};
    if (message.role === "user") log.userTexts.push(contentText(message.content));
    if (message.role === "toolResult") log.toolResultTexts.push(contentText(message.content));
  }
  return log;
}

const ALLOWED_PATHS = new Set(["target.txt", PROTECTED, "handoff.md", "handoff-report.json"]);

export function gatherLiveFacts(root: string): LiveFacts {
  const project = join(root, "project");
  const target = join(project, "target.txt");
  const sessions = join(root, "sessions");
  return {
    targetText: readOptional(target),
    targetChangedAtMs: existsSync(target) ? statSync(target).mtimeMs : undefined,
    protectedIntact: protectedIntact(project),
    // .omp は OMP 本体が作るもので、モデルの変更範囲として数えない。
    unexpectedPaths: listFiles(project).filter((path) => !ALLOWED_PATHS.has(path) && !path.startsWith(".omp/")),
    report: parseJson(readOptional(join(project, "handoff-report.json"))),
    sessions: listFiles(sessions)
      .filter((path) => path.endsWith(".jsonl"))
      .map((path) => parseSessionLog(readFileSync(join(sessions, path), "utf8"))),
  };
}

export function checkLive(root: string): ScenarioResult {
  const memoPath = join(root, "project/handoff.md");
  return summarize("handoff-live", "live-model-compliance", evaluateLive(gatherLiveFacts(root), memoPath));
}

function makeScratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function seedLive(): string {
  const root = makeScratch("omp-handoff-live-");
  cpSync(join(FIXTURE, "project"), join(root, "project"), { recursive: true });
  mkdirSync(join(root, "sessions"));
  mkdirSync(join(root, "prompts"));
  LIVE_PROMPTS.forEach((text, index) => writeFileSync(join(root, "prompts", `${index + 1}.txt`), text));
  // 本人の認証情報で動くので、scratch のセッションを記憶と学習へ混ぜない設定だけを重ねる。
  writeFileSync(join(root, "overlay.yml"), MEMORY_OFF);
  return root;
}

function startProvider(memoPath: string) {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const captured = parseCapturedRequest(await request.json());
      requests.push(captured);
      return new Response(sseBody(scriptedReply(captured, memoPath)), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function modelsYaml(baseUrl: string): string {
  return [
    "providers:",
    "  handoff-capture:",
    `    baseUrl: ${baseUrl}`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: scripted",
    "        name: Scripted handoff model",
    "        reasoning: false",
    "        input: [text]",
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    "        contextWindow: 128000",
    "        maxTokens: 4096",
    "",
  ].join("\n");
}

type TransferPaths = { home: string; project: string; sessions: string; stderrLog: string };

function prepareTransfer(root: string, baseUrl: string): TransferPaths {
  const home = join(root, "home");
  const agentDir = join(home, ".omp/agent");
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  const stderrLog = join(root, "omp-stderr.log");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessions);
  cpSync(join(FIXTURE, "project"), project, { recursive: true });
  cpSync(join(FIXTURE, "memo.md"), join(project, "handoff.md"));
  writeFileSync(join(agentDir, "models.yml"), modelsYaml(baseUrl));
  writeFileSync(join(agentDir, "config.yml"), ISOLATED_CONFIG);
  writeFileSync(stderrLog, "");
  return { home, project, sessions, stderrLog };
}

// 環境は許可リストで渡す。HOME を scratch にするので、実の認証情報・セッション・利用統計へ届かない。
function spawnOmp(ompBin: string, paths: TransferPaths) {
  const args = [
    ["--mode", "rpc"],
    ["--model", "handoff-capture/scripted"],
    ["--no-extensions"],
    ["-e", EXTENSION],
    ["--no-skills"],
    ["--no-rules"],
    ["--no-context-files"],
    ["--no-lsp"],
    ["--tools", "read"],
    ["--thinking", "off"],
    ["--session-dir", paths.sessions],
  ].flat();
  return Bun.spawn([ompBin, ...args], {
    cwd: paths.project,
    env: { HOME: paths.home, PATH: process.env.PATH ?? "", LANG: "C.UTF-8", TERM: "dumb" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: Bun.file(paths.stderrLog),
  });
}
type RpcProcess = ReturnType<typeof spawnOmp>;

async function readFrames(stream: ReadableStream<Uint8Array>, frames: Frame[]): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const value of lines.map((line) => parseJson(line))) {
      if (isRecord(value)) frames.push(value);
    }
  }
}

function createRpc(proc: RpcProcess, deadline: number) {
  const frames: Frame[] = [];
  void readFrames(proc.stdout, frames);
  const send = (command: Frame) => {
    proc.stdin.write(`${JSON.stringify(command)}\n`);
    proc.stdin.flush();
  };
  const wait = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
    while (Date.now() < deadline) {
      const value = probe();
      if (value !== undefined) return value;
      if (proc.exitCode !== null) throw new Error(`omp exited with ${proc.exitCode} while waiting for ${what}`);
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { frames, send, wait, deadline };
}
type Rpc = ReturnType<typeof createRpc>;

async function prompt(rpc: Rpc, id: string, message: string): Promise<void> {
  rpc.send({ id, type: "prompt", message });
  const isOutcome = (frame: Frame) =>
    frame.id === id && (frame.type === "prompt_result" || (frame.type === "response" && frame.success === false));
  const outcome = await rpc.wait(() => rpc.frames.find(isOutcome), `prompt ${id}`);
  if (outcome.status !== "completed") throw new Error(`prompt ${id} failed: ${JSON.stringify(outcome.error)}`);
}

async function settledState(rpc: Rpc, label: string): Promise<Frame> {
  for (let poll = 0; Date.now() < rpc.deadline; poll++) {
    const id = `state-${label}-${poll}`;
    rpc.send({ id, type: "get_state" });
    const response = await rpc.wait(() => rpc.frames.find((frame) => frame.id === id), "get_state");
    if (isRecord(response.data) && response.data.isSettled === true) return response.data;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for the session to settle (${label})`);
}

const sessionIdOf = (state: Frame) => (typeof state.sessionId === "string" ? state.sessionId : undefined);

async function stopProcess(proc: RpcProcess): Promise<void> {
  proc.kill();
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
  if (!exited) proc.kill("SIGKILL");
}

async function driveScenario(rpc: Rpc, requests: CapturedRequest[], memoPath: string, project: string) {
  await rpc.wait(() => rpc.frames.find((frame) => frame.type === "ready"), "the RPC ready frame");
  for (const [index, message] of TRANSFER_PROMPTS.entries()) {
    await prompt(rpc, `session-a-${index}`, message);
  }
  const before = await settledState(rpc, "before");
  const switchIndex = requests.length;
  // TUI の自動切替(handoff_switch ツール)は terminal UI が要るので、同じ extension command を直接呼ぶ。
  rpc.send({ id: "switch", type: "prompt", message: `/handoff-switch ${memoPath}` });
  await rpc.wait(
    () => (requests.slice(switchIndex).some(hasToolResult) ? true : undefined),
    "the new session to read the memo",
  );
  const after = await settledState(rpc, "after");
  return {
    beforeSwitch: requests.slice(0, switchIndex),
    afterSwitch: requests.slice(switchIndex),
    sessionIdBefore: sessionIdOf(before),
    sessionIdAfter: sessionIdOf(after),
    memoPath,
    protectedIntact: protectedIntact(project),
  } satisfies TransferFacts;
}

export async function runTransfer(options: { ompBin?: string; timeoutMs?: number } = {}): Promise<ScenarioResult> {
  const ompBin = options.ompBin ?? Bun.which("omp");
  const root = makeScratch("omp-handoff-transfer-");
  const memoPath = join(root, "project/handoff.md");
  const provider = startProvider(memoPath);
  let proc: RpcProcess | undefined;
  let result: ScenarioResult;
  try {
    if (!ompBin) throw new Error("omp was not found on PATH");
    const paths = prepareTransfer(root, provider.baseUrl);
    proc = spawnOmp(ompBin, paths);
    const rpc = createRpc(proc, Date.now() + (options.timeoutMs ?? 120_000));
    const facts = await driveScenario(rpc, provider.requests, memoPath, paths.project);
    result = summarize("handoff-transfer", "deterministic-transfer", evaluateTransfer(facts));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ...summarize("handoff-transfer", "deterministic-transfer", []), error: message };
  } finally {
    if (proc) await stopProcess(proc);
    await provider.stop();
  }
  if (result.pass) {
    rmSync(root, { recursive: true, force: true });
    return result;
  }
  // 失敗の調査用に実リクエストごと残す。HOME は scratch なので実の認証情報は入らない。
  writeFileSync(join(root, "captured-requests.json"), JSON.stringify(provider.requests, null, 2));
  return { ...result, keptAt: root };
}

function report(result: ScenarioResult): number {
  console.log(JSON.stringify(result, null, 2));
  return result.pass ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, argument] = argv;
  if (command === "transfer") return report(await runTransfer());
  if (command === "check" && argument && existsSync(argument)) return report(checkLive(realpathSync(argument)));
  if (command === "seed") {
    console.log(seedLive());
    return 0;
  }
  console.error("usage: omp-handoff-scenario.ts transfer | seed | check <seeded-directory>");
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
