import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/jbcontext-index.ts");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

test("a missing jbcontext binary does not crash the session", () => {
  root = mkdtempSync(join(tmpdir(), "omp-jbcontext-index-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // A child process isolates the uncaught spawn error; `exit` fires after the
  // error event has been delivered, so no guessed delay is needed.
  const driver = `
    let crashed = false;
    process.on("uncaughtException", () => { crashed = true; });
    const { default: install } = await import(${JSON.stringify(extension)});
    let handler;
    install({ on: (event, fn) => { if (event === "session_start") handler = fn; } });
    process.chdir(${JSON.stringify(repo)});
    handler();
    process.on("exit", () => console.log(crashed ? "crashed" : "ok"));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", driver], {
    env: { HOME: root, PATH: "/usr/bin:/bin" },
  });
  expect(result.stdout.toString().trim()).toBe("ok");
});
