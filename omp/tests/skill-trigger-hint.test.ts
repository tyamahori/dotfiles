import { expect, test } from "bun:test";
import skillTriggerHint, { triggeredSkills } from "../extensions/skill-trigger-hint";

test.each([
  ["bash", { command: "uv run script.py" }, ["efficient-python"]],
  ["bash", { command: "cd x && python3 -c 'print(1)'" }, ["efficient-python"]],
  ["bash", { command: "bun --no-install run ./a.ts" }, ["efficient-ts-js"]],
  ["bash", { command: "bun test omp/tests" }, []],
  ["bash", { command: "git log --grep python" }, []],
  ["eval", { language: "py", code: "1" }, ["efficient-python"]],
  ["eval", { language: "js", code: "const tab = await browser.open('x')" }, ["efficient-ts-js", "browser-verify"]],
  ["write", { path: "omp/tests/a.test.ts" }, ["test-design"]],
  ["write", { path: "pkg/test_util.py" }, ["test-design"]],
  ["write", { path: "omp/extensions/a.ts" }, []],
  ["edit", { input: "[scripts/link.test.ts#ABCD]\nPUT 1.=1:\n+x" }, ["test-design"]],
])("%s %o triggers %o", (toolName, input, want) => {
  expect(triggeredSkills({ toolName, input })).toEqual(want);
});

function harness() {
  let handler: (event: { toolName: string; input: unknown }) => void = () => {};
  const sent: string[] = [];
  skillTriggerHint({
    on: (_event, h) => {
      handler = h as typeof handler;
    },
    sendUserMessage: (content) => sent.push(content),
  });
  return { call: (toolName: string, input: unknown) => handler({ toolName, input }), sent };
}

test("hints each skill once per session", () => {
  const h = harness();
  h.call("bash", { command: "uv run a.py" });
  h.call("eval", { language: "py", code: "1" });
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toContain("skill://efficient-python");
});

test("stays silent for a skill already read in the session", () => {
  const h = harness();
  h.call("read", { path: "skill://efficient-python" });
  h.call("bash", { command: "uv run a.py" });
  expect(h.sent).toEqual([]);
});
