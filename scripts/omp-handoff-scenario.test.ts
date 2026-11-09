import { afterAll, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLive,
  evaluateLive,
  evaluateTransfer,
  main,
  parseCapturedRequest,
  runTransfer,
  scriptedReply,
  seedLive,
  sseBody,
  type Check,
  type LiveFacts,
  type ScenarioResult,
  type TransferFacts,
} from "./omp-handoff-scenario";

const MEMO_PATH = "/scratch/project/handoff.md";
const MEMO_FIXTURE = readFileSync(
  new URL("../omp/tests/fixtures/handoff-continuation/memo.md", import.meta.url),
  "utf8",
);
const SWITCH_PROMPT = `引き継ぎメモ ${MEMO_PATH} を読むこと`;

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function kept(result: ScenarioResult): ScenarioResult {
  if (result.keptAt) scratchDirs.push(result.keptAt);
  return result;
}

const failedNames = (checks: Check[]) => checks.filter((item) => !item.pass).map((item) => item.name);

function goodTransfer(): TransferFacts {
  return {
    beforeSwitch: [
      {
        messages: [
          { role: "user", text: "[session-a-earlier] hello にする" },
          { role: "assistant", text: "了解" },
          { role: "user", text: "[session-a-correction] bonjour にする" },
        ],
      },
    ],
    afterSwitch: [
      { messages: [{ role: "user", text: SWITCH_PROMPT }] },
      {
        messages: [
          { role: "user", text: SWITCH_PROMPT },
          { role: "assistant", text: "" },
          { role: "tool", text: `[handoff.md#ABCD]\n${MEMO_FIXTURE}` },
        ],
      },
    ],
    sessionIdBefore: "session-a",
    sessionIdAfter: "session-b",
    memoPath: MEMO_PATH,
    protectedIntact: true,
  };
}

test("accepts a run where the memo alone carries the corrected state into a new session", () => {
  expect(failedNames(evaluateTransfer(goodTransfer()))).toEqual([]);
});

test.each<[string, (facts: TransferFacts) => void, string]>([
  [
    "the memo read lost the corrected request",
    (facts) => {
      facts.afterSwitch[1].messages[2].text = MEMO_FIXTURE.replace("GREETING を bonjour にする", "");
    },
    "corrected request",
  ],
  [
    "the memo read lost the prohibition",
    (facts) => {
      facts.afterSwitch[1].messages[2].text = MEMO_FIXTURE.replace("protected/contract.txt を変更しない", "");
    },
    "prohibited mutation",
  ],
  [
    "the memo read lost the unverified state",
    (facts) => {
      facts.afterSwitch[1].messages[2].text = MEMO_FIXTURE.replace("未確認: DEPLOY-SMOKE", "");
    },
    "unverified state",
  ],
  [
    "the memo read failed, so the tool result holds an error",
    (facts) => {
      facts.afterSwitch[1].messages[2].text = "ENOENT";
    },
    "corrected request",
  ],
  [
    "the memo was never read",
    (facts) => {
      facts.afterSwitch.pop();
    },
    "corrected request",
  ],
  [
    "the new session was never prompted",
    (facts) => {
      facts.afterSwitch = [];
    },
    "names the memo",
  ],
  [
    "the old session's messages leaked into the new session",
    (facts) => {
      facts.afterSwitch[0].messages.unshift({ role: "user", text: "[session-a-earlier] hello にする" });
    },
    "old session's messages",
  ],
  [
    "the prompt itself already holds the corrected value, so a memo read proves nothing",
    (facts) => {
      facts.afterSwitch[0].messages[0].text = `${SWITCH_PROMPT} bonjour`;
    },
    "first request alone",
  ],
  [
    "the runtime stayed on the same session",
    (facts) => {
      facts.sessionIdAfter = facts.sessionIdBefore;
    },
    "different session id",
  ],
  [
    "the session id was not reported",
    (facts) => {
      facts.sessionIdAfter = undefined;
    },
    "different session id",
  ],
  [
    "the old session never saw the correction",
    (facts) => {
      facts.beforeSwitch[0].messages.pop();
    },
    "control",
  ],
  [
    "the protected fixture changed",
    (facts) => {
      facts.protectedIntact = false;
    },
    "protected fixture",
  ],
])("rejects a transfer when %s", (_name, tamper, want) => {
  const facts = goodTransfer();
  tamper(facts);
  expect(failedNames(evaluateTransfer(facts)).join("\n")).toContain(want);
});

function goodLive(): LiveFacts {
  return {
    targetText: "GREETING=bonjour\n",
    targetChangedAtMs: 3000,
    protectedIntact: true,
    unexpectedPaths: [],
    report: { currentGreeting: "bonjour", verified: ["CONTRACT-REVIEW"], unverified: ["DEPLOY-SMOKE"] },
    sessions: [
      {
        startedAtMs: 1000,
        userTexts: ["[session-a-earlier] hello にする", "[session-a-correction] bonjour にする"],
        toolResultTexts: [],
      },
      {
        startedAtMs: 2000,
        userTexts: [SWITCH_PROMPT],
        toolResultTexts: ["GREETING を bonjour にする。未確認: DEPLOY-SMOKE"],
      },
    ],
  };
}

