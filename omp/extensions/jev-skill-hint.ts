// TypeSafe(Jev) を使った Skill 推薦ヒント(machine-global extension)。
//
// 背景: システムプロンプトの `<skills>` には数十件の Skill が名前+説明だけ
// 並ぶ。依頼文からどの Skill を読むべきかの判断は毎ターン、モデル自身が
// 一覧全体を読んで下す。TypeSafe の systemone API (Jev) に依頼文と Skill
// 一覧を渡し、合いそうな候補を`<skill_relevance>`ヒントとして参考提示する
// ことで、必要な Skill の見落とし・不要な Skill の誤読み込みを減らせるかを
// 検証した結果、非拘束の複数候補ヒントとして採用した。
//
// 設計(2026-09 検証済み。自動検証は omp/tests/jev-skill-hint.test.ts を参照):
// - Call 1: 全 Skill の名前+説明を選択肢にした Choice 質問で「最も必要そうな
//   Skill」を1つ選ばせ、確率上位3件を候補にする。
// - Call 2: 上位3件それぞれに独立した Noul 質問(「この Skill を読む必要が
//   あるか」)を投げ、FITS_THRESHOLD 以上の候補を『全て』採用する。
//   cookbook 標準の「1件に収束させる」ステップは踏まない — 収束ステップは
//   複数 Skill が必要なケースで足切りを誘発することが検証で確認できた。
// - ヒントは常に非拘束・複数形: 「参考、必須ではない。依頼内容全体を読んで
//   自分の判断で全部選ぶこと。候補にない Skill が必要ならそちらを使ってよい」。
//   採用候補が0件なら何も注入しない。
//
// Jev が使えないとき(JEV_API_KEY 未設定、またはセッション内で一度失敗して
// circuit が開いた後)は、FALLBACK_MODELS の Claude/Codex 下位モデルに同じ
// 依頼文と Skill 一覧を渡し、JSON 配列で候補を選ばせる。OMP 本体の認証
// (ctx.modelRegistry)と host 同梱の @oh-my-pi/pi-ai を使うので鍵の追加設定は
// 要らない。失敗したモデルはそのセッション内で外し次のモデルへ進む。全て
// 使えなければヒント無しの素の挙動に戻る(セッションを止めない・エラーを出さない)。
// Jev の確率(Choice+Noul の閾値)は LLM では得られないので、フォールバックは
// 「必要な Skill を最大 SHORTLIST 件挙げさせる」単発の選定にしている。
//
// 有効化・無効化の手順は docs/jev.md の「Jev skill hint」節を参照。
// 要約: 環境変数 JEV_API_KEY があれば最優先、無ければこのマシンの
// `~/dotfiles/.env` を読む。
//
// スコープ: machine-global extension(`~/.omp/agent/extensions` へ配置)なので
// 起動 cwd に関わらず全リポジトリのメインセッションの通常ターンで発火する。
// task/scout 等の subagent は自分自身の extension をロードしないため
// (公式ドキュメント: "a subagent spawned with restricted tools loads no
// extensions of its own")、このフックは subagent 内部では発火しない。

import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@oh-my-pi/pi-ai";
import {
	type ChoiceAnswer,
	type JevResponse,
	type NoulAnswer,
	appendJsonlLog,
	jevCall,
	loadJevApiKey,
} from "../../scripts/jev-client.ts";

const SHORTLIST = 3;
const FITS_THRESHOLD = 0.3;
const MAX_PROMPT_CHARS = 4_000;
// Jev 不可時の選定モデル(順に試す)。Claude は実測で速い haiku を先に置く。
// Codex 側は modelRoles.smol を参照し、モデル pin の移行に追従させる。
const FALLBACK_MODELS = ["anthropic/claude-haiku-4-5", "@smol"];
const FALLBACK_TIMEOUT_MS = 8_000;
// JEV_API_KEY は環境変数優先、無ければこのマシンの dotfiles リポジトリの
// `.env` にフォールバックする(loadJevApiKey 参照)。cwd は呼び出し元
// リポジトリごとに変わるため、フォールバック先は固定パスで解決する。
const DOTFILES_ROOT = join(homedir(), "dotfiles");
// 実測ログ(JSONL, gitignore対象の.agent-msgs配下)。1行=1ターン。呼び出し元
// リポジトリの `.agent-msgs/scratch/` に書く(cwd 相対のまま — 効果測定は
// 使われたプロジェクトごとに見る)。スキーマは docs/jev.md の「Jev skill hint」
// 節を参照。
const LOG_PATH = join(process.cwd(), ".agent-msgs/scratch/jev-skill-hint-metrics.jsonl");

type ExtensionHandlerApi = {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
};

