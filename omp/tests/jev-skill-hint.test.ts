import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// jev-skill-hint.ts computes LOG_PATH from process.cwd() at import time, so
// import it with cwd pointed at a throwaway directory — otherwise handler
// tests below would append real rows into this repo's shadow log. Dynamic
// import is required here (not a static-import exception, an actual load
// timing boundary): the module body must not run until cwd is redirected.
const scratchDir = mkdtempSync(join(tmpdir(), "omp-jev-skill-hint-"));
const originalCwd = process.cwd();
process.chdir(scratchDir);
const { default: jevSkillHint } = await import("../extensions/jev-skill-hint.ts");
process.chdir(originalCwd);
const LOG_PATH = join(scratchDir, ".agent-msgs/scratch/jev-skill-hint-metrics.jsonl");

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

type BeforeAgentStartHandler = (event: unknown, ctx: unknown) => Promise<{ message: { content: string } } | undefined>;
type ToolCallHandler = (event: unknown) => void;
type TurnEndHandler = () => void;

function skillHintHarness() {
	const handlers: { beforeAgentStart?: BeforeAgentStartHandler; toolCall?: ToolCallHandler; turnEnd?: TurnEndHandler } = {};
	jevSkillHint({
		on(event: string, h: never) {
			if (event === "before_agent_start") handlers.beforeAgentStart = h;
			if (event === "tool_call") handlers.toolCall = h;
			if (event === "turn_end") handlers.turnEnd = h;
		},
	} as never);
	return handlers as Required<typeof handlers>;
}

const THREE_SKILL_PROMPT = `<skills>
- alpha: First skill description.
- beta: Second skill
  continuation line for beta.
- gamma: Third skill description.
</skills>`;

function ctxWithSystemPrompt(systemPrompt: string | undefined) {
	return { getSystemPrompt: systemPrompt === undefined ? undefined : async () => systemPrompt };
}

function readLogLines(): Record<string, unknown>[] {
	return readFileSync(LOG_PATH, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("returns a skill hint and logs hits/extra reads/missed accepted against actual reads", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let callCount = 0;
	global.fetch = (async (_url: unknown, init: { body: string }) => {
		callCount++;
		const body = JSON.parse(init.body);
		if (body.questions.which_skill) {
			return new Response(
				JSON.stringify({
					answers: { which_skill: { type: "choice", choice: "alpha", probabilities: { alpha: 0.5, beta: 0.3, gamma: 0.2 } } },
				}),
				{ status: 200 },
			);
		}
		// fits_0=alpha (accept), fits_1=beta (reject), fits_2=gamma (accept, at threshold)
		const nouls = [0.9, 0.1, 0.3];
		const answers: Record<string, unknown> = {};
		for (const key of Object.keys(body.questions)) answers[key] = { type: "noul", noul: nouls[Number(key.replace("fits_", ""))] };
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as typeof fetch;

	try {
		const { beforeAgentStart, toolCall, turnEnd } = skillHintHarness();
		const result = await beforeAgentStart({ prompt: "investigate the bug" }, ctxWithSystemPrompt(THREE_SKILL_PROMPT));

		expect(callCount).toBe(2);
		expect(result?.message.content).toContain("alpha");
		expect(result?.message.content).toContain("gamma");
		expect(result?.message.content).not.toContain("beta");

		toolCall({ toolName: "read", input: { path: "skill://alpha" } }); // hit
		toolCall({ toolName: "read", input: { path: "skill://delta" } }); // extra read
		toolCall({ toolName: "read", input: { path: "skill://alpha" } }); // duplicate, deduped
		toolCall({ toolName: "read", input: { path: "src/foo.ts" } }); // not a skill:// read, ignored
		toolCall({ toolName: "bash", input: { path: "skill://ignored" } }); // wrong tool, ignored
		turnEnd();

		const [row] = readLogLines();
		expect(row.actualSkillReads).toEqual(["alpha", "delta"]);
		expect(row.hits).toBe(1);
		expect(row.extraReads).toBe(1);
		expect(row.missedAccepted).toBe(1); // gamma was accepted but never read
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("no-ops on empty prompt, missing getSystemPrompt, and an undersized roster", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let called = false;
	global.fetch = (async () => {
		called = true;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;

	try {
		const { beforeAgentStart, turnEnd } = skillHintHarness();
		expect(await beforeAgentStart({ prompt: "" }, ctxWithSystemPrompt(THREE_SKILL_PROMPT))).toBeUndefined();
		expect(await beforeAgentStart({ prompt: "task" }, ctxWithSystemPrompt(undefined))).toBeUndefined();
		expect(await beforeAgentStart({ prompt: "task" }, ctxWithSystemPrompt("no skills block here"))).toBeUndefined();
		expect(await beforeAgentStart({ prompt: "task" }, ctxWithSystemPrompt("<skills>\n- alpha: only one skill\n</skills>"))).toBeUndefined();
		expect(called).toBe(false);

		turnEnd(); // pending is still null across all no-op calls above; must not throw or append a row
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("returns no message when no shortlisted skill clears the fit threshold", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	global.fetch = (async (_url: unknown, init: { body: string }) => {
		const body = JSON.parse(init.body);
		if (body.questions.which_skill) {
			return new Response(
				JSON.stringify({
					answers: { which_skill: { type: "choice", choice: "alpha", probabilities: { alpha: 0.5, beta: 0.3, gamma: 0.2 } } },
				}),
				{ status: 200 },
			);
		}
		const answers: Record<string, unknown> = {};
		for (const key of Object.keys(body.questions)) answers[key] = { type: "noul", noul: 0.0 };
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as typeof fetch;

	try {
		const { beforeAgentStart } = skillHintHarness();
		const result = await beforeAgentStart({ prompt: "investigate the bug" }, ctxWithSystemPrompt(THREE_SKILL_PROMPT));
		expect(result).toBeUndefined();
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});

test("opens the circuit breaker and logs circuitOpen on the next turn after a failed call", async () => {
	process.env.JEV_API_KEY = "test-key";
	const originalFetch = global.fetch;
	let callCount = 0;
	global.fetch = (async () => {
		callCount++;
		return new Response("boom", { status: 500 });
	}) as typeof fetch;

	try {
		const { beforeAgentStart, turnEnd } = skillHintHarness();
		expect(await beforeAgentStart({ prompt: "first call fails" }, ctxWithSystemPrompt(THREE_SKILL_PROMPT))).toBeUndefined();
		turnEnd();

		expect(await beforeAgentStart({ prompt: "second call skipped" }, ctxWithSystemPrompt(THREE_SKILL_PROMPT))).toBeUndefined();
		turnEnd();
		expect(callCount).toBe(1); // circuit breaker skips the second call's Jev round-trips entirely

		const rows = readLogLines();
		const [firstRow, secondRow] = rows.slice(-2);
		expect(firstRow.jevError).toBe(true);
		expect(firstRow.circuitOpen).toBe(false);
		expect(secondRow.jevError).toBe(false);
		expect(secondRow.circuitOpen).toBe(true);
	} finally {
		global.fetch = originalFetch;
		delete process.env.JEV_API_KEY;
	}
});
