import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// jev-agent-hint.ts computes LOG_PATH from process.cwd() at import time, so
// import it with cwd pointed at a throwaway directory — otherwise handler
// tests below would append real rows into this repo's shadow log. Dynamic
// import is required here (not a static-import exception, an actual load
// timing boundary): the module body must not run until cwd is redirected.
const scratchDir = mkdtempSync(join(tmpdir(), "omp-jev-agent-hint-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);
const { default: jevAgentHint, extractAgentRoster } = await import("../extensions/jev-agent-hint.ts");
process.chdir(originalCwd);

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

const SAMPLE_TASK_DESCRIPTION = `Delegate work to background subagents.

# Available Agents
Pick the most specific agent.
### scout (READ-ONLY)
MUST be used for exploratory codebase research, rapid code analysis, and
broad pattern searches. Fast read-only scout returning compressed context.

### reviewer
Code review specialist for quality/security analysis
### security-reviewer
Read-only security specialist for evidence-backed repository vulnerability discovery
### task
General-purpose subagent with full capabilities for delegated multi-step tasks
### sonic
Low-reasoning agent for strictly mechanical updates or data collection only`;

test("extractAgentRoster pulls every ### heading and trims its description", () => {
	const roster = extractAgentRoster(SAMPLE_TASK_DESCRIPTION);
	expect(Object.keys(roster)).toEqual(["scout", "reviewer", "security-reviewer", "task", "sonic"]);
	expect(roster.scout).toContain("MUST be used for exploratory codebase research");
	expect(roster.scout).not.toContain("\n");
	expect(roster.sonic).toBe("Low-reasoning agent for strictly mechanical updates or data collection only");
});

test("extractAgentRoster returns an empty roster when no ### headings are present", () => {
	expect(extractAgentRoster("just a plain description with no headings")).toEqual({});
});

type ToolCallHandler = (event: unknown, ctx: { setTimeout: (fn: () => unknown, ms: number) => unknown }) => void;

function agentHintHarness(toolDescription: string | undefined) {
	let handler: ToolCallHandler | undefined;
	jevAgentHint({
		on(event: string, h: ToolCallHandler) {
			if (event === "tool_call") handler = h;
		},
		getAllTools() {
			return toolDescription === undefined ? [] : [{ name: "task", description: toolDescription }];
		},
	} as never);
	return handler!;
}

function fireAndWaitScheduled(handler: ToolCallHandler, event: unknown): Promise<unknown> {
	let scheduled: Promise<unknown> = Promise.resolve();
	handler(event, {
		setTimeout: (fn) => {
			scheduled = Promise.resolve(fn());
			return 0;
		},
	});
	return scheduled;
}

test("shadow-logs the predicted agent without touching tool_call input", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	const requestBodies: { state: string; questions: Record<string, unknown> }[] = [];
	global.fetch = (async (_url: unknown, init: { body: string }) => {
		requestBodies.push(JSON.parse(init.body));
		return new Response(
			JSON.stringify({
				answers: { best_agent: { type: "choice", choice: "scout", probabilities: { scout: 0.9, task: 0.1 } } },
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	try {
		const handler = agentHintHarness(SAMPLE_TASK_DESCRIPTION);
		const event = { toolName: "task", input: { tasks: [{ task: "investigate the bug", agent: "scout" }] } };
		let scheduled = false;
		const returnValue = handler(event, {
			setTimeout: () => {
				scheduled = true;
			},
		});
		expect(returnValue).toBeUndefined(); // input パススルー、戻り値で何も差し替えない
		expect(scheduled).toBe(true); // Jev 呼び出しは同期処理から切り離される

		await fireAndWaitScheduled(handler, event);
		expect(requestBodies).toHaveLength(1);
		expect(requestBodies[0].state).toBe("investigate the bug");
		expect(requestBodies[0].questions.best_agent).toMatchObject({ type: "choice" });
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("opens the circuit breaker and logs jevError after a failed call", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let callCount = 0;
	global.fetch = (async () => {
		callCount++;
		return new Response("boom", { status: 500 });
	}) as typeof fetch;

	try {
		const handler = agentHintHarness(SAMPLE_TASK_DESCRIPTION);
		const event = { toolName: "task", input: { tasks: [{ task: "first call fails" }] } };
		await fireAndWaitScheduled(handler, event);
		expect(callCount).toBe(1);

		// 2回目は circuit breaker で jevCall 自体を呼ばない。
		const secondEvent = { toolName: "task", input: { tasks: [{ task: "second call skipped" }] } };
		await fireAndWaitScheduled(handler, secondEvent);
		expect(callCount).toBe(1);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("no-ops when the tool call is not a task delegation", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let called = false;
	global.fetch = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	try {
		const handler = agentHintHarness(SAMPLE_TASK_DESCRIPTION);
		await fireAndWaitScheduled(handler, { toolName: "read", input: {} });
		await fireAndWaitScheduled(handler, { toolName: "task", input: { tasks: [] } });
		expect(called).toBe(false);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("no-ops when the task tool roster cannot be extracted", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let called = false;
	global.fetch = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	try {
		const handler = agentHintHarness("no headings in this description");
		await fireAndWaitScheduled(handler, { toolName: "task", input: { tasks: [{ task: "unreachable" }] } });
		expect(called).toBe(false);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});
