// 有人TUIセッションでの自動コンパクション反復を抑えるガード。
// 2回目の auto_compaction_end 後、現在の依頼を終えてから /handoff
// するよう follow-up を注入し、未実行のまま次の入力が来たら再通知する。

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
        "session-compaction-guard: 自動コンパクションが2回完了した。現在の依頼を完了したら、次の入力を送る前に /handoff を実行してください",
        "warning",
      );
    } catch {
      // UI通知の失敗は follow-up 注入を妨げない。
    }
    try {
      pi.sendUserMessage?.(
        "[session-compaction-guard] この有人TUIセッションでは自動コンパクションが2回完了した。" +
          "現在の依頼を中断せず完了すること。完了報告の末尾で、ユーザーへ「次の依頼を送る前に /handoff を実行してください」と明示すること。" +
          "/handoff を自分が実行したように書かず、次の依頼は新しいセッションで受けること。",
        { deliverAs: "followUp" },
      );
    } catch {
      // 通知済みなので、注入に失敗しても現在の依頼は続行する。
    }
  });

  pi.on("input", (event, ctx) => {
    if (!ctx?.hasUI || !handoffNudged) return;

    const input = event as { source?: string; text?: string };
    if (input.source !== "interactive" || input.text?.trimStart().startsWith("/handoff")) return;

    try {
      ctx.ui?.notify?.(
        "session-compaction-guard: /handoff が未実行です。この入力の処理後、次の依頼を送る前に /handoff を実行してください",
        "warning",
      );
    } catch {
      // 再通知の失敗は入力処理を妨げない。
    }
  });
}
