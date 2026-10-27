import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRowCategories, runActual, runPredict } from "./jev-pr-lens-shadow.ts";

const savedKey = process.env.JEV_API_KEY;
afterEach(() => {
	mock.restore();
	if (savedKey === undefined) delete process.env.JEV_API_KEY;
	else process.env.JEV_API_KEY = savedKey;
});

function scratch(): { dir: string; log: string } {
	const dir = mkdtempSync(join(tmpdir(), "lens-"));
	return { dir, log: join(dir, "log.jsonl") };
}

function readLog(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

const SAMPLE_SKILL_MD = `### 観点

共通:

- 正しさ: 境界値・空・重複・並行実行で壊れないか

変更種別ごと:

| 変更種別 | 必ず問う質問 |
|---|---|
| バグ修正 | 修正を戻すとそのテストは落ちるか |
| データアクセス（クエリ・ファイル I/O・外部呼び出し） | データ量に比例して壊れないか |
| CI・ビルド・スクリプト | 失敗が失敗として伝播するか |

表にない種別に当たったら、その変更が壊すものを1つ想定する。
`;

test("extractRowCategories pulls every table row keyed by 変更種別", () => {
	const rows = extractRowCategories(SAMPLE_SKILL_MD);
	expect(Object.keys(rows)).toEqual(["バグ修正", "データアクセス（クエリ・ファイル I/O・外部呼び出し）", "CI・ビルド・スクリプト"]);
	expect(rows["バグ修正"]).toBe("修正を戻すとそのテストは落ちるか");
});

test("extractRowCategories returns empty when the table header is absent", () => {
	expect(extractRowCategories("no table here")).toEqual({});
});

test("extractRowCategories still finds the table in the real SKILL.md", () => {
	const skillMd = readFileSync(join(import.meta.dir, "..", "agents/skills/github-pr-review/SKILL.md"), "utf-8");
	const rows = extractRowCategories(skillMd);
	expect(rows["バグ修正"]).toBeDefined();
});

test("runActual logs the trimmed, non-empty row keys under the ref", () => {
	const { log } = scratch();
	runActual("a..b", " バグ修正 ,, CI・ビルド・スクリプト ", log);
	expect(readLog(log)).toMatchObject([{ kind: "actual", ref: "a..b", rows: ["バグ修正", "CI・ビルド・スクリプト"] }]);
});

test("runPredict maps each row's noul answer back to its 変更種別", async () => {
	const { dir, log } = scratch();
	const diff = join(dir, "d.diff");
	writeFileSync(diff, "+fix\n");
	process.env.JEV_API_KEY = "key";
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: RequestInit) => {
		const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const answers = Object.fromEntries(Object.keys(questions).map((k, i) => [k, { type: "noul", noul: i === 0 ? 0.9 : 0.1 }]));
		return new Response(JSON.stringify({ answers }));
	}) as typeof fetch);
	await runPredict("a..b", diff, log);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	const [row] = readLog(log) as [{ jevError: boolean; rowCount: number; probabilities: Record<string, number> }];
	expect(row.jevError).toBe(false);
	expect(Object.keys(row.probabilities)).toHaveLength(row.rowCount);
	expect(row.probabilities["バグ修正"]).toBe(0.9);
});

test("runPredict records a jevError row instead of throwing when Jev fails", async () => {
	const { dir, log } = scratch();
	const diff = join(dir, "d.diff");
	writeFileSync(diff, "+fix\n");
	process.env.JEV_API_KEY = "key";
	spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
	await runPredict("a..b", diff, log);
	expect(readLog(log)).toMatchObject([{ kind: "predict", jevError: true, probabilities: null }]);
});

test("runPredict writes nothing for a missing or empty diff", async () => {
	const { dir, log } = scratch();
	process.env.JEV_API_KEY = "key";
	const fetchSpy = spyOn(globalThis, "fetch");
	await runPredict("a..b", join(dir, "missing.diff"), log);
	writeFileSync(join(dir, "empty.diff"), "  \n");
	await runPredict("a..b", join(dir, "empty.diff"), log);
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(() => readFileSync(log)).toThrow();
});
