import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the locked-agent hint survives a command longer than a pipe buffer", () => {
  const payload = JSON.stringify({
    tool_input: { command: `git push origin main\n${"x".repeat(300_000)}` },
    error: "sign_and_send_pubkey: communication with agent failed",
  });
  const r = Bun.spawnSync([resolve(import.meta.dir, "push-agent-hint")], { stdin: Buffer.from(payload) });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain('"decision": "block"');
});
