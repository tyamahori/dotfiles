// TypeSafe(Jev) を使った Plan Mode の不要候補フィルタ(machine-global extension)。
//
// 背景: `agents/skills/jev-plan-gate` という agent-internal skill として同じ
// アイデアを試作したが、「エージェントが `<proposed_plan>` を出す直前に自分で
// 気づいて使う」設計だったため確実性がなく、忘れられる問題を解決できなかった。
// このファイルはその後継。turn_end イベントで直前のアシスタントメッセージを
// 機械的に検査するので、エージェントの自己申告に依存しない。
//
// 設計:
// - turn_end で直前のアシスタントメッセージを取得し、`<proposed_plan>...
//   </proposed_plan>` を含む場合だけ動く(それ以外のターンはコストゼロ)。
// - ブロック内の箇条書き/番号付き行を候補として正規表現抽出する。件数が
//   2〜8件の範囲外(見出しだけの計画、または細かすぎる計画)なら判定の質が
//   低いとみなし、何もしない。
// - 候補ごとに独立した Noul 質問(「この項目は目標達成に必要か」)を1回の
//   jevCall にまとめて投げ、必要性確率が UNNECESSARY_THRESHOLD 未満の候補を
//   「不要かもしれない」候補として集める。
// - 深いトレードオフ・リスクレビューはこの仕組みの対象外。それは
//   `adversarial-verification` skill が担う(このヒントは軽い足切りのみ)。
// - ヒントは常に非拘束: 「参考、必須ではない。最終判断はユーザー」。0件なら
//   何も注入しない。
// - 挿入タイミング: ターンはすでに終わっている(計画は表示済み)ため
//   `before_agent_start` の戻り値方式は使えない。`pi.sendMessage` を
//   `deliverAs: "nextTurn"`(triggerTurn なし)で呼び、ユーザーが計画に対して
//   次の発言をするタイミングでその発言と一緒に配信・表示する。新規ターンを
//   強制起動しない(追加の推論コストを払わない)。
//
// 有効化・無効化は docs/omp.md の「Jev plan gate」節を参照。要約:
// このマシンの `~/dotfiles/.env` に JEV_API_KEY があれば有効、無ければ完全な
// no-op。実行時に呼び出しが失敗した場合もそのセッション内では以後リトライせず
// 静かに no-op へ切り替える。
//
// スコープ: machine-global extension。task/scout 等の subagent は自分自身の
// extension をロードしないため、このフックは subagent 内部では発火しない。

import { homedir } from "node:os";
import { join } from "node:path";
import {
	type JevResponse,
	type NoulAnswer,
	appendJsonlLog,
	jevCall,
	loadJevApiKey,
} from "../../scripts/jev-client.ts";

const MIN_CANDIDATES = 2;
const MAX_CANDIDATES = 8;
const UNNECESSARY_THRESHOLD = 0.5;
const MAX_PLAN_CHARS = 6_000;
const DOTFILES_ROOT = join(homedir(), "dotfiles");
const LOG_PATH = join(process.cwd(), ".agent-msgs/scratch/jev-plan-gate-metrics.jsonl");

type BranchEntry = {
	type: string;
	message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
};
type ExtensionHandlerApi = {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	sendMessage(message: unknown, options: unknown): unknown;
};

/** `ctx.sessionManager.getBranch()` から直近の assistant メッセージの
 * テキストブロックだけを連結して返す。見つからなければ空文字列。 */
function getLastAssistantText(ctx: unknown): string {
	const branch = (ctx as { sessionManager?: { getBranch?: () => BranchEntry[] } })?.sessionManager?.getBranch?.();
	if (!Array.isArray(branch)) return "";
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			return (entry.message.content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
		}
	}
	return "";
}

/** `<proposed_plan>` ブロック内の箇条書き/番号付き行を候補として抽出する。 */
function extractCandidates(planBlock: string): string[] {
	const lineRe = /^\s*(?:[-*]|\d+\.)\s+(.+)$/gm;
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const m of planBlock.matchAll(lineRe)) {
		const text = m[1].trim().slice(0, 200);
		if (text && !seen.has(text)) {
			seen.add(text);
			candidates.push(text);
		}
	}
	return candidates;
}

async function getUnnecessaryCandidates(apiKey: string, planText: string, candidates: string[]): Promise<string[]> {
	const questions: Record<string, unknown> = {};
	candidates.forEach((text, i) => {
		questions[`necessary_${i}`] = {
			type: "noul",
			instructions: `Given the full plan below, is this specific step actually necessary to achieve the plan's goal (as opposed to optional, redundant, or speculative work)? Step: "${text}"`,
		};
	});
	const resp: JevResponse = await jevCall(apiKey, planText, questions);
	return candidates.filter((_, i) => (resp.answers[`necessary_${i}`] as NoulAnswer).noul < UNNECESSARY_THRESHOLD);
}

export default function (pi: ExtensionHandlerApi): void {
	const apiKey = loadJevApiKey(DOTFILES_ROOT);
	if (!apiKey) return; // JEV_API_KEY 未設定 = 完全な no-op。

	// ponytail: セッション内で一度失敗したら以降は試行しない。再開は新しい
	// セッション起動時。
	let jevDisabled = false;

	pi.on("turn_end", async (_event, ctx) => {
		if (jevDisabled) return;
		const text = getLastAssistantText(ctx);
		const planBlock = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(text)?.[1];
		if (!planBlock) return;

		const candidates = extractCandidates(planBlock);
		if (candidates.length < MIN_CANDIDATES || candidates.length > MAX_CANDIDATES) return;

		const truncatedPlan = planBlock.length > MAX_PLAN_CHARS ? planBlock.slice(0, MAX_PLAN_CHARS) : planBlock;
		const startedAt = Date.now();
		try {
			const flagged = await getUnnecessaryCandidates(apiKey, truncatedPlan, candidates);
			appendJsonlLog(LOG_PATH, {
				ts: startedAt,
				candidateCount: candidates.length,
				latencyMs: Date.now() - startedAt,
				flagged,
				circuitOpen: false,
				jevError: false,
			});
			if (flagged.length === 0) return;

			pi.sendMessage(
				{
					customType: "dotfiles.jev-plan-gate",
					content:
						"<plan_relevance>\nJev候補(参考、必須ではない): 以下の項目は目標達成に不要かもしれません — " +
						`${flagged.map((f) => `「${f}」`).join("、")}。` +
						"深いトレードオフ検討は adversarial-verification に委ねる。最終判断はユーザー。\n</plan_relevance>",
					display: true,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// Jev API 障害・タイムアウト・不正な応答形式など。ヒント無しの
			// 素の挙動へフォールバックし、以後このセッションでは再試行しない。
			jevDisabled = true;
			appendJsonlLog(LOG_PATH, {
				ts: startedAt,
				candidateCount: candidates.length,
				latencyMs: Date.now() - startedAt,
				flagged: [],
				circuitOpen: false,
				jevError: true,
			});
		}
	});
}
