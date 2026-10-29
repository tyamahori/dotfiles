// 行動で必要になる Skill を、その行動の tool_call で案内する。
//
// global instructions の「Skills to load first」は条件と Skill を対応づけているが、
// Python 実行・ブラウザ操作・テスト編集のような「行動」が条件の Skill は依頼文に
// 現れないため読み漏れやすい。依頼文から推薦する旧 jev-skill-hint は、推薦の約6%
// しか読まれず、行動型 Skill はほぼ拾えなかった(2026-09-19〜10-15, 345ターン実測)。
// そこで条件を tool_call 側で判定し、そのセッションで未読の Skill だけを1回 steer で
// 案内する。ツールは止めない(案内は非拘束。必読の規範は global instructions 側)。

import { editedPaths } from "./lint-on-edit";

type ToolEvent = { toolName?: unknown; input?: unknown };

type ExtensionApi = {
  on(event: string, handler: (event: ToolEvent) => void): void;
  sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => unknown;
};

// コマンド位置(行頭か ; & | ( の直後)だけを見る。引数中の "python" は拾わない。
const PYTHON_COMMAND = /^(uv run|uvx|python3?)(\s|$)/;
const JS_COMMAND = /^(bun (--no-install )?(run|-e)|node -e)(\s|$)/;
const BROWSER_CALL = /\bbrowser\.open\s*\(/;
const TEST_PATH = /(\.test\.|\.spec\.|_test\.|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$)/;
// TS/JS の形(関数の大きさ、class を使う場面、型の最小化)は software-design の TS 節、
// 型の規律と実行・検証の手順は efficient-ts-js にある。テストの形は test-design が
// 受け持つので software-design は外すが、テストも TS/JS なので efficient-ts-js は要る。
const TS_JS_PATH = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function bashSkills(command: string): string[] {
  const heads = command.split(/[;&|(\n]/).map((segment) => segment.trimStart());
  const skills: string[] = [];
  if (heads.some((head) => PYTHON_COMMAND.test(head))) skills.push("efficient-python");
  if (heads.some((head) => JS_COMMAND.test(head))) skills.push("efficient-ts-js");
  return skills;
}

function evalSkills(input: Record<string, unknown>): string[] {
  const skills: string[] = [];
  if (input.language === "py") skills.push("efficient-python");
  if (input.language === "js") skills.push("efficient-ts-js");
  if (typeof input.code === "string" && BROWSER_CALL.test(input.code)) skills.push("browser-verify");
  return skills;
}

/** この tool_call が条件に当たる Skill 名を返す。 */
export function triggeredSkills(event: ToolEvent): string[] {
  const input = event.input !== null && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
  let skills: string[] = [];
  if (event.toolName === "bash" && typeof input.command === "string") skills = bashSkills(input.command);
  else if (event.toolName === "eval") skills = evalSkills(input);
  const paths = editedPaths(event);
  if (paths.some((path) => TEST_PATH.test(path))) skills.push("test-design");
  const tsJsPaths = paths.filter((path) => TS_JS_PATH.test(path));
  if (tsJsPaths.some((path) => !TEST_PATH.test(path))) skills.push("software-design");
  if (tsJsPaths.length > 0) skills.push("efficient-ts-js");
  return skills;
}

export default function skillTriggerHint(pi: ExtensionApi): void {
  // 読んだ Skill と案内済みの Skill。/new や /resume で文脈が替わると読んだ Skill も
  // 文脈から消えるので、セッション切替で空にする。
  const done = new Set<string>();
  pi.on("session_switch", () => done.clear());

  pi.on("tool_call", (event) => {
    if (event.toolName === "read") {
      const path = (event.input as { path?: unknown } | undefined)?.path;
      const match = /^skill:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]*)/.exec(typeof path === "string" ? path : "");
      if (match) done.add(match[1]);
      return;
    }
    const pending = triggeredSkills(event).filter((name) => !done.has(name));
    if (pending.length === 0) return;
    for (const name of pending) done.add(name);
    const uris = pending.map((name) => "skill://" + name).join("、");
    pi.sendUserMessage?.(`[skill-trigger-hint] この操作は ${uris} の適用条件に当たる。未読なら読んでから続ける。`, {
      deliverAs: "steer",
    });
  });
}
