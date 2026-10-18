import { expect, test } from "bun:test";
import awaitScriptTimeout from "../extensions/await-script-timeout";

type Handler = (event: unknown) => { input: Record<string, unknown> } | undefined;

function call(input: Record<string, unknown>) {
  let handler: Handler | undefined;
  awaitScriptTimeout({ on: (_event, h) => (handler = h as Handler) });
  return handler?.({ toolName: "bash", input });
}

test("await-*.sh runs async with the timeout disabled", () => {
  const input = { command: "bash .claude/skills/funadev-watch/await-event.sh", i: "x" };
  expect(call(input)?.input).toEqual({ ...input, async: true, timeout: 0 });
});

test("quoted await-*.sh paths are rewritten too", () => {
  for (const command of [
    `bash "$HOME/.agents/skills/herdr/scripts/await-agent.sh" --pane 1`,
    `bash '/opt/my skills/await-agent.sh'`,
  ]) {
    expect(call({ command })?.input).toEqual({ command, async: true, timeout: 0 });
  }
});

test("short sync checks and named services are left alone", () => {
  expect(call({ command: "bash .claude/skills/funadev-watch/wait-ready.sh" })).toBeUndefined();
  expect(call({ command: "await-event.sh", name: "svc" })).toBeUndefined();
  expect(call({ command: "echo ok; sleep 300" })).toBeUndefined();
});

test("commands that only name an await script stay synchronous", () => {
  for (const command of [
    "shellcheck agents/skills/github-pr-respond/scripts/await-pr-change.sh",
    "git add scripts/await-pr-change.sh",
    "chmod +x ./await-pr-change.sh",
    'git commit -m "fix await-pr-change.sh typo"',
  ]) {
    expect(call({ command })).toBeUndefined();
  }
  // ...while running it after another command still counts.
  const chained = "cd ~/repo && ./scripts/await-pr-change.sh o r 1";
  expect(call({ command: chained })?.input).toEqual({ command: chained, async: true, timeout: 0 });
});

test("named finite jobs drop name and ready instead of being rejected", () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      { command: "gh pr checks 1 --watch", name: "checks", async: true, ready: {} },
      { command: "gh pr checks 1 --watch", async: true },
    ],
    [{ command: "make test", name: "t", timeout: 600 }, { command: "make test", timeout: 600 }],
    // name を外した後に await-*.sh の規則が当たる
    [{ command: "bash await-event.sh", name: "w", async: true }, { command: "bash await-event.sh", async: true, timeout: 0 }],
  ];
  for (const [input, want] of cases) expect(call(input)?.input).toEqual(want);
});

test("named services the tool accepts are left alone", () => {
  expect(call({ command: "bun dev", name: "dev", async: false, ready: { port: 3000 } })).toBeUndefined();
  expect(call({ command: "bun dev", name: "dev", pty: true })).toBeUndefined();
});
