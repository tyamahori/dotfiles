import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";

type Handler = (event: Record<string, unknown>, ctx: TestContext) => unknown;
type TestContext = {
  isIdle: () => boolean;
  ui: { setTitle: (title: string) => void };
};
type PendingResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};

let moduleNumber = 0;
let savedEnvironment: Record<string, string | undefined> = {};
let restoreFetch: (() => void) | undefined;

beforeEach(() => {
  savedEnvironment = { ...process.env };
  delete process.env.ORCA_AGENT_HOOK_ENDPOINT;
  delete process.env.ORCA_PI_STATUS_OWNED;
  Object.assign(process.env, {
    ORCA_AGENT_HOOK_PORT: "9999",
    ORCA_AGENT_HOOK_TOKEN: "test-token",
    ORCA_PANE_KEY: "test-pane",
    ORCA_AGENT_LAUNCH_TOKEN: "test-launch",
    ORCA_TAB_ID: "test-tab",
    ORCA_WORKTREE_ID: "test-worktree",
  });
  jest.useFakeTimers();
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  jest.useRealTimers();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, savedEnvironment);
});

function registeredPi(session = "lifecycle") {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on(name: string, callback: Handler) {
        handlers.set(name, callback);
      },
      getSessionName() {
        return session;
      },
    },
  };
}

function callback(handlers: Map<string, Handler>, name: string): Handler {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing ${name} registration`);
  return handler;
}

function pendingResponse(): PendingResponse {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function capturePostEvents() {
  const names: string[] = [];
  const pending: PendingResponse[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const body = JSON.parse(String(init?.body)) as { payload?: { hook_event_name?: unknown } };
    const name = body.payload?.hook_event_name;
    if (typeof name !== "string") throw new Error("missing status event name");
    names.push(name);
    const response = pendingResponse();
    pending.push(response);
    return response.promise;
  });
  restoreFetch = () => spy.mockRestore();
  return { names, pending };
}

async function flushAsyncWork(): Promise<void> {
  for (let count = 0; count < 4; count += 1) await Promise.resolve();
}

// Dynamic import isolates extension-level queues and timers; static imports retain them across tests.
async function loadExtension(name: string) {
  delete process.env.ORCA_PI_STATUS_OWNED;
  return (await import(new URL(`../extensions/${name}.ts?lifecycle=${moduleNumber++}`, import.meta.url).href)).default;
}

function titleContext(titles: string[], isIdle: () => boolean): TestContext {
  return { isIdle, ui: { setTitle: (title) => titles.push(title) } };
}

test("status remains working through continuation and delivers only the latest slow-receiver state", async () => {
  const { names, pending } = capturePostEvents();
  const { handlers, pi } = registeredPi();
  const registerStatus = await loadExtension("orca-agent-status");
  registerStatus(pi);
  const ctx = titleContext([], () => false);

  callback(handlers, "agent_start")({}, ctx);
  callback(handlers, "tool_execution_start")({ toolName: "bash", args: { command: "sleep" } }, ctx);
  callback(handlers, "agent_end")({ willContinue: true }, ctx);
  callback(handlers, "tool_execution_end")({ toolName: "bash" }, ctx);

  expect(names).toEqual(["agent_start"]);
  expect(pending).toHaveLength(1);
  pending[0].resolve(new Response());
  await flushAsyncWork();
  expect(names).toEqual(["agent_start", "tool_execution_end"]);

  expect(pending).toHaveLength(2);
  pending[1].resolve(new Response());
  await flushAsyncWork();
  callback(handlers, "agent_settled")({}, ctx);
  expect(names).toEqual(["agent_start", "tool_execution_end", "agent_end"]);

  expect(pending).toHaveLength(3);
  pending[2].resolve(new Response());
  await flushAsyncWork();
});

test("spinner defers a non-idle agent end, then stops at idle and final settlement", async () => {
  const titles: string[] = [];
  let idle = false;
  const ctx = titleContext(titles, () => idle);
  const { handlers, pi } = registeredPi();
  const registerSpinner = await loadExtension("orca-titlebar-spinner");
  registerSpinner(pi);

  await callback(handlers, "agent_start")({}, ctx);
  jest.advanceTimersByTime(80);
  expect(titles).toHaveLength(2);

  await callback(handlers, "agent_end")({}, ctx);
  jest.advanceTimersByTime(25);
  expect(titles).toHaveLength(2);

  idle = true;
  jest.advanceTimersByTime(50);
  expect(titles[titles.length - 1]?.startsWith("π - lifecycle - ")).toBe(true);

  await callback(handlers, "agent_start")({}, ctx);
  await callback(handlers, "agent_settled")({}, ctx);
  expect(titles[titles.length - 1]?.startsWith("π - lifecycle - ")).toBe(true);

  const titleCount = titles.length;
  jest.advanceTimersByTime(160);
  expect(titles).toHaveLength(titleCount);
});

test("spinner ignores a late idle-maintenance completion during newer work and shuts down cleanly", async () => {
  const titles: string[] = [];
  const ctx = titleContext(titles, () => false);
  const { handlers, pi } = registeredPi();
  const registerSpinner = await loadExtension("orca-titlebar-spinner");
  registerSpinner(pi);

  await callback(handlers, "auto_compaction_start")({ reason: "idle" }, ctx);
  jest.advanceTimersByTime(80);
  await callback(handlers, "auto_compaction_end")({}, ctx);
  const afterMaintenance = titles.length;
  jest.advanceTimersByTime(80);
  expect(titles).toHaveLength(afterMaintenance);

  await callback(handlers, "auto_compaction_start")({ reason: "idle" }, ctx);
  await callback(handlers, "agent_start")({}, ctx);
  await callback(handlers, "auto_compaction_end")({}, ctx);
  const duringNewerWork = titles.length;
  jest.advanceTimersByTime(80);
  expect(titles).toHaveLength(duringNewerWork + 1);

  await callback(handlers, "session_shutdown")({}, ctx);
  expect(titles[titles.length - 1]?.startsWith("π - lifecycle - ")).toBe(true);
  const afterShutdown = titles.length;
  jest.advanceTimersByTime(160);
  expect(titles).toHaveLength(afterShutdown);
});
