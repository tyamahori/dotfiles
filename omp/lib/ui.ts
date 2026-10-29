/** 通知だけを使う extension が host の ctx から要求する最小の形。 */
export type HasUiNotify = {
  hasUI?: boolean;
  ui?: { notify?: (message: string, level?: string) => void };
};

/** UI の無い host（print mode・subagent）では何もしない。
 *  通知の失敗は呼び出し側の処理（モデル切替など）を巻き戻さない。 */
export function safeNotify(ctx: HasUiNotify | undefined, message: string, level = "warning"): void {
  if (!ctx?.hasUI) return;
  try {
    ctx.ui?.notify?.(message, level);
  } catch {
    // 通知は付随情報で、失敗しても本処理の結果は変わらない。
  }
}
