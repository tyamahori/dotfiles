// `await-*.sh`(イベントや状態変化が起きるまで終わらない待機スクリプト)を呼ぶ bash を、
// 常に async かつタイムアウト無効で実行させる。
// bash の既定タイムアウト(300秒)で待機が切られると、変化がないのに結果配信で
// セッションが起き、context 全体を読み直すターンが数分おきに積み上がる
// (2026-10-01〜02 の見張りで 341 回起床し、イベントは約 5 回だった)。
// skill に「timeout: 0 を付ける」と書くだけでは、モデルが引数を落とし続けたので、
// ここで引数を書き換える。対象を await-*.sh に限るのは、一般の async ジョブは
// ハングしたときにタイムアウトで止まってほしいからである(wait-ready.sh のような
// 数秒で返る同期チェックと名前で区別する)。

type UnknownRecord = Record<string, unknown>;

type ToolCallEvent = { toolName?: unknown; input?: unknown };

type ExtensionHandlerApi = {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent) => { input: UnknownRecord } | undefined,
  ): void;
};

const AWAIT_SCRIPT = /(^|[\s/;&|(])await-[\w-]+\.sh(\s|$|[;&|)])/;

export default function awaitScriptTimeout(pi: ExtensionHandlerApi): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    if (event.input === null || typeof event.input !== "object") return;
    const input = event.input as UnknownRecord;
    // name 付きは常駐サービスで、タイムアウトの対象外なので触らない
    if (input.name !== undefined) return;
    if (typeof input.command !== "string" || !AWAIT_SCRIPT.test(input.command)) return;
    if (input.async === true && input.timeout === 0) return;
    return { input: { ...input, async: true, timeout: 0 } };
  });
}
