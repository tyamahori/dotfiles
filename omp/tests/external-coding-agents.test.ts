import { expect, test } from "bun:test";
import externalCodingAgents from "../extensions/external-coding-agents";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

// The parameter schemas are irrelevant here; any zod-style chain returns itself.
const schema: unknown = new Proxy(() => {}, { get: () => schema, apply: () => schema });

test("kiro_cli passes a prompt that starts with - as the prompt, not as a flag", async () => {
  const tools = new Map<string, Tool>();
  const calls: [string, string[]][] = [];
  externalCodingAgents({
    zod: schema,
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    exec: async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
  } as never);

  await tools.get("kiro_cli")!.execute("id", { prompt: "- list the files" }, undefined, undefined, { cwd: "/" });
  // kiro-cli (clap) rejects "- list the files" as an unknown flag unless it follows `--`.
  expect(calls).toEqual([["kiro-cli", ["chat", "--no-interactive", "--", "- list the files"]]]);
});
