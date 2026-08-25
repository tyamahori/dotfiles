// 日跨ぎ有人セッションガード。「有人セッションは日次で使い捨てる」規範
// (omp/APPEND_SYSTEM のルーティング規範、funabashidev/bot CLAUDE.md 2026-08-16)
// の仕組み化。
//
// 背景実測: 日跨ぎ resume した1セッションが 237MB JSONL に肥大し、ターン毎
// cache read 平均 86K を積み上げた(2026-08-15->16, funabashidev-bot)。
// resume は毎ターン過去文脈全体を再読するため、日を跨いだ継続は枠を食い潰す。
//
// 動作:
// - session_start: 過去日開始のセッションを再開していたら警告を通知。
// - input: 日付を跨いで最初のユーザー入力が来たら、日誌を書いて新セッションへ
//   移る手仕舞い指示を followUp として1回だけ注入する(1日1回)。
// - 強制終了はしない(omp にセッションを閉じる拡張 API がないため、
//   エージェント自身に手仕舞いさせるのが到達可能な最大限)。
// - hasUI のないセッション(サブエージェント・ヘッドレス one-shot)では
//   何もしない。「有人セッション」だけが対象。

type Rec = Record<string, unknown>;

type Ctx = {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: string) => void };
  sessionManager?: { getBranch?: () => unknown[] };
};

type ExtensionHandlerApi = {
  on(
    event: string,
    handler: (event: unknown, ctx: Ctx | undefined) => void | Promise<void>,
  ): void;
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ) => unknown;
};

function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function entryTimestamp(entry: unknown): number | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const ts = (entry as Rec).timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // 秒単位のエポックが来ても日付を壊さない
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** ブランチ内の最古エントリのローカル日付 = セッション開始日。 */
function sessionStartDate(ctx: Ctx | undefined): string | undefined {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return undefined;
  let min: number | undefined;
  for (const entry of branch) {
    const ts = entryTimestamp(entry);
    if (ts !== undefined && (min === undefined || ts < min)) min = ts;
  }
  return min === undefined ? undefined : localDate(new Date(min));
}

export default function (pi: ExtensionHandlerApi): void {
  const nudgedDates = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    if (!ctx?.hasUI) return;
    const start = sessionStartDate(ctx);
    const today = localDate(new Date());
    if (start && start < today) {
      ctx.ui?.notify?.(
        `session-day-guard: ${start} 開始のセッションを日跨ぎで再開している。日誌を書いて新セッションへ移ることを推奨(日次使い捨て規範)`,
      );
    }
  });

  pi.on("input", (_event, ctx) => {
    if (!ctx?.hasUI) return;
    const start = sessionStartDate(ctx);
    const today = localDate(new Date());
    if (!start || start >= today || nudgedDates.has(today)) return;
    nudgedDates.add(today);
    ctx.ui?.notify?.(
      `session-day-guard: 日付を跨いだ(${start} 開始)。この依頼の後、手仕舞いを提案する`,
    );
    try {
      pi.sendUserMessage?.(
        `[session-day-guard] このセッションは ${start} に開始し、今日は ${today}。` +
          `有人セッションは日次で使い捨てる規範に従い、いまの依頼が一区切りしたら手仕舞いする: ` +
          `(1) 引き継ぎ文脈(未完タスク・決定事項・宿題)を日誌として書く。` +
          `置き場はリポジトリが明示的に定義していればそこ、なければ gitignore 済みの .agent-msgs/handoff/。` +
          `(2) ユーザーに新しいセッションでの再開を案内し、このセッションを閉じてもらう。` +
          `resume で持ち越さないこと。`,
        { deliverAs: "followUp" },
      );
    } catch {
      // 注入に失敗しても通知は出ているので続行
    }
  });
}
