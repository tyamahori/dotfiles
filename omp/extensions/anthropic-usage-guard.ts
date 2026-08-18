// Anthropic 7日枠（モデル別枠を含む）の残量が20%以下になったら、
// セッションのモデルを Codex へ自動で切り替えるガード。
//
// omp 本体の usage-aware fallback は provider 全体の枠を判定する一方、
// anthropic:7d:fable などのモデル別枠では reserve 到達時に発火しない。
// agent.db の最新 usage snapshot を直接読み、この穴だけを補う。
//
// 動作:
// - session_start で即チェックし、5分毎に再チェックする。
// - 現在モデルが Anthropic のときだけ切り替える。
// - 一度切り替えた後に手動で Anthropic へ戻した場合は、その枠がリセット
//   されるまで再切替しない。
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

/** 最新の有効なAnthropic 7日枠で最大の使用率（整数%）。 */
function anthropicWeeklyUsedPct(): number | null {
	try {
		const db = new Database(USAGE_DB, { readonly: true });
		try {
			const row = db
				.query(
					`SELECT CAST(MAX(used_fraction) * 100 + 0.5 AS INTEGER) AS pct
					 FROM usage_history
					 WHERE lower(provider) = 'anthropic'
					   AND lower(limit_id) LIKE 'anthropic:7d%'
					   AND resets_at > ?
					   AND recorded_at = (
					     SELECT MAX(recorded_at)
					     FROM usage_history
					     WHERE lower(provider) = 'anthropic'
					   )`,
				)
				.get(Date.now()) as { pct: number | null } | null;
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
	pi.setLabel?.("Anthropic Usage Guard");

	let inflight = false;
	let switchedThisWindow = false;

	async function check(ctx: Ctx | undefined): Promise<void> {
		if (inflight || !ctx?.models) return;
		inflight = true;
		try {
			const pct = anthropicWeeklyUsedPct();
			if (pct === null || pct < 100 - USAGE_RESERVE_PCT) {
				switchedThisWindow = false;
				return;
			}
			if (
				switchedThisWindow ||
				ctx.models.current()?.provider !== "anthropic"
			)
				return;

			for (const spec of CODEX_FALLBACKS) {
				const target = await ctx.models.resolve(spec);
				if (target && (await pi.setModel(target))) {
					switchedThisWindow = true;
					notify(
						ctx,
						`anthropic-usage-guard: Anthropic 7日枠 ${pct}% 使用（残り${100 - pct}% ≤ ${USAGE_RESERVE_PCT}%）→ ${spec} へ切替`,
					);
					return;
				}
			}
			notify(
				ctx,
				`anthropic-usage-guard: Anthropic 7日枠 ${pct}% 使用だがCodex切替先を解決できません`,
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
