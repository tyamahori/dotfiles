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
// 2. 両 pool の使用率を editor 下の widget に常時表示する。Claude は組織ごとに
//    `Claude personal` / `Claude team` の行に分け、Codex 週次枠を最後の行に置く
//    （dotfiles/.zshrc のプロンプト表示と同じ形）。データ源は agent.db の最新
//    usage snapshot で、更新は session_start とチェック周期（5分毎）に揃う。
// 3. 両 pool が 98% 以上（実質枯渇）のときだけ、ローカル ollama を probe して
//    応答があればメインを qwen へ退避する。ollama 不在なら何もしない。
//
// 一度通知/退避した後は、その枠が閾値を下回るまで再発火しない。

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { type HasUiNotify, safeNotify } from "../lib/ui.ts";

// getAgentDir() は --profile / OMP_PROFILE / XDG を解決済みの agent dir を返す。
// ~/.omp/agent 固定だと team プロファイルでも既定プロファイルの枠を監視してしまう。
const USAGE_DB = join(getAgentDir(), "agent.db");
const USAGE_RESERVE_PCT = 20;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// 両pool枯渇時の最終退避先。ローカルollamaが「起動していてモデルが居る」
// 場合だけ使う(あれば使う)。chainに入れないのは、停止中でもretry budget
// を浪費する上、利用枠なし=常にeligible扱いでreserve帯から降格するため。
// ollama の公式形式 `127.0.0.1:11434` はスキームが無く、そのままでは fetch が Invalid URL を投げて「ollama不在」扱いになる。
// ollama はスキーム無しの値だけ既定ポートを 11434 とする(`http://host` は 80)ので、それに合わせる。
const OLLAMA_HOST = (() => {
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  if (host.includes("://")) return host;
  try {
    const url = new URL(`http://${host}`);
    url.port ||= "11434";
    return url.origin;
  } catch {
    return `http://${host}`; // 不正値は従来どおり probe 側の失敗として扱う
  }
})();
const LOCAL_RESCUE_MODEL = "ollama/qwen3.6:35b-mlx";
const DEPLETED_PCT = 98;

type Model = { provider?: string; id?: string };

type Ctx = HasUiNotify & {
  ui?: {
    setWidget?: (key: string, content?: string[], opts?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  };
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

type UsageRow = {
  provider: string;
  accountKey: string;
  /** Anthropic の組織種別。ログアウト済みの組織は gone、他 provider は null。 */
  kind: "personal" | "team" | "gone" | null;
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
					        CASE WHEN lower(u.provider) <> 'anthropic' THEN NULL ELSE coalesce((
					          -- ponytail: 個人組織は Anthropic 既定名 "<email>'s Organization" で判定。
					          -- 個人組織を改名したら OMP 認証情報に組織種別が載るまで team と誤判定する。
					          SELECT CASE WHEN json_extract(c.data, '$.orgName') LIKE '%''s Organization'
					                      THEN 'personal' ELSE 'team' END
					          FROM auth_credentials c
					          WHERE c.provider = 'anthropic'
					            AND json_extract(c.data, '$.orgId')
					                = substr(u.account_key, instr(u.account_key, '|org:') + 5)
					          LIMIT 1), 'gone') END AS kind,
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
function latestUsedPct(rows: UsageRow[], provider: string, limitFilter: string): number | null {
  const filter = limitFilter.toLowerCase();
  const prefix = filter.endsWith("%") ? filter.slice(0, -1) : undefined;
  const perAccount = new Map<string, number>();
  for (const row of rows) {
    if (
      // ログアウト済みの組織は omp が選べず、ウィジェットも隠す。低い値が実際の枯渇を隠さないよう除外する。
      row.kind === "gone" ||
      row.provider !== provider ||
      // NULL reset = unused pool (see latestUsageRows), still a valid account.
      (row.resetsAt !== null && row.resetsAt <= Date.now()) ||
      (prefix ? !row.limitId.toLowerCase().startsWith(prefix) : row.limitId.toLowerCase() !== filter)
    ) {
      continue;
    }
    perAccount.set(row.accountKey, Math.max(perAccount.get(row.accountKey) ?? 0, row.pct));
  }
  return perAccount.size === 0 ? null : Math.min(...perAccount.values());
}

function formatReset(resetsAt: number | null): string {
  if (resetsAt === null) return "-";
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

/** 同じ枠に複数組織があれば最も逼迫している値を `12%(3h)` の形で出す。 */
function tightest(hits: UsageRow[]): string {
  const row = hits.reduce((a, b) => (b.pct > a.pct ? b : a), hits[0]);
  return `${coloredPct(row.pct)}\x1b[2m(${formatReset(row.resetsAt)})\x1b[22m`;
}

// プロンプトと同じ略号: F=モデル別7d(fable) A=全モデル7d S=5h。
const CLAUDE_LIMITS: [string, string][] = [
  ["anthropic:7d:fable", "F"],
  ["anthropic:7d", "A"],
  ["anthropic:5h", "S"],
];

function claudeLine(rows: UsageRow[], kind: "personal" | "team"): string | null {
  const parts = CLAUDE_LIMITS.flatMap(([limitId, key]) => {
    const hits = rows.filter((r) => r.kind === kind && r.limitId.toLowerCase() === limitId);
    return hits.length > 0 ? [`${key}:${tightest(hits)}`] : [];
  });
  return parts.length > 0 ? `\x1b[38;5;208mClaude\x1b[39m ${kind} ${parts.join(" ")}` : null;
}

/** 1アカウント1行の使用率。表示対象の枠が無ければ空配列。
 *  その端末の OMP にログインしていない組織の行は出さない。 */
function buildUsageLines(rows: UsageRow[]): string[] {
  const lines = [claudeLine(rows, "personal"), claudeLine(rows, "team")];
  // spark:* は補助枠で常時ほぼ0%のうえ意味が不明瞭なのでノイズとして省く。
  // guard の判定も primary（週次）だけを使っている。
  const codex = rows.filter((r) => r.limitId.toLowerCase() === "openai-codex:primary");
  if (codex.length > 0) {
    lines.push(`\x1b[36mCodex\x1b[39m ${tightest(codex)}`);
  }
  return lines.filter((line): line is string => line !== null);
}

const WIDGET_KEY = "usage-summary";

function updateWidget(ctx: Ctx | undefined, rows: UsageRow[]): void {
  if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
  try {
    const lines = buildUsageLines(rows);
    ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, {
      placement: "belowEditor",
    });
  } catch {
    // widget 描画の失敗は guard 本体の判定に影響させない。
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
    safeNotify(
      ctx,
      `usage-guard: Codex 週次枠 ${pct}% 使用（残り${100 - pct}% ≤ ${USAGE_RESERVE_PCT}%）。退避は retry.fallbackChains が処理`,
    );
  }

  /** 両pool枯渇時のみ、ローカルollamaが応答しモデルが存在すれば切り替える。 */
  async function checkLocalRescue(ctx: Ctx, rows: UsageRow[]): Promise<void> {
    const anthropicPct = latestUsedPct(rows, "anthropic", "anthropic:7d%");
    const codexPct = latestUsedPct(rows, "openai-codex", "openai-codex:primary");
    if (anthropicPct === null || codexPct === null || anthropicPct < DEPLETED_PCT || codexPct < DEPLETED_PCT) {
      rescuedThisWindow = false;
      return;
    }
    if (rescuedThisWindow || ctx.models?.current()?.provider === "ollama") return;

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
      safeNotify(
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
