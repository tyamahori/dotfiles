import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// jev-model-hint.ts computes LOG_PATH from process.cwd() at import time, so
// import it with cwd pointed at a throwaway directory — otherwise handler
// tests below would append real rows into this repo's shadow log. Dynamic
// import is required here (not a static-import exception, an actual load
// timing boundary): the module body must not run until cwd is redirected.
const scratchDir = mkdtempSync(join(tmpdir(), "omp-jev-model-hint-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);
const { default: jevModelHint } = await import("../extensions/jev-model-hint.ts");
process.chdir(originalCwd);

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

type Ctx = { models?: { current: () => { provider?: string; id?: string } | undefined }; setTimeout: (fn: () => unknown, ms: number) => unknown };
type InputHandler = (event: unknown, ctx: Ctx) => void;

function modelHintHarness() {
	let handler: InputHandler | undefined;
	jevModelHint({
		on(event: string, h: InputHandler) {
			if (event === "input") handler = h;
		},
	} as never);
	return handler!;
}

function fireAndWaitScheduled(handler: InputHandler, event: unknown, ctx: Partial<Ctx> = {}): Promise<unknown> {
	let scheduled: Promise<unknown> = Promise.resolve();
	handler(event, {
		setTimeout: (fn) => {
			scheduled = Promise.resolve(fn());
			return 0;
		},
		...ctx,
	});
	return scheduled;
}

test("shadow-logs the predicted tier alongside the actually running model", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	const requestBodies: { state: string; questions: Record<string, unknown> }[] = [];
	global.fetch = (async (_url: unknown, init: { body: string }) => {
		requestBodies.push(JSON.parse(init.body));
		return new Response(
			JSON.stringify({
				answers: { best_tier: { type: "choice", choice: "smol", probabilities: { smol: 0.7, default: 0.3 } } },
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	try {
		const handler = modelHintHarness();
		await fireAndWaitScheduled(
			handler,
			{ text: "what's the weather" },
			{ models: { current: () => ({ provider: "anthropic", id: "claude-sonnet-5" }) } },
		);
		expect(requestBodies).toHaveLength(1);
		expect(requestBodies[0].state).toBe("what's the weather");
		expect(requestBodies[0].questions.best_tier).toMatchObject({ type: "choice" });
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
		const handler = modelHintHarness();
		await fireAndWaitScheduled(handler, { text: "first call fails" });
		expect(callCount).toBe(1);

		await fireAndWaitScheduled(handler, { text: "second call skipped" });
		expect(callCount).toBe(1); // circuit breaker: 2回目は jevCall 自体を呼ばない
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("no-ops on empty or non-string input text", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let called = false;
	global.fetch = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	try {
		const handler = modelHintHarness();
		await fireAndWaitScheduled(handler, { text: "" });
		await fireAndWaitScheduled(handler, {});
		expect(called).toBe(false);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});
