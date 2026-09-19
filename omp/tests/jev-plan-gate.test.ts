import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// jev-plan-gate.ts computes LOG_PATH from process.cwd() at import time, so
// import it with cwd pointed at a throwaway directory — otherwise handler
// tests below would append real rows into this repo's shadow log. Dynamic
// import is required here (not a static-import exception, an actual load
// timing boundary): the module body must not run until cwd is redirected.
const scratchDir = mkdtempSync(join(tmpdir(), "omp-jev-plan-gate-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);
const { default: jevPlanGate } = await import("../extensions/jev-plan-gate.ts");
process.chdir(originalCwd);

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

type TurnEndHandler = (event: unknown, ctx: unknown) => Promise<void>;

function planGateHarness(sendMessage: (message: unknown, options: unknown) => void) {
	let handler: TurnEndHandler | undefined;
	jevPlanGate({
		on(event: string, h: TurnEndHandler) {
			if (event === "turn_end") handler = h;
		},
		sendMessage,
	} as never);
	return handler!;
}

function ctxWithAssistantText(text: string) {
	return {
		sessionManager: {
			getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }],
		},
	};
}

const PLAN_WITH_FOUR_CANDIDATES = `Here is my plan.

<proposed_plan>
- keep this necessary step
- keep this necessary step
* flag this speculative step
  - flag this too (indented)
3. numbered necessary step
not a list line, ignored
</proposed_plan>
`;

test("flags candidates below the necessity threshold and delivers a next-turn hint", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	const requestBodies: { state: string; questions: Record<string, unknown> }[] = [];
	global.fetch = (async (_url: unknown, init: { body: string }) => {
		const body = JSON.parse(init.body);
		requestBodies.push(body);
		const answers: Record<string, unknown> = {};
		const nouls = [0.9, 0.1, 0.2, 0.8]; // index 1 and 2 are flagged as unnecessary
		for (const key of Object.keys(body.questions)) {
			const i = Number(key.replace("necessary_", ""));
			answers[key] = { type: "noul", noul: nouls[i] };
		}
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as typeof fetch;

	const sent: { message: { content: string }; options: unknown }[] = [];
	try {
		const handler = planGateHarness((message, options) => sent.push({ message: message as { content: string }, options }));
		await handler(undefined, ctxWithAssistantText(PLAN_WITH_FOUR_CANDIDATES));

		expect(requestBodies).toHaveLength(1);
		expect(Object.keys(requestBodies[0].questions)).toEqual(["necessary_0", "necessary_1", "necessary_2", "necessary_3"]);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toContain("flag this speculative step");
		expect(sent[0].message.content).toContain("flag this too (indented)");
		expect(sent[0].message.content).not.toContain("keep this necessary step");
		expect(sent[0].options).toEqual({ deliverAs: "nextTurn" });
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("no-ops when the last assistant message has no proposed_plan block", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let called = false;
	global.fetch = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	try {
		const handler = planGateHarness(() => {
			throw new Error("sendMessage must not be called");
		});
		await handler(undefined, ctxWithAssistantText("just a regular reply, no plan here"));
		await handler(undefined, {}); // no sessionManager at all
		expect(called).toBe(false);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("no-ops when the candidate count is outside the 2-8 range", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let called = false;
	global.fetch = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	const tooFew = "<proposed_plan>\n- only one step\n</proposed_plan>";
	const tooMany = `<proposed_plan>\n${Array.from({ length: 9 }, (_, i) => `- step ${i}`).join("\n")}\n</proposed_plan>`;

	try {
		const handler = planGateHarness(() => {
			throw new Error("sendMessage must not be called");
		});
		await handler(undefined, ctxWithAssistantText(tooFew));
		await handler(undefined, ctxWithAssistantText(tooMany));
		expect(called).toBe(false);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("does not send a hint when every candidate is judged necessary", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let callCount = 0;
	global.fetch = (async (_url: unknown, init: { body: string }) => {
		callCount++;
		const body = JSON.parse(init.body);
		const answers: Record<string, unknown> = {};
		for (const key of Object.keys(body.questions)) answers[key] = { type: "noul", noul: 0.95 };
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as typeof fetch;

	try {
		const handler = planGateHarness(() => {
			throw new Error("sendMessage must not be called");
		});
		await handler(undefined, ctxWithAssistantText("<proposed_plan>\n- necessary step one\n- necessary step two\n</proposed_plan>"));
		expect(callCount).toBe(1);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("opens the circuit breaker and stops calling Jev after a failed call", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let callCount = 0;
	global.fetch = (async () => {
		callCount++;
		return new Response("boom", { status: 500 });
	}) as typeof fetch;

	const plan = "<proposed_plan>\n- necessary step one\n- necessary step two\n</proposed_plan>";
	try {
		const handler = planGateHarness(() => {
			throw new Error("sendMessage must not be called");
		});
		await handler(undefined, ctxWithAssistantText(plan));
		expect(callCount).toBe(1);

		await handler(undefined, ctxWithAssistantText(plan));
		expect(callCount).toBe(1); // circuit breaker skips the second call entirely
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});
