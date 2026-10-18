import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

const fixtureDir = mkdtempSync(join(tmpdir(), "omp-usage-guard-"));
const fixtureDb = join(fixtureDir, "agent.db");
// @oh-my-pi/pi-utils is bundled inside the omp binary, not installed here, so
// the active profile's agent dir is stubbed at the module boundary.
mock.module("@oh-my-pi/pi-utils", () => ({ getAgentDir: () => fixtureDir }));

const db = new Database(fixtureDb);
db.run(`
  CREATE TABLE usage_history (
    provider TEXT NOT NULL,
    account_key TEXT,
    limit_id TEXT NOT NULL,
    used_fraction REAL NOT NULL,
    resets_at INTEGER,
    recorded_at INTEGER NOT NULL
  )
`);
// Only the logged-in organisations: a usage row whose org has no credential was logged out.
db.run(`CREATE TABLE auth_credentials (provider TEXT NOT NULL, data TEXT NOT NULL)`);
db.run(
  `INSERT INTO auth_credentials VALUES
    ('anthropic', '{"orgId":"org-p","orgName":"me@example.com''s Organization"}'),
    ('anthropic', '{"orgId":"org-t","orgName":"acme"}')`,
);
db.close();

// The agent dir is resolved while the extension module initializes.
const { default: installUsageGuard } = await import("../extensions/anthropic-usage-guard.ts");

type UsageRow = {
  provider: string;
  account?: string;
  limitId: string;
  pct: number;
  resetsAt?: number | null;
};
type Model = { provider?: string; id?: string };
type SessionStart = (event: unknown, ctx: unknown) => Promise<void> | void;

let recordedAt = Date.now();
let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

afterAll(() => {
  rmSync(fixtureDir, { force: true, recursive: true });
});

function blockNetwork() {
  const fetch = spyOn(globalThis, "fetch");
  restoreFetch = () => fetch.mockRestore();
  fetch.mockRejectedValue(new Error("unexpected ollama request"));
  return fetch;
}

function seedUsage(rows: UsageRow[]): void {
  const fixture = new Database(fixtureDb);
  try {
    fixture.run("DELETE FROM usage_history");
    const insert = fixture.query(
      "INSERT INTO usage_history (provider, account_key, limit_id, used_fraction, resets_at, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    for (const row of rows) {
      const resetsAt = row.resetsAt === undefined ? Date.now() + 60 * 60 * 1000 : row.resetsAt;
      insert.run(row.provider, row.account ?? null, row.limitId, row.pct / 100, resetsAt, ++recordedAt);
    }
  } finally {
    fixture.close();
  }
}

function usageHarness(
  current: () => Model,
  resolve: (spec: string) => Model | undefined,
  install: typeof installUsageGuard = installUsageGuard,
) {
  const selected: Model[] = [];
  const notifications: string[] = [];
  const widgets: string[][] = [];
  let sessionStart: SessionStart | undefined;
  const api = {
    setLabel() {},
    on(event: string, handler: SessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
    setModel: async (model: Model) => {
      selected.push(model);
      return true;
    },
  };
  install(api);
  const context = {
    hasUI: true,
    models: {
      current,
      resolve: async (spec: string) => resolve(spec),
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (_key: string, content?: string[]) => widgets.push(content ?? []),
    },
  };
  return {
    notifications,
    selected,
    sessionStart: async () => {
      if (!sessionStart) throw new Error("usage guard did not register session_start");
      await sessionStart({}, context);
    },
    widgets,
  };
}

test("shows one widget line per logged-in Claude organisation, then Codex", async () => {
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-opus-5-5" }),
    () => undefined,
  );
  blockNetwork();

  seedUsage([
    { provider: "anthropic", account: "oauth|account:a|org:org-p", limitId: "anthropic:7d", pct: 10 },
    { provider: "anthropic", account: "oauth|account:a|org:org-t", limitId: "anthropic:7d", pct: 60 },
    { provider: "anthropic", account: "oauth|account:a|org:org-gone", limitId: "anthropic:7d", pct: 95 },
    { provider: "openai-codex", account: "codex", limitId: "openai-codex:primary", pct: 3 },
  ]);
  await guard.sessionStart();
  const lines = (guard.widgets.at(-1) ?? []).map(stripVTControlCharacters);
  expect(lines).toEqual(["Claude personal A:10%(60m)", "Claude team A:60%(60m)", "Codex 3%(60m)"]);
});

