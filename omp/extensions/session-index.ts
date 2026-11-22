// session_start で、このセッションの transcript の場所を
// ~/.local/state/agent-sessions/sessions.jsonl に1行追記する。
//
// Claude / Codex は scripts/session-index-hook が同じ形式で書く。
// 索引は repo の外に置くため公開リポジトリへは載らない。
// 記録するのは識別子とパスだけ(プロンプト本文・コスト・トークン数は含めない)。
// 書けなくてもセッションは止めない。

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type Rec = Record<string, unknown>;
type Ctx = { sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown } };
type ExtensionHandlerApi = {
  on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
};

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-sessions");

/** transcript が無いセッション(一時セッション等)は undefined。 */
function sessionRecord(event: unknown, ctx: unknown): Rec | undefined {
  const sm = (ctx as Ctx | undefined)?.sessionManager;
  const file = sm?.getSessionFile?.();
  if (typeof file !== "string") return undefined;
  const id = sm?.getSessionId?.();
  return {
    ts: new Date().toISOString(),
    agent: "omp",
    session_id: typeof id === "string" ? id : basename(file, ".jsonl"),
    source: (event as Rec | undefined)?.reason ?? null,
    cwd: process.cwd(),
    transcript_path: file,
  };
}

export default function (pi: ExtensionHandlerApi): void {
  pi.on("session_start", (event, ctx) => {
    try {
      const record = sessionRecord(event, ctx);
      if (!record) return;
      mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(join(STATE_DIR, "sessions.jsonl"), `${JSON.stringify(record)}\n`);
    } catch {
      // 索引が書けなくてもセッションは続ける。
    }
  });
}