/** システムプロンプトの `<skills>\n- name: 説明\n...\n</skills>` から一覧を都度抽出する。
 * ハードコードしない: Skill 構成が変わっても extension 側の更新が要らない。 */
function extractRoster(systemPrompt: string): Record<string, string> {
	const block = /<skills>([\s\S]*?)<\/skills>/.exec(systemPrompt)?.[1];
	if (!block) return {};
	const roster: Record<string, string> = {};
	const entryStart = /^- ([a-zA-Z0-9][a-zA-Z0-9_-]*): (.*)$/;
	let currentName: string | null = null;
	let parts: string[] = [];
	const flush = () => {
		if (currentName) roster[currentName] = parts.join(" ").trim().replace(/\s+/g, " ");
	};
	for (const line of block.split("\n")) {
		const m = entryStart.exec(line);
		if (m) {
			flush();
			currentName = m[1];
			parts = [m[2]];
		} else if (currentName) {
			parts.push(line);
		}
	}
	flush();
	return roster;
}

async function getHint(apiKey: string, requestText: string, roster: Record<string, string>): Promise<string[]> {
	const resp1 = await jevCall(apiKey, requestText, {
		which_skill: {
			type: "choice",
			instructions: "Which single skill would an AI coding agent most need to load to handle this request?",
			criteria: roster,
		},
	});
	const choice = resp1.answers.which_skill as ChoiceAnswer;
	const top = Object.entries(choice.probabilities)
		.sort((a, b) => b[1] - a[1])
		.slice(0, SHORTLIST);

	const questions: Record<string, unknown> = {};
	top.forEach(([name], i) => {
		questions[`fits_${i}`] = {
			type: "noul",
			instructions: `Does handling this request require loading the skill "${name}" (described as: ${roster[name]})?`,
		};
	});
	const resp2: JevResponse = await jevCall(apiKey, requestText, questions);
	return top
		.filter(([, ], i) => (resp2.answers[`fits_${i}`] as NoulAnswer).noul >= FITS_THRESHOLD)
		.map(([name]) => name);
}

type Model = { provider: string; id: string };
type ModelCtx = {
	models?: { resolve(spec: string): Promise<Model | undefined> };
	modelRegistry?: { getApiKey(model: Model): Promise<string | undefined> };
};

const FALLBACK_SYSTEM_PROMPT =
	"You pick which agent skills an AI coding agent must load before handling a user request. " +
	`Reply with only a JSON array of at most ${SHORTLIST} skill names copied exactly from the list, ` +
	"most necessary first. Reply [] when no skill is needed.";

/** 1モデルで選定する。呼び出し失敗は例外で返す(呼び出し元が次のモデルへ進む)。
 * 応答が JSON 配列として読めない・一覧にない名前は捨てる(失敗扱いにしない)。 */
async function llmHint(ctx: ModelCtx, model: Model, requestText: string, roster: Record<string, string>): Promise<string[]> {
	const skills = Object.entries(roster)
		.map(([name, description]) => `- ${name}: ${description}`)
		.join("\n");
	const res = await completeSimple(
		model as Parameters<typeof completeSimple>[0],
		{
			systemPrompt: FALLBACK_SYSTEM_PROMPT,
			messages: [{ role: "user", content: `Skills:\n${skills}\n\nRequest:\n${requestText}`, timestamp: Date.now() }],
		},
		{
			apiKey: await ctx.modelRegistry?.getApiKey(model),
			maxTokens: 1024,
			signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
		},
	);
	if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? res.stopReason);
	const text = res.content.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : "")).join("");
	// 最初の [ から最後の ] までを配列とみなす(```json 囲みや前置きの文を許容)。
	let names: unknown;
	try {
		names = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(names)) return [];
	return [...new Set(names.filter((name): name is string => typeof name === "string" && name in roster))].slice(0, SHORTLIST);
}

type FallbackResult = { accepted: string[]; selector: string | null; attempted: boolean; failed: boolean };

/** FALLBACK_MODELS を順に試し、最初に応答したモデルの選定を返す。解決できない・
 * 呼び出しに失敗したモデルは failedSpecs に入れ、以後のターンでは飛ばす。 */
async function fallbackHint(
	ctx: ModelCtx,
	failedSpecs: Set<string>,
	requestText: string,
	roster: Record<string, string>,
): Promise<FallbackResult> {
	const result: FallbackResult = { accepted: [], selector: null, attempted: false, failed: false };
	for (const spec of ctx.models ? FALLBACK_MODELS : []) {
		if (failedSpecs.has(spec)) continue;
		const model = await ctx.models?.resolve(spec);
		if (!model) {
			failedSpecs.add(spec); // 未認証・カタログに無いモデル
			continue;
		}
		result.attempted = true;
		try {
			result.accepted = await llmHint(ctx, model, requestText, roster);
			result.selector = `${model.provider}/${model.id}`;
			return result;
		} catch {
			failedSpecs.add(spec);
			result.failed = true;
		}
	}
	return result;
}

