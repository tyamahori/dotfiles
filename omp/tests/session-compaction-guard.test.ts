import { expect, test } from "bun:test";
import guard from "../extensions/session-compaction-guard";

type Handler = (event: unknown, ctx: unknown) => void;

function harness() {
  const handlers: Record<string, Handler> = {};
  const messages: string[] = [];
  const options: Array<{ deliverAs?: string } | undefined> = [];
  guard({
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
    sendUserMessage(message: string, opts?: { deliverAs?: string }) {
      messages.push(message);
      options.push(opts);
    },
  });
  const ctx = { hasUI: true };
  return {
    messages,
    options,
    compaction: () => handlers.auto_compaction_end({}, ctx),
    input: (text: string) => handlers.input({ source: "interactive", text }, ctx),
    toolResult: (toolName: string, isError = false) => handlers.tool_result({ toolName, isError }, ctx),
    reset: () => handlers.session_start({}, ctx),
  };
}

test("delivers every reminder as aside, so a long tool-call run doesn't queue it behind followUp", () => {
  const h = harness();
  h.compaction();
  h.compaction();
  h.input("別の依頼");
  expect(h.options).toEqual([{ deliverAs: "aside" }, { deliverAs: "aside" }]);
});

test("nudges on the second compaction and on later interactive input", () => {
  const h = harness();
  h.compaction();
  expect(h.messages).toHaveLength(0);
  h.compaction();
  expect(h.messages).toHaveLength(1);
  h.input("別の依頼");
  expect(h.messages).toHaveLength(2);
});

test("stays silent once handoff_switch succeeded, until the session resets", () => {
  const h = harness();
  h.compaction();
  h.compaction();
  h.toolResult("handoff_switch");
  h.compaction();
  h.input("/handoff-switch .agent-msgs/handoff/x.md");
  h.input("別の依頼");
  expect(h.messages).toHaveLength(1);

  h.reset();
  h.compaction();
  h.compaction();
  expect(h.messages).toHaveLength(2);
});

test("ignores the injected /handoff-switch command and failed handoff_switch calls", () => {
  const h = harness();
  h.compaction();
  h.compaction();
  h.toolResult("handoff_switch", true);
  h.input("/handoff-switch .agent-msgs/handoff/x.md");
  expect(h.messages).toHaveLength(1);
  h.input("別の依頼");
  expect(h.messages).toHaveLength(2);
});
