// PR レビュー観点(agents/skills/github-pr-review/SKILL.md の「観点」表)の
// shadow ログ CLI。github-pr-review スキルの手順から任意で呼ばれる。
//
// 目的: 診断済みの diff から、Jev が「変更種別」表のどの行が該当すると予測
// するかと、レビュー担当が実際に確定した該当行を、同じ `--ref` で突き合わせて
// ログするだけ。**レビュー結果には一切影響しない**:
// - Jev の予測は stdout は元より、どこにも表示しない(先にレビュー担当が
//   読むとその判断に無意識に引きずられるため)。ログ(JSONL)のみに書く。
// - どんな失敗でも常に exit 0。レビューを絶対にブロックしない。
//
// 行カテゴリ(変更種別)は SKILL.md の表からその場で抽出する。ハードコード
// しない — 表の行が増減しても本スクリプトの更新は要らない。
//
// Jev が使えない場合:
// - `JEV_API_KEY` 未設定 → predict は何もせず終了(no-op)。
// - Jev 呼び出し失敗・タイムアウト → 何も出力せず、jevError:true とだけ
//   ログして終了。呼び出し元(レビュー担当)には一切伝播しない。
//
// 使い方(github-pr-review SKILL.md 参照):
//   bun "$HOME/dotfiles/scripts/jev-pr-lens-shadow.ts" predict --ref <ref> --diff-file <path>
//   bun "$HOME/dotfiles/scripts/jev-pr-lens-shadow.ts" actual --ref <ref> --rows "バグ修正,データアクセス"

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type NoulAnswer, appendJsonlLog, jevCall, loadJevApiKey } from "./jev-client.ts";

const DOTFILES_ROOT = join(import.meta.dir, "..");
const SKILL_MD_PATH = join(DOTFILES_ROOT, "agents/skills/github-pr-review/SKILL.md");
const LOG_PATH = join(DOTFILES_ROOT, ".agent-msgs/scratch/jev-pr-lens-shadow.jsonl");
const MAX_DIFF_CHARS = 8_000;

/** SKILL.md の「| 変更種別 | 必ず問う質問 |」表を行ごとに抽出する。
 * ハードコードしない — 表の追加・削除に追随する。 */
export function extractRowCategories(skillMd: string): Record<string, string> {
	const headerIdx = skillMd.indexOf("| 変更種別 |");
	if (headerIdx === -1) return {};
	const lines = skillMd.slice(headerIdx).split("\n");
	const rows: Record<string, string> = {};
	// lines[0] = ヘッダー行, lines[1] = 区切り行(|---|---|)。データ行はそれ以降、
	// テーブル形式でなくなった時点(表の終わり)で止める。
	for (let i = 2; i < lines.length; i++) {
		const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(lines[i]);
		if (!m) break;
		rows[m[1]] = m[2];
	}
	return rows;
}

type ParsedArgs = { sub?: string; ref?: string; diffFile?: string; rows?: string };

function parseArgs(argv: string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	for (let i = 1; i < argv.length; i += 2) {
		const key = argv[i];
		if (!key?.startsWith("--")) continue;
		flags[key.slice(2)] = argv[i + 1] ?? "";
	}
	return { sub: argv[0], ref: flags.ref, diffFile: flags["diff-file"], rows: flags.rows };
}

async function runPredict(ref: string, diffFile: string | undefined): Promise<void> {
	const apiKey = loadJevApiKey(DOTFILES_ROOT);
	if (!apiKey) return; // JEV_API_KEY 未設定 = 完全な no-op。

	if (!diffFile) return;
	let diffText: string;
	try {
		diffText = readFileSync(diffFile, "utf-8");
	} catch {
		return; // diff が読めない = 何もせず終了(ブロックしない)。
	}
	if (!diffText.trim()) return;

	let skillMd: string;
	try {
		skillMd = readFileSync(SKILL_MD_PATH, "utf-8");
	} catch {
		return;
	}
	const rowCategories = extractRowCategories(skillMd);
	const keys = Object.keys(rowCategories);
	if (keys.length === 0) return;

	const truncated = diffText.length > MAX_DIFF_CHARS ? diffText.slice(0, MAX_DIFF_CHARS) : diffText;
	const questions: Record<string, unknown> = {};
	keys.forEach((key, i) => {
		questions[`row_${i}`] = {
			type: "noul",
			instructions: `Does this diff include a change of type "${key}" (required questions for that type: ${rowCategories[key]})?`,
		};
	});

	const start = Date.now();
	try {
		const resp = await jevCall(apiKey, truncated, questions);
		const probabilities: Record<string, number> = {};
		keys.forEach((key, i) => {
			probabilities[key] = (resp.answers[`row_${i}`] as NoulAnswer).noul;
		});
		appendJsonlLog(LOG_PATH, {
			ts: Date.now(),
			kind: "predict",
			ref,
			diffChars: diffText.length,
			rowCount: keys.length,
			probabilities,
			latencyMs: Date.now() - start,
			jevError: false,
		});
	} catch {
		appendJsonlLog(LOG_PATH, {
			ts: Date.now(),
			kind: "predict",
			ref,
			diffChars: diffText.length,
			rowCount: keys.length,
			probabilities: null,
			latencyMs: Date.now() - start,
			jevError: true,
		});
	}
}

function runActual(ref: string, rowsArg: string | undefined): void {
	const rowKeys = (rowsArg ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	appendJsonlLog(LOG_PATH, { ts: Date.now(), kind: "actual", ref, rows: rowKeys });
}

if (import.meta.main) {
	const { sub, ref, diffFile, rows } = parseArgs(process.argv.slice(2));
	try {
		if (ref && sub === "predict") await runPredict(ref, diffFile);
		else if (ref && sub === "actual") runActual(ref, rows);
		// sub/ref が不正でも何も出さず正常終了する — レビューを絶対にブロックしない。
	} catch {
		// 何が起きても exit 0。
	}
}
