import { afterEach, expect, spyOn, test } from "bun:test";
import { jevCall, parseEnvKeyLine } from "./jev-client.ts";

afterEach(() => {
	// biome-ignore lint/suspicious/noExplicitAny: restoring a spied global
	(globalThis.fetch as any)?.mockRestore?.();
});

test("parseEnvKeyLine extracts a quoted or bare value and ignores other keys", () => {
	expect(parseEnvKeyLine("JEV_API_KEY=sk-abc123\nOTHER=x", "JEV_API_KEY")).toBe("sk-abc123");
	expect(parseEnvKeyLine('JEV_API_KEY="sk-abc123"', "JEV_API_KEY")).toBe("sk-abc123");
	expect(parseEnvKeyLine("OTHER=x\n", "JEV_API_KEY")).toBeUndefined();
	expect(parseEnvKeyLine("", "JEV_API_KEY")).toBeUndefined();
});

test("jevCall posts state+questions and returns the parsed answers", async () => {
	const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.8 } } }), { status: 200 }),
	);
	const result = await jevCall("key", "some state", { q: { type: "noul", instructions: "?" } });
	expect(result.answers.q).toEqual({ type: "noul", noul: 0.8 });
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
	expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
	expect(JSON.parse(String(init.body))).toMatchObject({ state: "some state" });
});

test("jevCall throws on a non-2xx response instead of returning a partial result", async () => {
	spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
	await expect(jevCall("key", "state", {})).rejects.toThrow("Jev API 500");
});
