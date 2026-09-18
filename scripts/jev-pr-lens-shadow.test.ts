import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { extractRowCategories } from "./jev-pr-lens-shadow.ts";

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

test("extractRowCategories matches the real SKILL.md and finds all 10 rows", () => {
	const skillMd = readFileSync(join(import.meta.dir, "..", "agents/skills/github-pr-review/SKILL.md"), "utf-8");
	const rows = extractRowCategories(skillMd);
	expect(Object.keys(rows)).toHaveLength(10);
	expect(rows["バグ修正"]).toBeDefined();
});
