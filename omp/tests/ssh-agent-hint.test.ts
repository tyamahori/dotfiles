import { expect, test } from "bun:test";
import sshAgentHint from "../extensions/ssh-agent-hint";

function steersFor(event: Record<string, unknown>): number {
  let handler: ((event: unknown) => void) | undefined;
  let steers = 0;
  sshAgentHint({
    on: (_name, fn) => {
      handler = fn as (event: unknown) => void;
    },
    sendUserMessage: () => {
      steers++;
    },
  });
  handler?.({ toolName: "bash", ...event });
  return steers;
}

const locked = [{ type: "text", text: "sign_and_send_pubkey: communication with agent failed\nfatal: Could not read from remote repository." }];

test.each([
  ["steers on a failed push whose output names the agent failure", { input: { command: "git push" }, content: locked, isError: true }, 1],
  ["stays quiet on a successful search for the signature text", { input: { command: "git grep 'communication with agent failed'" }, content: locked, isError: false }, 0],
  ["stays quiet when only the failed command's own text has the signature", { input: { command: "git grep 'communication with agent failed'" }, content: [{ type: "text", text: "" }], isError: true }, 0],
  ["steers on a push run through cd and -C", { input: { command: "cd repo && git -C /tmp/r push" }, content: locked, isError: true }, 1],
  ["stays quiet when git show prints a doc quoting the signature", { input: { command: "git show HEAD:docs/push.md" }, content: locked, isError: true }, 0],
  ["steers on a push behind env and -c options", { input: { command: "GIT_TRACE=1 git -c core.sshCommand=ssh push" }, content: locked, isError: true }, 1],
  ["steers on submodule update", { input: { command: "git submodule update --init" }, content: locked, isError: true }, 1],
  ["stays quiet on a remote listing", { input: { command: "git remote -v" }, content: locked, isError: true }, 0],
  ["stays quiet when a separator sits inside quotes", { input: { command: "printf 'x; git push origin' && git commit -m \"a; git fetch\"" }, content: locked, isError: true }, 0],
  ["steers when -C and -c values are quoted with spaces", { input: { command: "git -C '/repo with spaces' -c \"core.sshCommand=ssh -v\" push" }, content: locked, isError: true }, 1],
])("%s", (_name, event, expected) => {
  expect(steersFor(event)).toBe(expected);
});