test("accepts a live run whose files and session records show the corrected work", () => {
  expect(failedNames(evaluateLive(goodLive(), MEMO_PATH))).toEqual([]);
});

test.each<[string, Partial<LiveFacts>, string]>([
  ["the model followed the superseded instruction", { targetText: "GREETING=hello\n" }, "exactly the corrected value"],
  ["the target has extra content", { targetText: "GREETING=bonjour\nGREETING=hello\n" }, "exactly the corrected value"],
  ["the target disappeared", { targetText: undefined, targetChangedAtMs: undefined }, "exactly the corrected value"],
  ["the old session made the change itself", { targetChangedAtMs: 1500 }, "changed after the new session"],
  ["the protected fixture changed", { protectedIntact: false }, "protected fixture"],
  ["a file outside the scope appeared", { unexpectedPaths: ["extra.txt"] }, "outside the allowed scope"],
  ["the report is missing", { report: undefined }, "names the corrected value"],
  ["the report names the superseded value", { report: { currentGreeting: "hello" } }, "names the corrected value"],
  [
    "the report claims unverified work as verified",
    {
      report: {
        currentGreeting: "bonjour",
        verified: ["CONTRACT-REVIEW", "DEPLOY-SMOKE"],
        unverified: ["DEPLOY-SMOKE"],
      },
    },
    "keeps unverified work",
  ],
  [
    "the report demotes verified work",
    { report: { currentGreeting: "bonjour", verified: [], unverified: ["CONTRACT-REVIEW", "DEPLOY-SMOKE"] } },
    "keeps verified work",
  ],
  ["the session never switched", { sessions: goodLive().sessions.slice(0, 1) }, "different session"],
  ["no session record exists", { sessions: [] }, "first session"],
  [
    "the old messages reached the new session",
    {
      sessions: [
        goodLive().sessions[0],
        { ...goodLive().sessions[1], userTexts: [SWITCH_PROMPT, "[session-a-correction] bonjour にする"] },
      ],
    },
    "did not reach",
  ],
  [
    "the memo lost the correction, so the new session never read it",
    { sessions: [goodLive().sessions[0], { ...goodLive().sessions[1], toolResultTexts: ["GREETING=hello"] }] },
    "read the corrected request",
  ],
])("rejects a live run when %s", (_name, change, want) => {
  const checks = evaluateLive({ ...goodLive(), ...change }, MEMO_PATH);
  expect(failedNames(checks).join("\n")).toContain(want);
});

function sessionFile(startedAt: string, messages: unknown[]): string {
  return [
    JSON.stringify({ type: "title", title: "" }),
    JSON.stringify({ type: "session", version: 3, id: startedAt, timestamp: startedAt }),
    "not json",
    ...messages.map((message) => JSON.stringify({ type: "message", message })),
  ].join("\n");
}

function finishSeededRun(root: string): void {
  const project = join(root, "project");
  const memoPath = join(project, "handoff.md");
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(root, "sessions/a.jsonl"),
    sessionFile(startedAt, [{ role: "user", content: "[session-a-earlier] hello にする" }]),
  );
  writeFileSync(
    join(root, "sessions/b.jsonl"),
    sessionFile(startedAt, [
      { role: "user", content: [{ type: "text", text: `引き継ぎメモ ${memoPath} を読むこと` }] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "bonjour DEPLOY-SMOKE" }] },
    ]),
  );
  writeFileSync(memoPath, "bonjour DEPLOY-SMOKE");
  writeFileSync(
    join(project, "handoff-report.json"),
    JSON.stringify({ currentGreeting: "bonjour", verified: ["CONTRACT-REVIEW"], unverified: ["DEPLOY-SMOKE"] }),
  );
  writeFileSync(join(project, "target.txt"), "GREETING=bonjour\n");
}

test("does not pass a seeded directory where nothing has run", () => {
  const root = seedLive();
  scratchDirs.push(root);
  const result = checkLive(root);
  expect(result.pass).toBe(false);
  expect(result.evidence).toBe("live-model-compliance");
});

test("seeds prompts that fit on one input line", () => {
  const root = seedLive();
  scratchDirs.push(root);
  for (const name of ["1.txt", "2.txt", "3.txt"]) {
    expect(readFileSync(join(root, "prompts", name), "utf8")).not.toContain("\n");
  }
});

test("reads a finished run from disk and passes it", () => {
  const root = seedLive();
  scratchDirs.push(root);
  finishSeededRun(root);
  expect(failedNames(checkLive(root).checks)).toEqual([]);
  expect(checkLive(root).pass).toBe(true);
});

test("notices protected bytes changed on disk, even when the rest of the run looks right", () => {
  const root = seedLive();
  scratchDirs.push(root);
  finishSeededRun(root);
  writeFileSync(join(root, "project/protected/contract.txt"), "tampered\n");
  expect(failedNames(checkLive(root).checks)).toEqual(["protected fixture bytes are unchanged"]);
});

