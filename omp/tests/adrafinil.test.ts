import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import adrafinil from "../extensions/adrafinil";

type Hook = (event: unknown, ctx: unknown) => void;

let spawn: Mock<typeof childProcess.spawnSync>;

beforeEach(() => {
  spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
    stdout: "",
    stderr: "",
    status: 0,
  } as SpawnSyncReturns<string>);
});

afterEach(() => {
  spawn.mockRestore();
});

function hooks(): Map<string, Hook> {
  const registered = new Map<string, Hook>();
  adrafinil({
    on(event, handler) {
      registered.set(event, handler as Hook);
    },
  });
  return registered;
}

function ctx(hasUI: boolean, id: string) {
  return { hasUI, sessionManager: { getSessionId: () => id } };
}

function verbs(): string[] {
  return spawn.mock.calls.map((call) => `${(call[1] as string[])[0]} ${(call[1] as string[])[1]}`);
}

test("releases a subagent hold when its agent loop ends", () => {
  const on = hooks();
  on.get("agent_start")?.({}, ctx(false, "sub"));
  on.get("agent_end")?.({}, ctx(false, "sub"));
  expect(verbs()).toEqual(["acquire sub", "release sub"]);
});

test("keeps the main session hold across agent_end until session_stop", () => {
  const on = hooks();
  on.get("agent_start")?.({}, ctx(true, "main"));
  on.get("agent_end")?.({}, ctx(true, "main"));
  expect(verbs()).toEqual(["acquire main"]);
  on.get("session_stop")?.({}, ctx(true, "main"));
  expect(verbs()).toEqual(["acquire main", "release main"]);
});
