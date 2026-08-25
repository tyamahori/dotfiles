// session_start で jbcontext の増分インデックスをバックグラウンド起動する。
//
// Claude Code / Codex には jbcontext setup-agent が SessionStart フックを
// 入れるが、OMP にはその経路がない。OMP 中心の運用ではセッションが
// OMP でしか開かれないリポジトリのインデックスが古くなり、
// code_search MCP / context-search skill の検索品質が落ちる。
// この拡張が同じ「セッション開始 = インデックス鮮度確認」を OMP に足す。
//
// 動作:
// - session_start で `jbcontext index --silent` を detach 起動して即返る。
//   増分インデックスなので変更がなければ数秒で終わる。
// - .git が無いディレクトリと jbcontext 未インストール環境では何もしない。
// - 同一プロセス内の同一 cwd では一度だけ起動する(resume や
//   サブセッションでの重複起動を避ける)。失敗は無視する — 検索時に
//   古い index が使われるだけで、セッションは阻害しない。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const JBCONTEXT_BIN = join(homedir(), ".jbcontext/bin/jbcontext");

const indexedCwds = new Set<string>();

type ExtensionHandlerApi = {
  on(event: string, handler: (event: unknown, ctx: unknown) => void): void;
};

export default function (pi: ExtensionHandlerApi): void {
  pi.on("session_start", () => {
    const cwd = process.cwd();
    if (indexedCwds.has(cwd)) return;
    indexedCwds.add(cwd);
    if (!existsSync(join(cwd, ".git"))) return;
    const bin = existsSync(JBCONTEXT_BIN) ? JBCONTEXT_BIN : "jbcontext";
    try {
      const child = spawn(bin, ["index", "--silent"], {
        cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      // jbcontext が PATH にも無い等。検索品質の問題であって
      // セッションの問題ではないため黙って続行する。
    }
  });
}