test("notices a stray file on disk and names it", () => {
  const root = seedLive();
  scratchDirs.push(root);
  finishSeededRun(root);
  writeFileSync(join(root, "project/stray.txt"), "");
  const stray = checkLive(root).checks.find((item) => item.name === "nothing outside the allowed scope appeared");
  expect(stray).toEqual({ name: "nothing outside the allowed scope appeared", pass: false, detail: "stray.txt" });
});

test("reduces a chat request to roles and text and tolerates malformed parts", () => {
  expect(
    parseCapturedRequest({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }, "junk"] },
        { role: "tool", content: null },
        { content: "no role" },
        "junk",
      ],
    }),
  ).toEqual({
    messages: [
      { role: "system", text: "s" },
      { role: "user", text: "a\n\n" },
      { role: "tool", text: "" },
      { role: "", text: "no role" },
    ],
  });
  expect(parseCapturedRequest(null)).toEqual({ messages: [] });
});

test.each([
  [
    "a turn of the old session is only acknowledged",
    [{ role: "user", text: "依頼" }],
    { text: "scripted: acknowledged" },
  ],
  [
    "the prompt naming the memo gets a real read call",
    [{ role: "user", text: SWITCH_PROMPT }],
    { readPath: MEMO_PATH },
  ],
  [
    "the tool result ends the turn",
    [
      { role: "user", text: SWITCH_PROMPT },
      { role: "tool", text: "memo" },
    ],
    { text: "scripted: memo received" },
  ],
])("scripts the reply so that %s", (_name, messages, want) => {
  expect(scriptedReply({ messages }, MEMO_PATH)).toEqual(want);
});

type Chunk = {
  choices: {
    delta: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    finish_reason: string | null;
  }[];
};

function sseChunks(body: string): { chunks: Chunk[]; last: string } {
  const payloads = body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => frame.replace(/^data: /, ""));
  return { chunks: payloads.slice(0, -1).map((payload) => JSON.parse(payload) as Chunk), last: payloads.at(-1) ?? "" };
}

test("streams a text reply that stops and terminates the event stream", () => {
  const { chunks, last } = sseChunks(sseBody({ text: "done" }));
  expect(chunks[0].choices[0].delta.content).toBe("done");
  expect(chunks[1].choices[0].finish_reason).toBe("stop");
  expect(last).toBe("[DONE]");
});

test("streams a read call with the memo path as its arguments", () => {
  const { chunks, last } = sseChunks(sseBody({ readPath: MEMO_PATH }));
  const call = chunks[0].choices[0].delta.tool_calls?.[0];
  expect(call?.function.name).toBe("read");
  expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual({ path: MEMO_PATH });
  expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  expect(last).toBe("[DONE]");
});

test("exits 2 for an unknown command or a directory that does not exist", async () => {
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  expect(await main(["unknown"])).toBe(2);
  expect(await main(["check", "/nonexistent/omp-handoff"])).toBe(2);
  expect(await main(["check"])).toBe(2);
  stderr.mockRestore();
});

test("prints the seeded directory, then exits 1 when checking it unfinished", async () => {
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  expect(await main(["seed"])).toBe(0);
  const root = String(stdout.mock.calls[0][0]);
  scratchDirs.push(root);
  expect(existsSync(join(root, "project/target.txt"))).toBe(true);
  expect(await main(["check", root])).toBe(1);
  stdout.mockRestore();
});

test("fails without claiming evidence when omp cannot be launched", async () => {
  const result = kept(await runTransfer({ ompBin: "/nonexistent/omp", timeoutMs: 2000 }));
  expect(result.pass).toBe(false);
  expect(result.checks).toEqual([]);
  expect(result.error).toBeTruthy();
  expect(existsSync(result.keptAt ?? "")).toBe(true);
});

test.skipIf(!Bun.which("false"))("fails when omp exits before the RPC handshake", async () => {
  const result = kept(await runTransfer({ ompBin: Bun.which("false") ?? "", timeoutMs: 10_000 }));
  expect(result.pass).toBe(false);
  expect(result.error).toContain("omp exited");
});

test("fails and stops the process when omp never answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-handoff-hang-"));
  scratchDirs.push(dir);
  const stub = join(dir, "omp");
  writeFileSync(stub, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(stub, 0o755);
  const startedAt = Date.now();

  const result = kept(await runTransfer({ ompBin: stub, timeoutMs: 200 }));

  expect(result.pass).toBe(false);
  expect(result.error).toContain("timed out");
  expect(Date.now() - startedAt).toBeLessThan(10_000);
});

// 実物の OMP を動かす統合テスト。実モデルは呼ばない。OMP が更新で引き継ぎ経路を変えるとここで落ちる。
test.skipIf(!Bun.which("omp"))(
  "real OMP: /handoff-switch delivers the memo, and only the memo, to a new session's provider request",
  async () => {
    const result = kept(await runTransfer());
    expect({ error: result.error, failed: failedNames(result.checks), keptAt: result.keptAt }).toEqual({
      error: undefined,
      failed: [],
      keptAt: undefined,
    });
    expect(result.pass).toBe(true);
    expect(result.evidence).toBe("deterministic-transfer");
  },
  180_000,
);
