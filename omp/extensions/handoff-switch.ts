// 引き継ぎメモ保存後のセッション切替を自動化する。
// エージェントは handoff_switch ツールにメモのパスを渡す → 現在の応答が終わった時点で
// 拡張が /handoff-switch をエディタに入れて Enter を注入する → command context の
// newSession() で空セッションに切り替え、メモを読む prompt を投入する。
// tool/event context には newSession がなく、pi.sendUserMessage は
// expandPromptTemplates:false で prompt() を通るので extension command を実行しない。
// そのため ctx.ui.custom で TUI インスタンスを取り、injectDebugInput("\r") で
// 人が Enter を押したのと同じ経路に乗せている。
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";

const COMMAND = "handoff-switch";

export default function handoffSwitch(pi: ExtensionAPI): void {
  let pending: string | undefined;

  pi.registerTool({
    name: "handoff_switch",
    label: "Handoff Switch",
    description:
      "引き継ぎメモを保存し終えたら、そのパスを渡して呼ぶ。現在の応答が完了した後に自動で新しいセッションへ切り替わり、新セッションがメモを読み込む。呼んだ後は完了報告を短く書いて応答を終えること。",
    parameters: pi.zod.object({
      path: pi.zod.string().min(1).describe("保存済みの引き継ぎメモのパス"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "有人 TUI セッションではないので切り替えない" }], isError: true };
      }
      const path = resolve(ctx.cwd, params.path);
      if (!(await Bun.file(path).exists())) {
        return { content: [{ type: "text", text: `引き継ぎメモが見つからない: ${path}` }], isError: true };
      }
      pending = path;
      return {
        content: [{ type: "text", text: `この応答の完了後に新セッションへ切り替え、${path} を読み込ませる` }],
        details: { path },
      };
    },
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!pending || !ctx.hasUI) return;
    const path = pending;
    pending = undefined;
    // agent_end 時点ではまだ streaming 扱いのことがあるので idle になってから投げる。
    const poll = ctx.setInterval(async () => {
      if (!ctx.isIdle()) return;
      ctx.clearTimer(poll);
      const tui = await ctx.ui.custom<{ injectDebugInput(bytes: string): void }>((tui, _theme, _keys, done) => {
        done(tui as never);
        return { render: () => [], handleInput: () => {}, invalidate: () => {} } as never;
      });
      ctx.ui.setEditorText(`/${COMMAND} ${path}`);
      tui.injectDebugInput("\r");
    }, 100);
  });

  pi.registerCommand(COMMAND, {
    description: "空セッションへ切り替え、引き継ぎメモを読み込ませる: /handoff-switch <path>",
    handler: async (args, ctx) => {
      const path = resolve(ctx.cwd, args.trim());
      if (!args.trim() || !(await Bun.file(path).exists())) {
        ctx.ui.notify(`handoff-switch: 引き継ぎメモが見つからない: ${path}`, "error");
        return;
      }
      await ctx.waitForIdle();
      const { cancelled } = await ctx.newSession();
      if (cancelled) {
        ctx.ui.notify("handoff-switch: 新セッションへの切り替えが取り消された", "warning");
        return;
      }
      pi.sendUserMessage(
        `引き継ぎメモ ${path} を読み、未完タスク・決定事項・次の一手を短く要約して指示を待つこと。指示なしに作業を始めないこと。`,
      );
    },
  });
}
