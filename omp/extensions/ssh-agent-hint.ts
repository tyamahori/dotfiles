// bash ツールの git/ssh コマンドが 1Password ロック起因の
// "communication with agent failed" で失敗したとき、誤診(remote や SSH 設定の
// 書き換えに走る)を防ぐ即時ヒントを steer 注入する。Claude/Codex は共有フック
// scripts/push-agent-hint(PostToolUse decision:block)で同じことをする。

type UnknownRecord = Record<string, unknown>;

type ToolEvent = {
  toolName?: unknown;
  input?: unknown;
  content?: unknown;
  details?: unknown;
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
// SSH エージェントに触れるコマンドだけを、コマンド位置で拾う。git 全般では、
// シグネチャを本文に含む文書を git show で表示したコマンドでも発火した
// （isError の判定だけでは防げなかった）。scripts/push-agent-hint と同じ判定。
const SSH_COMMAND =
  /(^|[;&|(])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:ssh|scp|sftp|git(?:\s+(?:-[Cc]\s+\S+|-\S+))*\s+(?:push|pull|fetch|clone|ls-remote|remote\s+(?:update|show|prune)|submodule\s+update))(?:\s|$)/m;

export default function (pi: ExtensionHandlerApi): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || event.isError !== true) return;
    const record =
      event.input !== null && typeof event.input === "object"
        ? (event.input as UnknownRecord)
        : undefined;
    const command =
      typeof record?.command === "string" ? record.command : "";
    if (!SSH_COMMAND.test(command)) return;
    // 結果ペイロードの形はランタイム都合で揺れるため、結果側(content/details)を
    // まるごと文字列化してシグネチャを探す。input はコマンド文字列そのもので、
    // シグネチャを grep する成功コマンドまで拾ってしまうので含めない。
    let serialized: string;
    try {
      serialized = JSON.stringify([event.content, event.details]) ?? "";
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
