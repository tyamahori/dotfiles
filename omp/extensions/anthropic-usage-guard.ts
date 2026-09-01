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
// 3. 両 pool の使用率を editor 下の widget に常時表示する（Claude 5h / 7d /
//    モデル別 7d と Codex 週次枠）。データ源は同じ usage snapshot なので、
//    更新は session_start とチェック周期（5分毎）に揃う。
//
// 動作:
// - session_start で即チェックし、5分毎に再チェックする。
// - Anthropic 切替は現在モデルが Anthropic のときだけ行う。
// - 両 pool が同時に閾値超えの場合は切替を見送り、メインを Anthropic に留める
//   （subagent 用の Codex reserve を温存する）。
// - 一度切り替え/通知した後は、その枠が閾値を下回るまで再発火しない。
// - 両 pool が 98% 以上（実質枯渇）のときだけ、ローカル ollama を probe して
//   応答があればメインを qwen へ退避する。ollama 不在なら何もしない。
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
// 両pool枯渇時の最終退避先。ローカルollamaが「起動していてモデルが居る」
// 場合だけ使う(あれば使う)。chainに入れないのは、停止中でもretry budget
// を浪費する上、利用枠なし=常にeligible扱いでreserve帯から降格するため。
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const LOCAL_RESCUE_MODEL = "ollama/qwen3.6:35b-mlx";
const DEPLETED_PCT = 98;

type Model = { provider?: string; id?: string };

