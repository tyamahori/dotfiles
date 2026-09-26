import { expect, test } from "bun:test";
import failFast from "../extensions/fail-fast";

type Handler = (event: unknown) => void;

function harness() {
  const handlers: Record<string, Handler> = {};
  const messages: string[] = [];
  failFast({
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
    sendUserMessage(message: string) {
      messages.push(message);
    },
  });
  const run = (command: string, isError: boolean) =>
    handlers.tool_result({ toolName: "bash", input: { command }, isError });
  return { messages, run, reset: () => handlers.session_start({}) };
}

test("steers on the second consecutive failure of the same command", () => {
  const h = harness();
  h.run("git push", true);
  h.run("other", true);
  expect(h.messages).toHaveLength(0);
  h.run("git push", true);
  expect(h.messages).toHaveLength(1);
});

test("a success or a new session resets the count", () => {
  const h = harness();
  h.run("git push", true);
  h.run("git push", false);
  h.run("git push", true);
  h.reset();
  h.run("git push", true);
  expect(h.messages).toHaveLength(0);
});
