// 共有 Jev (TypeSafe systemone) クライアント。
// omp/extensions/jev-skill-hint.ts, omp/extensions/jev-plan-gate.ts,
// .omp/extensions/jev-agent-hint.ts, scripts/jev-pr-lens-shadow.ts が使う。
//
// このモジュール自体は「Jev が使えない」を隠蔽しない。キー未設定は
// loadJevApiKey が undefined を返すだけ、呼び出し失敗は jevCall が例外を
// 投げるだけ。無音 no-op・circuit breaker・shadow-only ログは各呼び出し元の
// 責務(用途ごとに「失敗時どこまで諦めるか」が違うため、ここで一律に決めない)。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 8_000;

export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number> };
export type NoulAnswer = { type: "noul"; noul: number };
export type JevAnswer = ChoiceAnswer | NoulAnswer;
export type JevResponse = { answers: Record<string, JevAnswer> };

/** `NAME=value` 形式の行を1本抽出する(引用符除去込み)。`.env` フォールバック
 * 探索から切り出したテスト可能な純関数。 */
export function parseEnvKeyLine(content: string, name: string): string | undefined {
	for (const line of content.split("\n")) {
		const m = new RegExp(`^${name}=(.+)$`).exec(line.trim());
		if (m) return m[1].trim().replace(/^["']|["']$/g, "");
	}
	return undefined;
}

/** 環境変数、なければ `dotfilesRoot/.env`(gitignore 済み)から JEV_API_KEY を
 * 読む。値はここでしか読まない。見つからなければ undefined — 呼び出し元は
 * 完全な no-op として扱うこと。 */
export function loadJevApiKey(dotfilesRoot: string): string | undefined {
	if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
	try {
		const envPath = join(dotfilesRoot, ".env");
		if (!existsSync(envPath)) return undefined;
		return parseEnvKeyLine(readFileSync(envPath, "utf-8"), "JEV_API_KEY");
	} catch {
		// .env が読めない環境。Jev 無効として続行する。
		return undefined;
	}
}

/** 1回の Jev API 呼び出し。ネットワーク断・タイムアウト・非2xx・不正な
 * レスポンス形式はすべて例外で伝える。リトライはしない — 呼び出し元が
 * circuit breaker と無音フォールバックを実装すること。 */
export async function jevCall(
	apiKey: string,
	state: string,
	questions: Record<string, unknown>,
	timeoutMs: number = JEV_TIMEOUT_MS,
): Promise<JevResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(JEV_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ state, model: JEV_MODEL, questions }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`Jev API ${res.status}`);
		return (await res.json()) as JevResponse;
	} finally {
		clearTimeout(timer);
	}
}

/** JSONL 追記ログ(ディレクトリ自動作成込み)。失敗しても例外を投げない —
 * ログ書き込みの失敗を呼び出し元(extension/CLI)本来の処理を止める理由に
 * しないため。 */
export function appendJsonlLog(path: string, record: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		// ログ書き込み失敗は呼び出し元の処理を止める理由にしない。
	}
}
