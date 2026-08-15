// Fable 専用 7 日枠(anthropic:7d:fable)が閾値以上消費されていたら、
// セッションのモデルを Fable から Codex(terra)へ自動で切り替えるガード。
//
// 背景: omp 本体の usage-aware reserve フォールバックは Fable/Mythos の
// tier 専用週次カウンターを「完全枯渇(100% / server exhausted)が確認される
// まで」判定から除外する(packages/ai/src/usage/claude.ts の
// scopeClaudeLimitsForModelHardBlock、v17.3.4 で確認)。そのため
// usageReservePct を設定していても残量わずかな Fable のまま走り続ける。
// 起動時の穴は .zshrc の omp ラッパが塞ぐが、セッション中に閾値を跨いだ
// ケースはこの拡張が拾う。
//
// 動作:
// - session_start で即チェック + 5 分毎の定期チェック(ctx.setInterval)。
// - 現在モデルが Anthropic の fable 系のときだけ切り替える(手動で他モデルに
//   している場合は何もしない)。
// - 一度切り替えたら、枠がリセットされて閾値を下回るまで再切替しない
//   (ユーザーが手動で Fable に戻した選択を尊重する)。
// - usage は `omp usage --json` サブプロセスで取得(omp 側キャッシュ約 5 分)。

import { execFile } from "node:child_process";

const THRESHOLD = 0.9;
const TARGET = "openai-codex/gpt-5.6-terra";
const LIMIT_ID = "anthropic:7d:fable";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type Rec = Record<string, unknown>;

type Model = { provider?: string; id?: string };

type Ctx = {
	hasUI?: boolean;
	ui?: { notify?: (message: string, level?: string) => void };
	models?: {
		current(): Model | undefined;
		resolve(spec: string): Model | undefined | Promise<Model | undefined>;
	};
	setInterval?: (fn: () => void, ms: number) => unknown;
};

type ExtensionHandlerApi = {
	setLabel?(label: string): void;
	on(event: string, handler: (event: unknown, ctx: Ctx | undefined) => void | Promise<void>): void;
	setModel(model: Model): Promise<boolean>;
};

function asRecord(value: unknown): Rec | undefined {
	return typeof value === "object" && value !== null ? (value as Rec) : undefined;
}

/** JSON ツリーから id === LIMIT_ID のリミット行を探し usedFraction を返す。 */
function findFableUsedFraction(node: unknown): number | undefined {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findFableUsedFraction(item);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	const rec = asRecord(node);
	if (!rec) return undefined;
	if (rec.id === LIMIT_ID) {
		const amount = asRecord(rec.amount);
		const fraction = amount?.usedFraction;
		if (typeof fraction === "number") return fraction;
	}
	for (const value of Object.values(rec)) {
		const found = findFableUsedFraction(value);
		if (found !== undefined) return found;
	}
	return undefined;
}

function fetchFableUsedFraction(): Promise<number | undefined> {
	const { promise, resolve } = Promise.withResolvers<number | undefined>();
	execFile("omp", ["usage", "--json", "--provider", "anthropic"], { timeout: 20_000 }, (error, stdout) => {
		if (error) return resolve(undefined);
		try {
			resolve(findFableUsedFraction(JSON.parse(stdout)));
		} catch {
			resolve(undefined);
		}
	});
	return promise;
}

function notify(ctx: Ctx | undefined, message: string): void {
	try {
		ctx?.ui?.notify?.(message, "warning");
	} catch {
		// UI が無いモード(headless/subagent)では黙って続行する。
	}
}

export default function (pi: ExtensionHandlerApi): void {
	pi.setLabel?.("Fable Usage Guard");

	let inflight = false;
	// 一度自動切替したらリセット(閾値割れ)まで再切替しない。
	let switchedThisWindow = false;

	async function check(ctx: Ctx | undefined): Promise<void> {
		if (inflight || !ctx?.models) return;
		inflight = true;
		try {
			const fraction = await fetchFableUsedFraction();
			if (fraction === undefined) return;
			if (fraction < THRESHOLD) {
				switchedThisWindow = false;
				return;
			}
			if (switchedThisWindow) return;
			const current = ctx.models.current();
			const onFable =
				current?.provider === "anthropic" && typeof current.id === "string" && current.id.includes("fable");
			if (!onFable) return;
			const target = await ctx.models.resolve(TARGET);
			if (!target) {
				notify(ctx, `fable-usage-guard: 切替先 ${TARGET} を解決できません`);
				return;
			}
			const ok = await pi.setModel(target);
			switchedThisWindow = true;
			notify(
				ctx,
				ok
					? `fable-usage-guard: Fable 7d枠 ${Math.round(fraction * 100)}% 消費 → ${TARGET} へ切替`
					: `fable-usage-guard: ${TARGET} へ切替失敗(認証情報なし)`,
			);
		} finally {
			inflight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await check(ctx);
		ctx?.setInterval?.(() => void check(ctx), CHECK_INTERVAL_MS);
	});
}
