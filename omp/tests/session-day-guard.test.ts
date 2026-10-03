import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import guard from "../extensions/session-day-guard";

type Handler = (event: unknown, ctx: unknown) => void;

const dir = mkdtempSync(join(tmpdir(), "session-day-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function transcript(bytes: number): string {
  const file = join(dir, `${bytes}.jsonl`);
  writeFileSync(file, "");
  truncateSync(file, bytes);
  return file;
}

const HOUR = 60 * 60 * 1000;

function harness(opts: { idleMs: number; bytes: number; hasUI?: boolean }) {
  const handlers: Record<string, Handler> = {};
  const notices: string[] = [];
  guard({
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
  });
  // 最終エントリは idleMs 前。深夜に走ると日跨ぎ警告も出るので、
  // この警告(transcript を含む通知)だけを数える。
  const now = Date.now();
  const ctx = {
    hasUI: opts.hasUI ?? true,
    ui: { notify: (m: string) => m.includes("transcript") && notices.push(m) },
    sessionManager: {
      getBranch: () => [{ timestamp: now - opts.idleMs - 1000 }, { timestamp: now - opts.idleMs }],
      getSessionFile: () => transcript(opts.bytes),
    },
  };
  return {
    notices,
    start: () => handlers.session_start({}, ctx),
    switchTo: (reason: string) => handlers.session_switch({ reason }, ctx),
  };
}

test("warns when a transcript over 5MB is resumed after more than an hour idle", () => {
  const h = harness({ idleMs: 2 * HOUR, bytes: 6_000_000 });
  h.start();
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]).toContain("約6MB");
});

test("stays silent when idle for under an hour or the transcript is 5MB or less", () => {
  const recent = harness({ idleMs: 30 * 60 * 1000, bytes: 6_000_000 });
  recent.start();
  const small = harness({ idleMs: 2 * HOUR, bytes: 5_000_000 });
  small.start();
  expect([...recent.notices, ...small.notices]).toEqual([]);
});

test("checks /resume switches but not new or fork switches", () => {
  const h = harness({ idleMs: 2 * HOUR, bytes: 6_000_000 });
  h.switchTo("new");
  h.switchTo("fork");
  expect(h.notices).toHaveLength(0);
  h.switchTo("resume");
  expect(h.notices).toHaveLength(1);
});

test("does nothing in sessions without UI", () => {
  const h = harness({ idleMs: 2 * HOUR, bytes: 6_000_000, hasUI: false });
  h.start();
  h.switchTo("resume");
  expect(h.notices).toHaveLength(0);
});