test("uses the local rescue only when both pools are depleted and ollama serves qwen", async () => {
  seedUsage([
    { provider: "anthropic", account: "oauth|account:a|org:org-p", limitId: "anthropic:7d:fable", pct: 99 },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 99 },
  ]);
  const local = { provider: "ollama", id: "qwen3.6:35b-mlx" };
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    (spec) => (spec === "ollama/qwen3.6:35b-mlx" ? local : undefined),
  );
  const fetch = blockNetwork();
  fetch.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen3.6:35b-mlx" }] })));

  await guard.sessionStart();

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(guard.selected).toEqual([local]);
});

test("leaves the model unchanged when the local rescue is unavailable", async () => {
  seedUsage([
    { provider: "anthropic", account: "oauth|account:a|org:org-p", limitId: "anthropic:7d:fable", pct: 99 },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 99 },
  ]);
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    () => undefined,
  );
  const fetch = blockNetwork();
  fetch.mockRejectedValue(new Error("ollama is offline"));

  await guard.sessionStart();

  expect(guard.selected).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("an unused Claude account (null reset) keeps the local rescue off", async () => {
  seedUsage([
    { provider: "anthropic", account: "oauth|account:a|org:org-p", limitId: "anthropic:7d", pct: 99 },
    { provider: "anthropic", account: "oauth|account:b|org:org-t", limitId: "anthropic:7d", pct: 0, resetsAt: null },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 99 },
  ]);
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    (spec) => (spec === "ollama/qwen3.6:35b-mlx" ? { provider: "ollama", id: "qwen3.6:35b-mlx" } : undefined),
  );
  const fetch = blockNetwork();
  fetch.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen3.6:35b-mlx" }] })));

  await guard.sessionStart();

  expect(fetch).not.toHaveBeenCalled();
  expect(guard.selected).toEqual([]);
});

test("a logged-out Claude organisation at low usage does not mask depleted pools", async () => {
  seedUsage([
    { provider: "anthropic", account: "oauth|account:a|org:org-p", limitId: "anthropic:7d", pct: 99 },
    { provider: "anthropic", account: "oauth|account:a|org:org-gone", limitId: "anthropic:7d", pct: 5 },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 99 },
  ]);
  const local = { provider: "ollama", id: "qwen3.6:35b-mlx" };
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    (spec) => (spec === "ollama/qwen3.6:35b-mlx" ? local : undefined),
  );
  const fetch = blockNetwork();
  fetch.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen3.6:35b-mlx" }] })));

  await guard.sessionStart();

  expect(guard.selected).toEqual([local]);
});

// Ollama's own parsing: no scheme means http and port 11434; an explicit http:// keeps port 80.
test.each([
  ["127.0.0.1:11434", "http://127.0.0.1:11434/api/tags"],
  ["127.0.0.1", "http://127.0.0.1:11434/api/tags"],
  ["http://127.0.0.1", "http://127.0.0.1/api/tags"],
])("OLLAMA_HOST=%s is probed at %s", async (host, probed) => {
  seedUsage([
    { provider: "anthropic", account: "oauth|account:a|org:org-p", limitId: "anthropic:7d", pct: 99 },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 99 },
  ]);
  const saved = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = host;
  // A static import cannot work: OLLAMA_HOST is read when the module initializes, so load a fresh copy.
  const { default: freshGuard } = await import(`../extensions/anthropic-usage-guard.ts?host=${host}`);
  if (saved === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = saved;
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    () => undefined,
    freshGuard,
  );
  const fetch = blockNetwork();
  fetch.mockResolvedValue(new Response(JSON.stringify({ models: [] })));

  await guard.sessionStart();

  expect(String(fetch.mock.calls[0]?.[0])).toBe(probed);
});

