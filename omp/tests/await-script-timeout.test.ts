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

test("short sync checks and named services are left alone", () => {
  expect(call({ command: "bash .claude/skills/funadev-watch/wait-ready.sh" })).toBeUndefined();
  expect(call({ command: "await-event.sh", name: "svc" })).toBeUndefined();
  expect(call({ command: "echo ok; sleep 300" })).toBeUndefined();
});
