// Fable 専用7日枠(anthropic:7d:fable)または5時間枠(anthropic:5h)が
// 閾値以上消費されていたら、セッションのモデルを Fable から Codex(terra)へ
// 自動で切り替えるガード。
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
// - 一度切り替えたら、両方の枠が閾値を下回るまで再切替しない
//   (ユーザーが手動で Fable に戻した選択を尊重する)。
// - usage は `omp usage --json` サブプロセスで取得(omp 側キャッシュ約 5 分)。

import { execFile } from "node:child_process";

const THRESHOLD = 0.9;
const TARGET = "openai-codex/gpt-5.6-terra";
const LIMIT_LABELS = {
	"anthropic:7d:fable": "Fable 7日枠",
	"anthropic:5h": "5時間枠",
} as const;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type Rec = Record<string, unknown>;

type Model = { provider?: string; id?: string };

type LimitId = keyof typeof LIMIT_LABELS;
type QuotaUsage = { id: LimitId; usedFraction: number };

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

function isLimitId(value: unknown): value is LimitId {
	return value === "anthropic:7d:fable" || value === "anthropic:5h";
}

/** JSON ツリーから対象リミットの usedFraction をすべて集める。 */
function collectQuotaUsages(node: unknown, usages: QuotaUsage[]): void {
	if (Array.isArray(node)) {
		for (const item of node) collectQuotaUsages(item, usages);
		return;
	}
	const rec = asRecord(node);
	if (!rec) return;
	if (isLimitId(rec.id)) {
		const amount = asRecord(rec.amount);
		const usedFraction = amount?.usedFraction;
		if (typeof usedFraction === "number") usages.push({ id: rec.id, usedFraction });
	}
	for (const value of Object.values(rec)) collectQuotaUsages(value, usages);
}

function fetchQuotaUsages(): Promise<QuotaUsage[]> {
	const { promise, resolve } = Promise.withResolvers<QuotaUsage[]>();
	execFile("omp", ["usage", "--json", "--provider", "anthropic"], { timeout: 20_000 }, (error, stdout) => {
		if (error) return resolve([]);
		try {
			const usages: QuotaUsage[] = [];
			collectQuotaUsages(JSON.parse(stdout), usages);
			resolve(usages);
		} catch {
			resolve([]);
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
	// 一度自動切替したら、両方の枠が閾値を下回るまで再切替しない。
	let switchedThisWindow = false;

	async function check(ctx: Ctx | undefined): Promise<void> {
		if (inflight || !ctx?.models) return;
		inflight = true;
		try {
			const exhausted = (await fetchQuotaUsages()).find((usage) => usage.usedFraction >= THRESHOLD);
			if (!exhausted) {
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
					? `fable-usage-guard: ${LIMIT_LABELS[exhausted.id]} ${Math.round(exhausted.usedFraction * 100)}% 消費 → ${TARGET} へ切替`
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
