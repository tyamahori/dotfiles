// 有人TUIセッションでの自動コンパクション反復を抑えるガード。
// 2回目以後の auto_compaction_end と、移行前の次のinteractive inputで
// model-visibleなfollow-upを送り、引き継ぎ後のセッション切替を促す。
// handoff_switch が成功したら以後は黙る: follow-up は 1 ターンに 1 通ずつ届くため、
// 溜まったリマインダーが切替を 1 ターンずつ先送りしていた (measured 2026-09-08:
// 余分に 5 ターン・compaction 1 回・cache write 100k)。

type Ctx = {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void };
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

export default function (pi: ExtensionHandlerApi): void {
  let autoCompactionEnds = 0;
  let sessionSwitchNudged = false;
  let switchRequested = false;

  const reset = () => {
    autoCompactionEnds = 0;
    sessionSwitchNudged = false;
    switchRequested = false;
  };

  // A runner can remain loaded while the TUI switches sessions.
  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  pi.on("tool_result", (event) => {
    const result = event as { toolName?: string; isError?: boolean };
    if (result.toolName === "handoff_switch" && !result.isError) switchRequested = true;
  });

  pi.on("auto_compaction_end", (_event, ctx) => {
    if (!ctx?.hasUI || switchRequested) return;

    autoCompactionEnds += 1;
    if (autoCompactionEnds < 2) return;

    sessionSwitchNudged = true;
    try {
      ctx.ui?.notify?.(
        `session-compaction-guard: 自動コンパクションが${autoCompactionEnds}回完了した。現在の依頼を完了し、引き継ぎメモを保存してから handoff_switch で新しいセッションへ移ります`,
        "warning",
      );
    } catch {
      // UI通知の失敗は follow-up 注入を妨げない。
    }
    try {
      const firstReminder =
        "[session-compaction-guard] この有人TUIセッションでは自動コンパクションが2回完了した。" +
        "現在の依頼を中断せず完了し、完了報告の前に、次のセッションへ必要な未完タスク・決定事項・変更済みファイル・未実行確認を引き継ぎメモへ保存すること" +
        "(置き場はリポジトリが明示的に定義していればそこ、なければ gitignore 済みの .agent-msgs/handoff/)。" +
        "メモを保存したら未完の todo を block(reason: handoff)し、handoff_switch ツールにそのパスを渡して呼ぶこと(未完 todo が残ると停止時の todo リマインダーで作業が再開され切替が着地しない)。呼ぶと応答完了後に自動で新セッションへ切り替わり、メモが読み込まれる。/handoff は同じセッション内の圧縮であり、代わりにならない。";
      const repeatedReminder =
        `[session-compaction-guard] 自動コンパクションが${autoCompactionEnds}回完了したが、セッション移行が未完了。` +
        "現在の依頼を完了して引き継ぎメモを保存し、handoff_switch ツールを呼ぶこと。新しい無関係な依頼をこのセッションで始めないこと。";
      pi.sendUserMessage?.(
        autoCompactionEnds === 2 ? firstReminder : repeatedReminder,
        { deliverAs: "followUp" },
      );
    } catch {
      // 通知済みなので、注入に失敗しても現在の依頼は続行する。
    }
  });

  pi.on("input", (event, ctx) => {
    if (!ctx?.hasUI || !sessionSwitchNudged || switchRequested) return;

    const input = event as { source?: string; text?: string };
    const text = input.text?.trimStart() ?? "";
    // handoff-switch.ts は /handoff-switch を interactive 入力として注入する。
    if (input.source !== "interactive" || /^\/(?:new|quit|q|exit|resume|drop|handoff-switch)(?:\s|$)/.test(text)) return;

    try {
      ctx.ui?.notify?.(
        "session-compaction-guard: 新しいセッションへの移行が未完了です。この入力の処理後、引き継ぎメモを保存して handoff_switch を呼びます",
        "warning",
      );
    } catch {
      // 再通知の失敗は入力処理を妨げない。
    }

    try {
      pi.sendUserMessage?.(
        "[session-compaction-guard] セッション移行前に新しい入力を受けた。" +
          "この入力の処理だけを完了し、引き継ぎメモを保存して handoff_switch ツールを呼ぶこと。" +
          "さらに別の依頼をこのセッションで始めないこと。",
        { deliverAs: "followUp" },
      );
    } catch {
      // UI通知済みなので、follow-upの失敗は入力処理を妨げない。
    }
  });
}
