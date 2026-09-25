import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
db.close();

// The agent dir is resolved while the extension module initializes.
const { default: installUsageGuard } = await import("../extensions/anthropic-usage-guard.ts");

type UsageRow = {
  provider: string;
  account?: string;
  limitId: string;
  pct: number;
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
      insert.run(row.provider, row.account ?? null, row.limitId, row.pct / 100, Date.now() + 60 * 60 * 1000, ++recordedAt);
    }
  } finally {
    fixture.close();
  }
}

function usageHarness(
  current: () => Model,
  resolve: (spec: string) => Model | undefined,
  chains: Record<string, string[]> = {
    "anthropic/*": ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol"],
  },
) {
  const selected: Model[] = [];
  const notifications: string[] = [];
  const widgets: string[][] = [];
  let sessionStart: SessionStart | undefined;
  const api = {
    pi: { settings: { get: (_key: "retry.fallbackChains") => chains } },
    setLabel() {},
    on(event: string, handler: SessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
    setModel: async (model: Model) => {
      selected.push(model);
      return true;
    },
  };
  installUsageGuard(api);
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

test("uses the configured model-specific chain before the provider chain at the reserve threshold", async () => {
  seedUsage([
    { provider: "anthropic", limitId: "anthropic:7d:fable", pct: 80 },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 30 },
  ]);
  const fallback = { provider: "openai-codex", id: "configured-fallback" };
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    (spec) => ({ provider: "openai-codex", id: spec.split("/")[1] }),
    {
      "anthropic/*": ["openai-codex/provider-fallback"],
      "anthropic/claude-sonnet-5": ["openai-codex/configured-fallback"],
    },
  );
  blockNetwork();

  await guard.sessionStart();

  expect(guard.selected).toEqual([fallback]);
  expect(guard.notifications).toHaveLength(1);
});

test("stays on Anthropic while any logged-in account has headroom", async () => {
  const fallback = { provider: "openai-codex", id: "gpt-6-astra" };
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-opus-5-5" }),
    (spec) => (spec === "openai-codex/gpt-6-astra" ? fallback : undefined),
  );
  blockNetwork();

  // The exhausted team account is recorded last, so a latest-row-wins reading would switch.
  seedUsage([
    { provider: "anthropic", account: "personal", limitId: "anthropic:7d", pct: 10 },
    { provider: "anthropic", account: "personal", limitId: "anthropic:7d:fable", pct: 79 },
    { provider: "anthropic", account: "team", limitId: "anthropic:7d", pct: 95 },
  ]);
  await guard.sessionStart();
  expect(guard.selected).toEqual([]);
  expect(guard.widgets.at(-1)?.[0]).toContain("7d 10%");

  seedUsage([
    { provider: "anthropic", account: "personal", limitId: "anthropic:7d", pct: 10 },
    { provider: "anthropic", account: "personal", limitId: "anthropic:7d:fable", pct: 80 },
    { provider: "anthropic", account: "team", limitId: "anthropic:7d", pct: 95 },
  ]);
  await guard.sessionStart();
  expect(guard.selected).toEqual([fallback]);
});

test("uses the local rescue only when both pools are depleted and ollama serves qwen", async () => {
  seedUsage([
    { provider: "anthropic", limitId: "anthropic:7d:fable", pct: 99 },
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
    { provider: "anthropic", limitId: "anthropic:7d:fable", pct: 99 },
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

test("keeps a manual choice latched until usage recovers, then rearms the fallback", async () => {
  let current: Model = { provider: "anthropic", id: "claude-sonnet-5" };
  const fallback = { provider: "openai-codex", id: "gpt-6-astra" };
  const guard = usageHarness(
    () => current,
    (spec) => (spec === "openai-codex/gpt-6-astra" ? fallback : undefined),
  );
  blockNetwork();

  seedUsage([{ provider: "anthropic", limitId: "anthropic:7d:fable", pct: 80 }]);
  await guard.sessionStart();
  current = { provider: "anthropic", id: "manual-choice" };
  await guard.sessionStart();
  seedUsage([{ provider: "anthropic", limitId: "anthropic:7d:fable", pct: 79 }]);
  await guard.sessionStart();
  seedUsage([{ provider: "anthropic", limitId: "anthropic:7d:fable", pct: 80 }]);
  await guard.sessionStart();

  expect(guard.selected).toEqual([fallback, fallback]);
});

test("an empty model chain disables the provider fallback", async () => {
  seedUsage([{ provider: "anthropic", limitId: "anthropic:7d:fable", pct: 80 }]);
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    () => ({ provider: "openai-codex", id: "provider-fallback" }),
    {
      "anthropic/*": ["openai-codex/provider-fallback"],
      "anthropic/claude-sonnet-5": [],
    },
  );
  blockNetwork();

  await guard.sessionStart();

  expect(guard.selected).toEqual([]);
});

test("preserves the Codex reserve even when a configured fallback resolves", async () => {
  seedUsage([
    { provider: "anthropic", limitId: "anthropic:7d:fable", pct: 80 },
    { provider: "openai-codex", limitId: "openai-codex:primary", pct: 80 },
  ]);
  const guard = usageHarness(
    () => ({ provider: "anthropic", id: "claude-sonnet-5" }),
    () => ({ provider: "openai-codex", id: "configured-fallback" }),
  );
  blockNetwork();

  await guard.sessionStart();

  expect(guard.selected).toEqual([]);
});
