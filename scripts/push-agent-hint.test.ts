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

const run = (command: string, tool_response: string) =>
  Bun.spawnSync([resolve(import.meta.dir, "push-agent-hint")], {
    stdin: Buffer.from(JSON.stringify({ tool_input: { command }, tool_response })),
  }).stdout.toString();

test.each([
  ["blocks a push run through cd and -C", "cd repo && git -C /tmp/r push origin main", true],
  ["blocks a bare ssh probe", "ssh -T git@github.com", true],
  ["stays quiet when git show prints a doc quoting the signature", "git show HEAD:docs/push.md", false],
  ["stays quiet when push is only a path fragment", "git log -- scripts/push-agent-hint", false],
  ["blocks a push with a -c override", "git -c core.sshCommand=ssh push", true],
  ["blocks a submodule update", "git submodule update --init", true],
  ["stays quiet on a local remote listing", "git remote -v", false],
  ["stays quiet on a bare submodule status", "git submodule", false],
  ["stays quiet when a separator sits inside single quotes", "printf 'x; git push origin'", false],
  ["stays quiet when a separator sits inside double quotes", 'git commit -m "fix; git push later"', false],
  ["blocks a push with a quoted remote", 'git push "origin" main', true],
  ["blocks a push whose -C path is quoted with spaces", "git -C '/repo with spaces' push", true],
  ["blocks a push whose -c value is quoted with spaces", 'git -c "core.sshCommand=ssh -v" push', true],
  [
    "blocks a push whose --git-dir and --work-tree take separate values",
    "git --git-dir /repo/.git --work-tree /repo push",
    true,
  ],
])("%s", (_name, command, blocks) => {
  const out = run(command, "sign_and_send_pubkey: communication with agent failed");
  expect(out.includes('"decision": "block"')).toBe(blocks);
});