type TurnMetrics = {
	ts: number;
	promptChars: number;
	rosterSize: number;
	hintLatencyMs: number | null;
	accepted: string[];
	selector: string | null;
	circuitOpen: boolean;
	jevError: boolean;
	fallbackError: boolean;
};

export default function jevSkillHint(pi: ExtensionHandlerApi): void {
	const apiKey = loadJevApiKey(DOTFILES_ROOT);

	// ponytail: セッション内で一度失敗したら以降は試行しない(プロセス単位のcircuit
	// breaker)。Jev・各フォールバックモデルとも同じ扱い。再開は新しいセッション起動時。
	let jevDisabled = false;
	const failedFallbacks = new Set<string>();

	// 実測ログ用のターン単位バッファ。before_agent_start で開始し、turn_end で
	// 実際に読まれた skill:// read と突き合わせて1行 flush する(スキーマは
	// docs/jev.md の「Jev skill hint」節を参照)。
	let pending: TurnMetrics | null = null;
	let skillReads: string[] = [];

	pi.on("before_agent_start", async (event, ctx) => {
		pending = null;
		skillReads = [];

		const promptValue = (event as { prompt?: unknown } | undefined)?.prompt;
		const prompt = (typeof promptValue === "string" ? promptValue : "").trim();
		if (!prompt) return;

		const getSystemPrompt = (ctx as { getSystemPrompt?: () => unknown } | undefined)?.getSystemPrompt;
		if (typeof getSystemPrompt !== "function") return;
		const systemPrompt = String(await getSystemPrompt.call(ctx));
		const roster = extractRoster(systemPrompt);
		if (Object.keys(roster).length < 2) return;

		const truncated = prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
		const startedAt = Date.now();
		const circuitOpen = jevDisabled; // jevDisabled は鍵があるときだけ立つ
		let accepted: string[] = [];
		let selector: string | null = null;
		let attempted = false;
		let jevError = false;
		let fallbackError = false;

		if (apiKey && !jevDisabled) {
			attempted = true;
			try {
				accepted = await getHint(apiKey, truncated, roster);
				selector = "jev";
			} catch {
				// Jev API 障害・タイムアウト・不正な応答形式など。以後このセッションでは
				// Jev を呼ばず、このターンからフォールバックモデルで選定する。
				jevDisabled = true;
				jevError = true;
			}
		}

		if (selector === null) {
			const fallback = await fallbackHint((ctx as ModelCtx | undefined) ?? {}, failedFallbacks, truncated, roster);
			({ accepted, selector } = fallback);
			attempted ||= fallback.attempted;
			fallbackError = fallback.failed;
		}

		if (!attempted && !circuitOpen) return;
		pending = {
			ts: startedAt,
			promptChars: truncated.length,
			rosterSize: Object.keys(roster).length,
			hintLatencyMs: attempted ? Date.now() - startedAt : null,
			accepted,
			selector,
			circuitOpen,
			jevError,
			fallbackError,
		};
		if (accepted.length === 0) return;

		const label = selector === "jev" ? "Jev" : selector?.split("/").pop();
		return {
			message: {
				customType: "dotfiles.jev-skill-hint",
				content:
					`<skill_relevance>\n${label}候補(参考、必須ではない): ${accepted.join("、")}。` +
					"依頼内容全体を読んで、必要なSkillは自分の判断で全部選ぶこと。" +
					"候補にないSkillが必要ならそちらを使ってよい。\n</skill_relevance>",
				display: true,
				attribution: "agent",
			},
		};
	});

	// 実際に読まれた Skill を突き合わせ用に記録する。accepted(Jev/代替モデルの推薦)
	// との重なり具合で、ヒントがどれだけ「無駄読み・見落とし」を減らせているかを測る。
	pi.on("tool_call", (event) => {
		if (pending === null) return;
		const e = event as { toolName?: string; input?: Record<string, unknown> };
		if (e.toolName !== "read") return;
		const path = e.input?.path;
		const match = /^skill:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]*)/.exec(typeof path === "string" ? path : "");
		if (match) skillReads.push(match[1]);
	});

	pi.on("turn_end", () => {
		if (pending === null) return;
		const actual = [...new Set(skillReads)];
		const hits = actual.filter((name) => pending?.accepted.includes(name));
		appendJsonlLog(LOG_PATH, {
			...pending,
			actualSkillReads: actual,
			hits: hits.length,
			extraReads: actual.length - hits.length,
			missedAccepted: pending.accepted.length - hits.length,
		});
		pending = null;
		skillReads = [];
	});
}
