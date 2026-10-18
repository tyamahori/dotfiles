import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/notify.ts");

// The platform check runs when the module loads, so the override has to
// precede a dynamic import inside a child process.
test("registers its handlers on Linux, where delivery goes through notify-send", () => {
  const driver = `
    Object.defineProperty(process, "platform", { value: "linux" });
    const { default: install } = await import(${JSON.stringify(extension)});
    const events = [];
    install({ on: (event) => events.push(event) });
    console.log(JSON.stringify(events));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", driver]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(
    expect.arrayContaining(["agent_end", "tool_approval_requested"]),
  );
});

// Fires `events` at the extension as the root session on Linux inside a herdr
// pane that is not focused (the one path where "done" also notifies) and
// returns the notify-send argument lines. herdr and notify-send are PATH stubs.
function toasts(events: [string, unknown][]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "notify-test-"));
  try {
    const log = join(dir, "log");
    writeFileSync(join(dir, "notify-send"), `#!/bin/sh\nprintf '%s\\0' "$*" >> '${log}'\n`, { mode: 0o755 });
    writeFileSync(
      join(dir, "herdr"),
      `#!/bin/sh\necho '{"result":{"snapshot":{"focused_workspace_id":"x","focused_pane_id":"x"}}}'\n`,
      { mode: 0o755 },
    );
    const driver = `
      Object.defineProperty(process, "platform", { value: "linux" });
      const { default: install } = await import(${JSON.stringify(extension)});
      const handlers = {};
      install({ on: (event, handler) => (handlers[event] = handler) });
      const ctx = { hasUI: true, isIdle: () => true };
      handlers.session_start({}, ctx);
      for (const [name, event] of ${JSON.stringify(events)}) handlers[name](event, ctx);
      await Bun.sleep(500);
    `;
    const result = Bun.spawnSync([process.execPath, "-e", driver], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HERDR_PANE_ID: "w:p1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t" },
    });
    expect(result.exitCode).toBe(0);
    return existsSync(log) ? readFileSync(log, "utf8").split("\0").filter(Boolean) : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const finished = { messages: [{ role: "assistant", content: [{ type: "text", text: "終わった" }] }] };

test("agent_end that will continue is not a completion toast", () => {
  expect(toasts([["agent_start", {}], ["agent_end", { ...finished, willContinue: true }]])).toEqual([]);
  // The continuation's own end still notifies.
  const lines = toasts([
    ["agent_start", {}],
    ["agent_end", { ...finished, willContinue: true }],
    ["agent_end", finished],
  ]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("OMP 作業完了");
});

test("exhausted auto-retry notifies an error stop; a successful retry does not", () => {
  expect(toasts([["auto_retry_end", { success: true, attempt: 2 }]])).toEqual([]);
  const lines = toasts([["auto_retry_end", { success: false, attempt: 3, finalError: "503 overloaded" }]]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("OMP エラー停止");
  expect(lines[0]).toContain("503 overloaded");
});

test("a non-retryable error that merely contains 500 still notifies the stop", () => {
  const stop = (errorMessage: string) => [
    ["agent_start", {}],
    ["agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage, content: [] }] }],
  ] as [string, unknown][];
  const lines = toasts(stop("400 invalid_request_error: max_tokens: 64500 > 64000"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("OMP エラー停止");
  // A real 5xx is left to auto-retry.
  expect(toasts(stop("500 internal server error"))).toEqual([]);
});
