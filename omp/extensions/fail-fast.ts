// 同じ bash コマンドが連続2回失敗したら、3回目を試さず止まるよう steer 注入する。
// Claude/Codex は共有フック scripts/fail-fast-hook で同じことをする
// (agents/measured-notes.md「Fail fast on repeated identical failures」)。
// OMP の tool_result は isError を直接持つので、失敗判定のためだけに bash と jq を
// 毎回起動するシェルフックは経由せず、メモリ上で数える。

type ToolEvent = { toolName?: unknown; input?: unknown; isError?: unknown };

type ExtensionHandlerApi = {
  on(event: string, handler: (event: ToolEvent) => void): void;
  sendUserMessage?: (content: string, options?: { deliverAs?: "steer" }) => unknown;
};

export default function (pi: ExtensionHandlerApi): void {
  const failures = new Map<string, number>();
  const reset = () => failures.clear();
  pi.on("session_start", reset);
  pi.on("session_switch", reset);

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input;
    const command =
      input !== null && typeof input === "object" && "command" in input && typeof input.command === "string"
        ? input.command
        : "";
    if (!command) return;
    if (event.isError !== true) {
      failures.delete(command);
      return;
    }
    const count = (failures.get(command) ?? 0) + 1;
    failures.set(command, count);
    if (count < 2) return;
    pi.sendUserMessage?.(
      `[fail-fast] このコマンドはこのセッションで${count}回連続して同じように失敗した。` +
        "再試行をやめ、根本原因とユーザーが適用すべき正確な修正を報告してターンを終えること。変更なしで再実行しないこと。",
      { deliverAs: "steer" },
    );
  });
}
