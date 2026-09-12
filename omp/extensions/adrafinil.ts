// adrafinil (https://github.com/kageroumado/adrafinil) と OMP の連携。
// adrafinil の純正 install-hooks が生成するテンプレートは "agent_settled" イベント
// (現行 OMP に存在しない) を前提にしており、かつ古い ~/.pi (死んだ実体ディレクトリ、
// 現行 OMP は読まない) に向けて書き込まれていたため使えない。代わりに現行 OMP の
// イベントカタログに実在するフックで直接 acquire/release する。
//
// - agent_start: セッションのターンが始まるたびに acquire (TTL 4h で再確保)。
// - session_stop: メインセッションが自動継続しないと確定した時点で release。
//   subagent セッションでは発火しない (OMP 仕様) ため、このフックは main session 専用。
// - session_shutdown: 異常終了時の安全網として release を二重化 (release は冪等)。
//
// CLI パスは ~/.local/bin 配下(adrafinil の標準インストール先)。--tool omp
// ラベルで他ツールの acquire/release と区別する。

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const ADRAFINIL = `${homedir()}/.local/bin/adrafinil`;
const TOOL = "omp";
const TTL_SECONDS = 4 * 60 * 60;

type Ctx = {
  sessionManager?: { getSessionId?: () => string | undefined };
};

type ExtensionHandlerApi = {
  on(event: string, handler: (event: unknown, ctx: Ctx | undefined) => void): void;
};

// セッション ID はフックごとに ctx から解決するが、取得できなかった呼び出し
// (例: 起動直後で sessionManager が未初期化) に備えて一度解決できた値を使い回し、
// acquire と release が別のキーを指してしまうのを防ぐ。
let cachedSessionKey: string | undefined;

function resolveSessionKey(ctx: Ctx | undefined): string | undefined {
  const id = ctx?.sessionManager?.getSessionId?.();
  if (typeof id === "string" && id.length > 0) {
    cachedSessionKey = id;
  }
  return cachedSessionKey;
}

function runAdrafinil(args: string[]): void {
  try {
    spawnSync(ADRAFINIL, args, {
      encoding: "utf8",
      timeout: 5_000,
    });
    // 戻り値/エラーは無視する: adrafinil 未インストール・一時的な失敗で
    // OMP セッション自体を止めてはいけない (スリープ防止はベストエフォート)。
  } catch {
    // spawn 自体の失敗 (バイナリ不在など) も無視。
  }
}

export default function adrafinilExtension(pi: ExtensionHandlerApi): void {
  pi.on("agent_start", (_event, ctx) => {
    const key = resolveSessionKey(ctx);
    if (!key) return;
    runAdrafinil(["acquire", key, "--tool", TOOL, "--ttl", String(TTL_SECONDS)]);
  });

  pi.on("session_stop", (_event, ctx) => {
    const key = resolveSessionKey(ctx);
    if (!key) return;
    runAdrafinil(["release", key, "--tool", TOOL]);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = resolveSessionKey(ctx);
    if (!key) return;
    runAdrafinil(["release", key, "--tool", TOOL]);
  });
}
