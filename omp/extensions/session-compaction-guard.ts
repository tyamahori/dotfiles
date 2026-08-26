// 有人TUIセッションでの自動コンパクション反復を抑えるガード。
// 2回目以後の auto_compaction_end と、移行前の次のinteractive inputで
// model-visibleなfollow-upを送り、引き継ぎ後のセッション切替を促す。

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

  const reset = () => {
    autoCompactionEnds = 0;
    sessionSwitchNudged = false;
  };

  // A runner can remain loaded while the TUI switches sessions.
  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  pi.on("auto_compaction_end", (_event, ctx) => {
    if (!ctx?.hasUI) return;

    autoCompactionEnds += 1;
    if (autoCompactionEnds < 2) return;

    sessionSwitchNudged = true;
    try {
      ctx.ui?.notify?.(
        `session-compaction-guard: 自動コンパクションが${autoCompactionEnds}回完了した。現在の依頼を完了し、引き継ぎメモを保存してから /quit または /new で新しいセッションへ移ってください`,
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
        "完了報告の末尾で、ユーザーへ /quit または /new で新しいセッションへ移るよう案内すること。/handoff は同じセッション内の圧縮であり、セッション切り替えとして案内しないこと。";
      const repeatedReminder =
        `[session-compaction-guard] 自動コンパクションが${autoCompactionEnds}回完了したが、セッション移行が未完了。` +
        "現在の依頼を完了して引き継ぎメモを保存し、/quit または /new へ移ること。新しい無関係な依頼をこのセッションで始めないこと。";
      pi.sendUserMessage?.(
        autoCompactionEnds === 2 ? firstReminder : repeatedReminder,
        { deliverAs: "followUp" },
      );
    } catch {
      // 通知済みなので、注入に失敗しても現在の依頼は続行する。
    }
  });

  pi.on("input", (event, ctx) => {
    if (!ctx?.hasUI || !sessionSwitchNudged) return;

    const input = event as { source?: string; text?: string };
    const text = input.text?.trimStart() ?? "";
    if (input.source !== "interactive" || /^\/(?:new|quit|q|exit|resume|drop)(?:\s|$)/.test(text)) return;

    try {
      ctx.ui?.notify?.(
        "session-compaction-guard: 新しいセッションへの移行が未完了です。この入力の処理後、引き継ぎメモを保存して /quit または /new を実行してください",
        "warning",
      );
    } catch {
      // 再通知の失敗は入力処理を妨げない。
    }

    try {
      pi.sendUserMessage?.(
        "[session-compaction-guard] セッション移行前に新しい入力を受けた。" +
          "この入力の処理だけを完了し、引き継ぎメモを保存して /quit または /new へ移ること。" +
          "さらに別の依頼をこのセッションで始めないこと。",
        { deliverAs: "followUp" },
      );
    } catch {
      // UI通知済みなので、follow-upの失敗は入力処理を妨げない。
    }
  });
}
