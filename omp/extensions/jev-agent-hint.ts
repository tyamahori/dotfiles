// TypeSafe(Jev) を使った task 委任先 agent 種別の shadow ログ(machine-global
// extension、jev-skill-hint.ts の姉妹 extension)。
//
// 目的: `task` ツール呼び出しごとに、依頼文だけから Jev がどの agent 種別
// (scout/reviewer/security-reviewer/task/sonic 等)を最適だと予測するかを、
// 実際に指定された(または省略された)agent と突き合わせてログするだけ。
// **実際の委任には一切影響しない** — tool_call の input は絶対に書き換えず、
// 予測値をログ以外の場所(stdout・会話)に一切出さない。閾値もまだ決めない。
// 実データが溜まってから、jev-skill-hint と同じ手順(合成評価→閾値較正→
// Go/No-Go)を踏んでヒント注入に進むかどうかを判断する。
//
// agent roster は `task` ツール自身の description からその場で抽出する
// (`### name (補足)\n説明...` の見出し形式)。ハードコードしない — 利用可能な
// agent 構成が変わっても extension 側の更新は要らない。
//
// Jev が使えない場合:
// - `JEV_API_KEY` 未設定(環境変数にも `~/dotfiles/.env` にも無い) → 完全な
//   no-op。extension は何も登録しない(pi.on を一度も呼ばない)。
// - 実行時に Jev 呼び出しが失敗 → そのセッション内では以降リトライせず、
//   静かに no-op へ切り替える(circuit breaker)。ログには jevError:true を
//   残すが、タスク発行自体は常に成功する。
// - Jev 呼び出しは `ctx.setTimeout(..., 0)` で本処理から切り離して実行する
//   (upstream の managed background work: https://github.com/can1357/oh-my-pi/blob/v18.2.6/docs/extensions.md
//   参照。隔離された例外処理下で動き、万一失敗してもセッションを落とさない)。
//   tool_call ハンドラ自体は同期的に即 return するため、実タスク発行に
//   レイテンシを一切追加しない。
//
// 有効化・無効化・ログの見方は docs/jev.md の「Jev agent hint」節を参照。
//
// スコープ: machine-global extension(`~/.omp/agent/extensions` へ配置)なので
// 起動 cwd に関わらず全リポジトリのメインセッションの通常ターンで発火する。
// `JEV_API_KEY` は環境変数優先、無ければこのマシンの dotfiles リポジトリの
// `.env` を読む(cwd は呼び出し元リポジトリごとに変わるため固定パスで
// 解決する)。ログは
// 呼び出し元リポジトリの `.agent-msgs/scratch/` に書く(cwd 相対のまま —
// 効果測定は使われたプロジェクトごとに見る)。subagent は自分自身の
// extension をロードしないため、このフックは subagent 内部の task 呼び出し
// (ネストした委任)では発火しない。

import { homedir } from "node:os";
import { join } from "node:path";
import { type ChoiceAnswer, appendJsonlLog, jevCall, loadJevApiKey } from "../../scripts/jev-client.ts";

const MAX_PROMPT_CHARS = 4_000;
// JEV_API_KEY は環境変数優先、無ければこのマシンの dotfiles リポジトリの
// `.env` を読む(cwd 依存にしない、理由は上のスコープ節を参照)。
const DOTFILES_ROOT = join(homedir(), "dotfiles");
// 実測ログ(JSONL, gitignore対象の.agent-msgs配下)。1行=1 task item。呼び出し
// 元リポジトリの `.agent-msgs/scratch/` に書く(cwd 相対)。スキーマは
// docs/jev.md の「Jev agent hint」節を参照。
const LOG_PATH = join(process.cwd(), ".agent-msgs/scratch/jev-agent-hint-metrics.jsonl");

type ToolDefinitionLike = { name: string; description?: string };
type ExtensionHandlerCtx = {
	setTimeout(fn: () => unknown, ms: number): unknown;
};
type ExtensionHandlerApi = {
	on(event: string, handler: (event: unknown, ctx: ExtensionHandlerCtx) => unknown): void;
	getAllTools(): ToolDefinitionLike[];
};

/** `task` ツールの description 内、`### name (補足)\n説明...` の見出し列から
 * agent roster をその場で抽出する。ハードコードしない。 */
