// TypeSafe(Jev) を使ったモデル階層(tier)の shadow ログ(machine-global
// extension、jev-agent-hint.ts / jev-skill-hint.ts の姉妹 extension)。
//
// 目的: ユーザー入力(ターン開始)ごとに、依頼文だけから Jev が
// smol/default/slow のどの階層が最適だと予測するかを、実際にそのターンで
// 使われているモデル(`ctx.models.current()`)と突き合わせてログするだけ。
// **実際のモデル切替には一切影響しない** — `setModel` は呼ばない。
// 実データが溜まってから、jev-skill-hint と同じ手順(合成評価→閾値較正→
// Go/No-Go)を踏んでヒント注入/自動切替に進むかどうかを判断する。
//
// 対象は `omp/config.yml` の `modelRoles` 全体ではなく smol/default/slow の
// 3 階層のみ。vision/commit/plan/advisor は用途固定のロールで「この依頼は
// どれくらい重いか」という一般判断の対象ではないため除外する。
//
// anthropic-usage-guard.ts(使用量枠ベースの決定的な切替)とは独立。こちらは
// タスク特性ベースの判断で、意味理解が要るため Jev が担当しうる領域。
//
// Jev が使えない場合:
// - `JEV_API_KEY` 未設定(env にも `~/dotfiles/.env` にも無い) → 完全な
//   no-op。extension は何も登録しない(pi.on を一度も呼ばない)。
// - 実行時に Jev 呼び出しが失敗 → そのセッション内では以降リトライせず、
//   静かに no-op へ切り替える(circuit breaker)。ログには jevError:true を
//   残すが、ターン処理自体は常に成功する。
// - Jev 呼び出しは `ctx.setTimeout(..., 0)` で本処理から切り離して実行する。
//   input ハンドラ自体は同期的に即 return するため、実際のターン処理に
//   レイテンシを一切追加しない。
//
// 有効化・無効化・ログの見方は docs/omp.md の「Jev model hint」節を参照。
//
// スコープ: machine-global extension(`~/.omp/agent/extensions` へ配置)なので
// 起動 cwd に関わらず全リポジトリのメインセッションの通常ターンで発火する。
// `JEV_API_KEY` は常にこのマシンの dotfiles リポジトリの `.env` から読む
// (cwd は呼び出し元リポジトリごとに変わるため固定パスで解決する)。ログは
// 呼び出し元リポジトリの `.agent-msgs/scratch/` に書く(cwd 相対のまま —
// 効果測定は使われたプロジェクトごとに見る)。subagent は自分自身の
// extension をロードしないため対象外。

import { homedir } from "node:os";
import { join } from "node:path";
import { type ChoiceAnswer, appendJsonlLog, jevCall, loadJevApiKey } from "../../scripts/jev-client.ts";

const MAX_PROMPT_CHARS = 4_000;
// JEV_API_KEY は常にこのマシンの dotfiles リポジトリの `.env` から読む(cwd
// 依存にしない、理由は上のスコープ節を参照)。
const DOTFILES_ROOT = join(homedir(), "dotfiles");
// 実測ログ(JSONL, gitignore対象の.agent-msgs配下)。1入力=1行。呼び出し元
// リポジトリの `.agent-msgs/scratch/` に書く(cwd 相対)。スキーマは
// docs/omp.md の「Jev model hint」節を参照。
const LOG_PATH = join(process.cwd(), ".agent-msgs/scratch/jev-model-hint-metrics.jsonl");

// smol/default/slow の 3 階層のみを対象にする(理由は冒頭コメント参照)。
const TIER_CRITERIA: Record<string, string> = {
	smol: "Trivial, mechanical, or narrowly-scoped request (quick lookup, small edit, single fact) that a fast/cheap model handles reliably.",
	default: "Ordinary multi-step engineering work of typical complexity — the common case for this session.",
	slow: "Deep reasoning, ambiguous tradeoffs, architecture/design decisions, or high-stakes correctness that benefits from the most capable model.",
};

type Model = { provider?: string; id?: string };
type ExtensionHandlerCtx = {
	setTimeout(fn: () => unknown, ms: number): unknown;
	models?: { current(): Model | undefined };
};
type ExtensionHandlerApi = {
	on(event: string, handler: (event: unknown, ctx: ExtensionHandlerCtx) => void): void;
};

type InputEvent = { text?: unknown };

export default function jevModelHint(pi: ExtensionHandlerApi): void {
	const apiKey = loadJevApiKey(DOTFILES_ROOT);
	if (!apiKey) return; // JEV_API_KEY 未設定 = 完全な no-op(何も登録しない)。

	// ponytail: セッション内で一度失敗したら以降は試行しない(プロセス単位の
	// circuit breaker)。再開は新しいセッション起動時。
	let jevDisabled = false;

	pi.on("input", (event, ctx) => {
		if (jevDisabled) return;

		try {
			const e = event as InputEvent;
			const text = typeof e.text === "string" ? e.text : "";
			if (!text) return;
			const promptText = text.length > MAX_PROMPT_CHARS ? text.slice(0, MAX_PROMPT_CHARS) : text;
			const currentModel = ctx.models?.current();
			const explicitModel = currentModel ? `${currentModel.provider ?? ""}/${currentModel.id ?? ""}` : null;

			// Jev 呼び出しは隔離された background work として発火だけして即戻る。
			// これ自体は input ハンドラの戻り値と無関係 = ターン処理を一切待たせない。
			ctx.setTimeout(async () => {
				const start = Date.now();
				try {
					const resp = await jevCall(apiKey, promptText, {
						best_tier: {
							type: "choice",
							instructions: "Which model tier best fits handling this request?",
							criteria: TIER_CRITERIA,
						},
					});
					const choice = resp.answers.best_tier as ChoiceAnswer;
					const ranked = Object.entries(choice.probabilities).sort((a, b) => b[1] - a[1]);
					const [predictedTier, predictedProb] = ranked[0] ?? [null, null];
					appendJsonlLog(LOG_PATH, {
						ts: Date.now(),
						requestChars: text.length,
						explicitModel,
						predictedTier,
						predictedProb,
						probabilities: choice.probabilities,
						latencyMs: Date.now() - start,
						circuitOpen: false,
						jevError: false,
					});
				} catch {
					jevDisabled = true;
					appendJsonlLog(LOG_PATH, {
						ts: Date.now(),
						requestChars: text.length,
						explicitModel,
						predictedTier: null,
						predictedProb: null,
						probabilities: null,
						latencyMs: Date.now() - start,
						circuitOpen: false,
						jevError: true,
					});
				}
			}, 0);
		} catch {
			// roster/state 構築時の予期しない失敗。ヒント無しの素の挙動へ
			// フォールバックするだけで、ターン処理を絶対にブロックしない。
		}
	});
}
