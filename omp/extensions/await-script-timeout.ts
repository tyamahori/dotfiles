// `await-*.sh`(イベントや状態変化が起きるまで終わらない待機スクリプト)を呼ぶ bash を、
// 常に async かつタイムアウト無効で実行させる。
// bash の既定タイムアウト(300秒)で待機が切られると、変化がないのに結果配信で
// セッションが起き、context 全体を読み直すターンが数分おきに積み上がる
// (2026-10-01〜02 の見張りで 341 回起床し、イベントは約 5 回だった)。
// skill に「timeout: 0 を付ける」と書くだけでは、モデルが引数を落とし続けたので、
// ここで引数を書き換える。対象を await-*.sh に限るのは、一般の async ジョブは
// ハングしたときにタイムアウトで止まってほしいからである(wait-ready.sh のような
// 数秒で返る同期チェックと名前で区別する)。
//
// 同じハンドラで、name と async/timeout の併用も直す。bash は name 付きを常駐
// サービスとして扱い「Service mode does not accept async or timeout」で拒否するが、
// モデルは有限ジョブに名札を付けるつもりで name を足しており、拒否のあとは name を
// 外して同じコマンドを送り直していた。その再試行を省くため name と、サービス専用の
// ready を外す。別の extension に分けないのは、
// name を外した後の入力に await-*.sh の規則を当てる順序を保証するためである。

type UnknownRecord = Record<string, unknown>;

type ToolCallEvent = { toolName?: unknown; input?: unknown };

type ExtensionHandlerApi = {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent) => { input: UnknownRecord } | undefined,
  ): void;
};

// スクリプトを実行する位置(行頭か ; & | ( の直後。bash などの前置きは可)の
// await-*.sh だけを対象にする。git add・shellcheck・コミットメッセージのように
// 名前に触れるだけのコマンドまで、タイムアウトなしの async にしないため。
function runsAwaitScript(command: string): boolean {
  return command.split(/[;&|(\n]/).some((segment) => {
    const words = segment.trim().replace(/^(?:(?:bash|sh|zsh|exec|nohup)\s+)+/, "");
    const quote = words[0];
    const script =
      quote === '"' || quote === "'" ? words.slice(1, words.indexOf(quote, 1)) : words.split(/\s/, 1)[0];
    return /(?:^|\/)await-[\w-]+\.sh$/.test(script);
  });
}

// bash が拒否するのは name と async: true、または数値の timeout の組だけで、
// name と async: false は常駐サービスとして通る(2026-10-18 に実ツールで確認)。
function dropServiceArgs(input: UnknownRecord): UnknownRecord {
  if (input.name === undefined) return input;
  if (input.async !== true && typeof input.timeout !== "number") return input;
  const job = { ...input };
  delete job.name;
  delete job.ready;
  return job;
}

export default function awaitScriptTimeout(pi: ExtensionHandlerApi): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    if (event.input === null || typeof event.input !== "object") return;
    const original = event.input as UnknownRecord;
    let input = dropServiceArgs(original);
    // name 付きは常駐サービスで、タイムアウトの対象外なので触らない
    const awaitJob =
      input.name === undefined && typeof input.command === "string" && runsAwaitScript(input.command);
    if (awaitJob && !(input.async === true && input.timeout === 0)) {
      input = { ...input, async: true, timeout: 0 };
    }
    return input === original ? undefined : { input };
  });
}