export function extractAgentRoster(taskToolDescription: string): Record<string, string> {
	const roster: Record<string, string> = {};
	const entryStart = /^### ([a-zA-Z][a-zA-Z0-9_-]*)(?:\s*\([^)]*\))?\s*$/;
	let currentName: string | null = null;
	let parts: string[] = [];
	const flush = () => {
		if (currentName) roster[currentName] = parts.join(" ").trim().replace(/\s+/g, " ").slice(0, 500);
	};
	for (const line of taskToolDescription.split("\n")) {
		const m = entryStart.exec(line);
		if (m) {
			flush();
			currentName = m[1];
			parts = [];
		} else if (currentName) {
			parts.push(line);
		}
	}
	flush();
	return roster;
}

type TaskItem = { task?: unknown; agent?: unknown };

async function predictAgentForTask(
	apiKey: string,
	roster: Record<string, string>,
	rosterSize: number,
	taskText: string,
	promptText: string,
	explicitAgent: string | null,
	markDisabled: () => void,
): Promise<void> {
	const start = Date.now();
	try {
		const resp = await jevCall(apiKey, promptText, {
			best_agent: {
				type: "choice",
				instructions: "Which subagent type best fits this delegated task description?",
				criteria: roster,
			},
		});
		const choice = resp.answers.best_agent as ChoiceAnswer;
		const ranked = Object.entries(choice.probabilities).sort((a, b) => b[1] - a[1]);
		const [predictedAgent, predictedProb] = ranked[0] ?? [null, null];
		appendJsonlLog(LOG_PATH, {
			ts: Date.now(),
			taskTextChars: taskText.length,
			rosterSize,
			explicitAgent,
			predictedAgent,
			predictedProb,
			probabilities: choice.probabilities,
			latencyMs: Date.now() - start,
			circuitOpen: false,
			jevError: false,
		});
	} catch {
		markDisabled();
		appendJsonlLog(LOG_PATH, {
			ts: Date.now(),
			taskTextChars: taskText.length,
			rosterSize,
			explicitAgent,
			predictedAgent: null,
			predictedProb: null,
			latencyMs: Date.now() - start,
			circuitOpen: true,
			jevError: true,
		});
	}
}

type ScheduleCtx = { setTimeout(fn: () => unknown, ms: number): unknown };

function scheduleAgentPrediction(
	item: TaskItem,
	apiKey: string,
	roster: Record<string, string>,
	rosterSize: number,
	ctx: ScheduleCtx,
	markDisabled: () => void,
): void {
	const taskText = typeof item.task === "string" ? item.task : "";
	if (!taskText) return;
	const explicitAgent = typeof item.agent === "string" ? item.agent : null;
	const promptText = taskText.length > MAX_PROMPT_CHARS ? taskText.slice(0, MAX_PROMPT_CHARS) : taskText;

	// Jev 呼び出しは隔離された background work として発火だけして即戻る。
	// これ自体は tool_call の戻り値と無関係 = 実タスク発行を一切待たせない。
	ctx.setTimeout(() => predictAgentForTask(apiKey, roster, rosterSize, taskText, promptText, explicitAgent, markDisabled), 0);
}

export default function jevAgentHint(pi: ExtensionHandlerApi): void {
	const apiKey = loadJevApiKey(DOTFILES_ROOT);
	if (!apiKey) return; // JEV_API_KEY 未設定 = 完全な no-op(何も登録しない)。

	// ponytail: セッション内で一度失敗したら以降は試行しない(プロセス単位の
	// circuit breaker)。再開は新しいセッション起動時。
	let jevDisabled = false;

	pi.on("tool_call", (event, ctx) => {
		if (jevDisabled) return;

		// shadow ログ専用フック: 同期部分が何を投げても実タスク発行を
		// 止めてはいけない(tool_call のハンドラ例外は fail-closed でブロックされる)。
		try {
			const e = event as { toolName?: string; input?: { tasks?: TaskItem[] } };
			if (e.toolName !== "task") return;
			const tasks = Array.isArray(e.input?.tasks) ? e.input.tasks : [];
			if (tasks.length === 0) return;

			const taskTool = pi.getAllTools().find((t) => t.name === "task");
			const roster = taskTool?.description ? extractAgentRoster(taskTool.description) : {};
			const rosterSize = Object.keys(roster).length;
			if (rosterSize === 0) return; // roster 抽出できなければ静かに諦める

			for (const item of tasks) {
				scheduleAgentPrediction(item, apiKey, roster, rosterSize, ctx, () => {
					jevDisabled = true;
				});
			}
		} catch {
			// shadow ログ専用: ここで何が起きてもタスク発行を止めない。
		}
		// input には一切手を加えない = 完全なシャドウ(戻り値なし)。
	});
}
