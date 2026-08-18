// 有人TUIセッションでの自動コンパクション反復を抑えるガード。
// 2回目の auto_compaction_end の後だけ、現在の依頼を終えてから /handoff
// するよう follow-up を注入する。手動 compaction は別イベントなので数えない。

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
  let handoffNudged = false;

  const reset = () => {
    autoCompactionEnds = 0;
    handoffNudged = false;
  };

  // A runner can remain loaded while the TUI switches sessions.
  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  pi.on("auto_compaction_end", (_event, ctx) => {
    if (!ctx?.hasUI || handoffNudged) return;

    autoCompactionEnds += 1;
    if (autoCompactionEnds !== 2) return;

    handoffNudged = true;
    try {
      ctx.ui?.notify?.(
        "session-compaction-guard: 自動コンパクションが2回完了した。現在の依頼の後に /handoff で新セッションへ移ることを提案する",
        "warning",
      );
    } catch {
      // UI通知の失敗は follow-up 注入を妨げない。
    }
    try {
      pi.sendUserMessage?.(
        "[session-compaction-guard] この有人TUIセッションでは自動コンパクションが2回完了した。" +
          "現在の依頼を中断せず完了してから、/handoff を実行して新しいセッションへ移ること。" +
          "次の依頼は新セッションで続ける。",
        { deliverAs: "followUp" },
      );
    } catch {
      // 通知済みなので、注入に失敗しても現在の依頼は続行する。
    }
  });
}
