// bash ツールの git/ssh コマンドが 1Password ロック起因の
// "communication with agent failed" で失敗したとき、誤診(remote や SSH 設定の
// 書き換えに走る)を防ぐ即時ヒントを steer 注入する。Claude/Codex は共有フック
// scripts/push-agent-hint(PostToolUse decision:block)で同じことをする。

type UnknownRecord = Record<string, unknown>;

type ToolEvent = {
  toolName?: unknown;
  input?: unknown;
  isError?: unknown;
};

type ExtensionHandlerApi = {
  on(event: string, handler: (event: ToolEvent, ctx: unknown) => void): void;
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ) => unknown;
};

const SIGNATURE = /communication with agent failed/i;
const GIT_OR_SSH = /(^|[^A-Za-z0-9_])(git|ssh)([^A-Za-z0-9_]|$)/;

export default function (pi: ExtensionHandlerApi): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const record =
      event.input !== null && typeof event.input === "object"
        ? (event.input as UnknownRecord)
        : undefined;
    const command =
      typeof record?.command === "string" ? record.command : "";
    if (!GIT_OR_SSH.test(command)) return;
    // 結果ペイロードの形はランタイム都合で揺れるため、イベント全体を
    // 文字列化してシグネチャを探す。コマンド文字列自体がシグネチャを含む
    // ことは実質ない。
    let serialized: string;
    try {
      serialized = JSON.stringify(event) ?? "";
    } catch {
      return;
    }
    if (!SIGNATURE.test(serialized)) return;
    pi.sendUserMessage?.(
      "[ssh-agent-hint] この失敗は 1Password(このマシンの SSH agent)がロックされているだけで、" +
        "ネットワークや認証設定の問題ではない。remote・SSH config・プロトコルの書き換えに走らないこと。" +
        "ユーザーに 1Password の解錠(GUI 承認)を依頼し、解錠後に同じコマンドを1回だけ再試行する。" +
        "同じエラーが再発したらそこで止めて報告する(fail-fast 規範)。",
      { deliverAs: "steer" },
    );
  });
}