type Ctx = {
	hasUI?: boolean;
	ui?: {
		notify?: (message: string, level?: string) => void;
		setWidget?: (
			key: string,
			content?: string[],
			opts?: { placement?: "aboveEditor" | "belowEditor" },
		) => void;
	};
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

/** 指定 provider の limit 毎の最新有効行から、filter に合う最大使用率（整数%）。 */
function latestUsedPct(provider: string, limitFilter: string): number | null {
	try {
		const db = new Database(USAGE_DB, { readonly: true });
		try {
			const row = db
				.query(
					`SELECT CAST(MAX(u.used_fraction) * 100 + 0.5 AS INTEGER) AS pct
					 FROM usage_history u
					 WHERE lower(u.provider) = ?1
					   AND lower(u.limit_id) LIKE ?2
					   AND u.resets_at > ?3
					   AND u.recorded_at = (
					     SELECT MAX(x.recorded_at)
					     FROM usage_history x
					     WHERE lower(x.provider) = lower(u.provider)
					       AND lower(x.limit_id) = lower(u.limit_id)
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

/** limit 毎の最新行一覧（provider 単位、期限切れ除外）。
 *  Anthropic は使用量 0 の枠を utilization 0 / resets_at null で返すので、
 *  NULL を期限切れ扱いにすると枠リセット直後に Claude 表示が丸ごと消える。 */
function latestUsageRows(
	provider: string,
): { limitId: string; pct: number; resetsAt: number | null }[] {
	try {
		const db = new Database(USAGE_DB, { readonly: true });
		try {
			return db
				.query(
					`SELECT u.limit_id AS limitId,
					        CAST(u.used_fraction * 100 + 0.5 AS INTEGER) AS pct,
					        u.resets_at AS resetsAt
					 FROM usage_history u
					 WHERE lower(u.provider) = ?1
					   AND (u.resets_at IS NULL OR u.resets_at > ?2)
					   AND u.recorded_at = (
					     SELECT MAX(x.recorded_at)
					     FROM usage_history x
					     WHERE lower(x.provider) = lower(u.provider)
					       AND lower(x.limit_id) = lower(u.limit_id)
					   )
					 ORDER BY u.limit_id`,
				)
				.all(provider, Date.now()) as {
				limitId: string;
				pct: number;
				resetsAt: number | null;
			}[];
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

function formatReset(resetsAt: number | null): string {
	if (resetsAt === null) return "idle";
	const mins = Math.max(0, Math.round((resetsAt - Date.now()) / 60000));
	if (mins < 120) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function coloredPct(pct: number): string {
	if (pct >= 100 - USAGE_RESERVE_PCT) return `\x1b[31m${pct}%\x1b[39m`;
	if (pct >= 50) return `\x1b[33m${pct}%\x1b[39m`;
	return `${pct}%`;
}

function poolParts(
	provider: string,
	label: (limitId: string) => string | null,
): string[] {
	return latestUsageRows(provider).flatMap((row) => {
		const name = label(row.limitId);
		if (name === null) return [];
		return [
			`${name} ${coloredPct(row.pct)} \x1b[2m(${formatReset(row.resetsAt)})\x1b[22m`,
		];
	});
}

/** 両 pool の使用率1行。表示対象の枠が無ければ null。 */
export function buildUsageLine(): string | null {
	const claude = poolParts("anthropic", (id) =>
		id.startsWith("anthropic:") ? id.slice("anthropic:".length) : null,
	);
	// spark:* は補助枠で常時ほぼ0%のうえ意味が不明瞭なのでノイズとして省く。
	// guard の判定も primary（週次）だけを使っている。
	const codex = poolParts("openai-codex", (id) =>
		id === "openai-codex:primary" ? "wk" : null,
	);
	const pools: string[] = [];
	if (claude.length > 0) pools.push(`Claude ${claude.join(" · ")}`);
	if (codex.length > 0) pools.push(`Codex ${codex.join(" · ")}`);
	if (pools.length === 0) return null;
	return `\x1b[2musage\x1b[22m ${pools.join(" \x1b[2m│\x1b[22m ")}`;
}

const WIDGET_KEY = "usage-summary";

function updateWidget(ctx: Ctx | undefined): void {
	if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
	try {
		const line = buildUsageLine();
		ctx.ui.setWidget(WIDGET_KEY, line ? [line] : undefined, {
			placement: "belowEditor",
		});
	} catch {
		// widget 描画の失敗は guard 本体の判定に影響させない。
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
	let rescuedThisWindow = false;

	async function checkAnthropic(ctx: Ctx): Promise<void> {
		const pct = latestUsedPct("anthropic", "anthropic:7d%");
		if (pct === null || pct < 100 - USAGE_RESERVE_PCT) {
			switchedThisWindow = false;
			return;
		}
		if (switchedThisWindow || ctx.models?.current()?.provider !== "anthropic")
			return;

		// 両pool枯渇時はsubagent用のCodex reserveをメインで食わないよう切替を見送る。
		// 通知はcheckCodex側のCodex 80%通知が担う。
		const codexPct = latestUsedPct("openai-codex", "openai-codex:primary");
		if (codexPct !== null && codexPct >= 100 - USAGE_RESERVE_PCT) return;

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

	/** 両pool枯渇時のみ、ローカルollamaが応答しモデルが存在すれば切り替える。 */
	async function checkLocalRescue(ctx: Ctx): Promise<void> {
		const anthropicPct = latestUsedPct("anthropic", "anthropic:7d%");
		const codexPct = latestUsedPct("openai-codex", "openai-codex:primary");
		if (
			anthropicPct === null ||
			codexPct === null ||
			anthropicPct < DEPLETED_PCT ||
			codexPct < DEPLETED_PCT
		) {
			rescuedThisWindow = false;
			return;
		}
		if (rescuedThisWindow || ctx.models?.current()?.provider === "ollama")
			return;

		const wantedId = LOCAL_RESCUE_MODEL.split("/", 2)[1];
		try {
			const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
				signal: AbortSignal.timeout(1000),
			});
			if (!res.ok) return;
			const tags = (await res.json()) as { models?: { name?: string }[] };
			if (!tags.models?.some((m) => m.name === wantedId)) return;
		} catch {
			// ollama不在は正常系: 何もせず従来どおり枠リセットを待つ。
			return;
		}

		const target = await ctx.models?.resolve(LOCAL_RESCUE_MODEL);
		if (target && (await pi.setModel(target))) {
			rescuedThisWindow = true;
			notify(
				ctx,
				`usage-guard: 両pool枯渇（Anthropic ${anthropicPct}% / Codex ${codexPct}%）→ ローカル ${LOCAL_RESCUE_MODEL} へ退避。戻すには /model`,
			);
		}
	}

	async function check(ctx: Ctx | undefined): Promise<void> {
		updateWidget(ctx);
		if (inflight || !ctx?.models) return;
		inflight = true;
		try {
			await checkAnthropic(ctx);
			checkCodex(ctx);
			await checkLocalRescue(ctx);
		} finally {
			inflight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await check(ctx);
		ctx?.setInterval?.(() => void check(ctx), CHECK_INTERVAL_MS);
	});
}
