// subscription pool の残量ガード。
//
// Anthropic 7日枠（モデル別枠 anthropic:7d:fable などを含む）の reserve 到達時の
// Codex 切替は、omp 本体の usage-aware fallback が担う（Claude の
// scopeLimitsForReserve が共通枠と現在モデルの family/tier 枠を見る）。
// この extension は本体に無い部分だけを補う。
//
// 1. Codex 週次枠（openai-codex:primary）の残量が20%以下になったら通知する。
//    切替はしない: omp 本体の usage-aware fallback が
//    retry.fallbackChains（openai-codex/* → anthropic）で退避する。
// 2. 両 pool の使用率を editor 下の widget に常時表示する（Claude 5h / 7d /
//    モデル別 7d と Codex 週次枠）。複数アカウントでは枠ごとに最も余裕のある
//    アカウントの値を出す。データ源は agent.db の最新 usage snapshot で、
//    更新は session_start とチェック周期（5分毎）に揃う。
// 3. 両 pool が 98% 以上（実質枯渇）のときだけ、ローカル ollama を probe して
//    応答があればメインを qwen へ退避する。ollama 不在なら何もしない。
//
// 一度通知/退避した後は、その枠が閾値を下回るまで再発火しない。

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

// getAgentDir() は --profile / OMP_PROFILE / XDG を解決済みの agent dir を返す。
// ~/.omp/agent 固定だと team プロファイルでも既定プロファイルの枠を監視してしまう。
const USAGE_DB = join(getAgentDir(), "agent.db");
const USAGE_RESERVE_PCT = 20;
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

type UsageRow = {
	provider: string;
	accountKey: string;
	limitId: string;
	pct: number;
	resetsAt: number | null;
};

/** account・limit 毎の最新行一覧（期限切れ除外）。
 *  Anthropic は使用量 0 の枠を utilization 0 / resets_at null で返すので、
 *  NULL を期限切れ扱いにすると枠リセット直後に Claude 表示が丸ごと消える。 */
function latestUsageRows(): UsageRow[] {
	try {
		const db = new Database(USAGE_DB, { readonly: true });
		try {
			return db
				.query(
					`SELECT lower(u.provider) AS provider,
					        coalesce(u.account_key, '') AS accountKey,
					        u.limit_id AS limitId,
					        CAST(u.used_fraction * 100 + 0.5 AS INTEGER) AS pct,
					        u.resets_at AS resetsAt
					 FROM usage_history u
					 WHERE (u.resets_at IS NULL OR u.resets_at > ?1)
					   AND u.recorded_at = (
					     SELECT MAX(x.recorded_at)
					     FROM usage_history x
					     WHERE lower(x.provider) = lower(u.provider)
					       AND coalesce(x.account_key, '') = coalesce(u.account_key, '')
					       AND lower(x.limit_id) = lower(u.limit_id)
					   )
					 ORDER BY u.limit_id`,
				)
				.all(Date.now()) as UsageRow[];
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

/** filter に合う枠の使用率（整数%）。アカウント毎に最大を取り、
 *  アカウント間では最小（omp 本体が選べる最も余裕のあるアカウント）を返す。 */
function latestUsedPct(
	rows: UsageRow[],
	provider: string,
	limitFilter: string,
): number | null {
	const filter = limitFilter.toLowerCase();
	const prefix = filter.endsWith("%") ? filter.slice(0, -1) : undefined;
	const perAccount = new Map<string, number>();
	for (const row of rows) {
		if (
			row.provider !== provider ||
			row.resetsAt === null ||
			row.resetsAt <= Date.now() ||
			(prefix ? !row.limitId.toLowerCase().startsWith(prefix) : row.limitId.toLowerCase() !== filter)
		) {
			continue;
		}
		perAccount.set(row.accountKey, Math.max(perAccount.get(row.accountKey) ?? 0, row.pct));
	}
	return perAccount.size === 0 ? null : Math.min(...perAccount.values());
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
	rows: UsageRow[],
	provider: string,
	label: (limitId: string) => string | null,
): string[] {
	// 枠ごとに最も余裕のあるアカウントの行を残す（rows は limit_id 順なので表示順も保たれる）。
	const best = new Map<string, UsageRow>();
	for (const row of rows) {
		if (row.provider !== provider) continue;
		const seen = best.get(row.limitId);
		if (!seen || row.pct < seen.pct) best.set(row.limitId, row);
	}
	return [...best.values()].flatMap((row) => {
		const name = label(row.limitId);
		if (name === null) return [];
		return [
			`${name} ${coloredPct(row.pct)} \x1b[2m(${formatReset(row.resetsAt)})\x1b[22m`,
		];
	});
}

/** 両 pool の使用率1行。表示対象の枠が無ければ null。 */
function buildUsageLine(rows: UsageRow[]): string | null {
	const claude = poolParts(rows, "anthropic", (id) =>
		id.startsWith("anthropic:") ? id.slice("anthropic:".length) : null,
	);
	// spark:* は補助枠で常時ほぼ0%のうえ意味が不明瞭なのでノイズとして省く。
	// guard の判定も primary（週次）だけを使っている。
	const codex = poolParts(rows, "openai-codex", (id) =>
		id === "openai-codex:primary" ? "wk" : null,
	);
	const pools: string[] = [];
	if (claude.length > 0) pools.push(`Claude ${claude.join(" · ")}`);
	if (codex.length > 0) pools.push(`Codex ${codex.join(" · ")}`);
	if (pools.length === 0) return null;
	return `\x1b[2musage\x1b[22m ${pools.join(" \x1b[2m│\x1b[22m ")}`;
}

const WIDGET_KEY = "usage-summary";

function updateWidget(ctx: Ctx | undefined, rows: UsageRow[]): void {
	if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
	try {
		const line = buildUsageLine(rows);
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
	let codexNotifiedThisWindow = false;
	let rescuedThisWindow = false;

	function checkCodex(ctx: Ctx, rows: UsageRow[]): void {
		const pct = latestUsedPct(rows, "openai-codex", "openai-codex:primary");
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
	async function checkLocalRescue(ctx: Ctx, rows: UsageRow[]): Promise<void> {
		const anthropicPct = latestUsedPct(rows, "anthropic", "anthropic:7d%");
		const codexPct = latestUsedPct(rows, "openai-codex", "openai-codex:primary");
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
		if (!ctx || (!ctx.hasUI && !ctx.models)) return;
		const rows = latestUsageRows();
		updateWidget(ctx, rows);
		if (inflight || !ctx.models) return;
		inflight = true;
		try {
			checkCodex(ctx, rows);
			await checkLocalRescue(ctx, rows);
		} finally {
			inflight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await check(ctx);
		ctx?.setInterval?.(() => void check(ctx), CHECK_INTERVAL_MS);
	});
}
