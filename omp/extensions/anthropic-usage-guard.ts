// subscription pool の残量ガード。
//
// 1. Anthropic 7日枠（モデル別枠を含む）の残量が20%以下になったら、
//    セッションのモデルを Codex へ自動で切り替える。
//    omp 本体の usage-aware fallback は provider 全体の枠を判定する一方、
//    anthropic:7d:fable などのモデル別枠では reserve 到達時に発火しない。
//    agent.db の最新 usage snapshot を直接読み、この穴だけを補う。
// 2. Codex 週次枠（openai-codex:primary）の残量が20%以下になったら通知する。
//    切替はしない: provider 全体枠なので omp 本体の usage-aware fallback が
//    retry.fallbackChains（openai-codex/* → anthropic）で退避する。
//
// 動作:
// - session_start で即チェックし、5分毎に再チェックする。
// - Anthropic 切替は現在モデルが Anthropic のときだけ行う。
// - 一度切り替え/通知した後は、その枠が閾値を下回るまで再発火しない。
// - 閾値と切替先は omp/config.yml の retry 設定と揃える。

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_DB =
	process.env.OMP_AGENT_DB ?? join(homedir(), ".omp/agent/agent.db");
const USAGE_RESERVE_PCT = 20;
const CODEX_FALLBACKS = [
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.4",
];
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

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
	on(
		event: string,
		handler: (event: unknown, ctx: Ctx | undefined) => void | Promise<void>,
	): void;
	setModel(model: Model): Promise<boolean>;
};

/** 指定 provider の最新かつ有効な枠のうち、filter に合う最大使用率（整数%）。 */
function latestUsedPct(provider: string, limitFilter: string): number | null {
	try {
		const db = new Database(USAGE_DB, { readonly: true });
		try {
			const row = db
				.query(
					`SELECT CAST(MAX(used_fraction) * 100 + 0.5 AS INTEGER) AS pct
					 FROM usage_history
					 WHERE lower(provider) = ?1
					   AND lower(limit_id) LIKE ?2
					   AND resets_at > ?3
					   AND recorded_at = (
					     SELECT MAX(recorded_at)
					     FROM usage_history
					     WHERE lower(provider) = ?1
					   )`,
				)
				.get(provider, limitFilter, Date.now()) as {
				pct: number | null;
			} | null;
			return typeof row?.pct === "number" ? row.pct : null;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

function notify(ctx: Ctx | undefined, message: string): void {
	if (!ctx?.hasUI) return;
	try {
		ctx.ui?.notify?.(message, "warning");
	} catch {
		// UI通知の失敗はモデル切替を巻き戻さない。
	}
}

export default function (pi: ExtensionHandlerApi): void {
	pi.setLabel?.("Usage Guard");

	let inflight = false;
	let switchedThisWindow = false;
	let codexNotifiedThisWindow = false;

	async function checkAnthropic(ctx: Ctx): Promise<void> {
		const pct = latestUsedPct("anthropic", "anthropic:7d%");
		if (pct === null || pct < 100 - USAGE_RESERVE_PCT) {
			switchedThisWindow = false;
			return;
		}
		if (switchedThisWindow || ctx.models?.current()?.provider !== "anthropic")
			return;

		for (const spec of CODEX_FALLBACKS) {
			const target = await ctx.models?.resolve(spec);
			if (target && (await pi.setModel(target))) {
				switchedThisWindow = true;
				notify(
					ctx,
					`usage-guard: Anthropic 7日枠 ${pct}% 使用（残り${100 - pct}% ≤ ${USAGE_RESERVE_PCT}%）→ ${spec} へ切替`,
				);
				return;
			}
		}
		notify(
			ctx,
			`usage-guard: Anthropic 7日枠 ${pct}% 使用だがCodex切替先を解決できません`,
		);
	}

	function checkCodex(ctx: Ctx): void {
		const pct = latestUsedPct("openai-codex", "openai-codex:primary");
		if (pct === null || pct < 100 - USAGE_RESERVE_PCT) {
			codexNotifiedThisWindow = false;
			return;
		}
		if (codexNotifiedThisWindow) return;
		codexNotifiedThisWindow = true;
		notify(
			ctx,
			`usage-guard: Codex 週次枠 ${pct}% 使用（残り${100 - pct}% ≤ ${USAGE_RESERVE_PCT}%）。退避は retry.fallbackChains が処理`,
		);
	}

	async function check(ctx: Ctx | undefined): Promise<void> {
		if (inflight || !ctx?.models) return;
		inflight = true;
		try {
			await checkAnthropic(ctx);
			checkCodex(ctx);
		} finally {
			inflight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await check(ctx);
		ctx?.setInterval?.(() => void check(ctx), CHECK_INTERVAL_MS);
	});
}
