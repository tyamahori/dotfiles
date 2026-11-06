import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import externalCodingAgents from "../extensions/external-coding-agents";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

// The parameter schemas are irrelevant here; any zod-style chain returns itself.
const schema: unknown = new Proxy(() => {}, { get: () => schema, apply: () => schema });

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// Loads the extension as OMP would on a machine whose home holds `files` (relative path → content).
function load(files: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "eca-home-"));
  homes.push(home);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), content);
  }
  const tools = new Map<string, Tool>();
  const calls: [string, string[]][] = [];
  externalCodingAgents(
    {
      zod: schema,
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
      exec: async (cmd: string, args: string[]) => {
        calls.push([cmd, args]);
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
    } as never,
    home,
  );
  return { tools, calls };
}

const grokAuth = { ".grok/auth.json": JSON.stringify({ "https://auth.x.ai::id": { token: "t" } }) };
const cursorAuth = { ".cursor/cli-config.json": JSON.stringify({ authInfo: { userId: 1 } }) };

test("kiro_cli passes a prompt that starts with - as the prompt, not as a flag", async () => {
  const { tools, calls } = load();

  await tools.get("kiro_cli")!.execute("id", { prompt: "- list the files" }, undefined, undefined, { cwd: "/" });
  // kiro-cli (clap) rejects "- list the files" as an unknown flag unless it follows `--`.
  expect(calls).toEqual([["kiro-cli", ["chat", "--no-interactive", "--", "- list the files"]]]);
});

test.each([
  ["no grok credentials file", {}, false],
  ["a grok credentials file emptied by logout", { ".grok/auth.json": "{}" }, false],
  ["a grok account signed in", grokAuth, true],
])("grok_build is offered only on a signed-in machine: %s", (_case, files, offered) => {
  expect(load(files).tools.has("grok_build")).toBe(offered);
});

test.each([
  ["no cursor config", {}, false],
  ["a cursor config without sign-in", { ".cursor/cli-config.json": JSON.stringify({ model: "x" }) }, false],
  ["a cursor account signed in", cursorAuth, true],
])("cursor_agent is offered only on a signed-in machine: %s", (_case, files, offered) => {
  expect(load(files).tools.has("cursor_agent")).toBe(offered);
});

test("cursor_agent runs read-only unless tool use is allowed", async () => {
  const { tools, calls } = load(cursorAuth);
  const cursor = tools.get("cursor_agent")!;

  await cursor.execute("id", { prompt: "- explain" }, undefined, undefined, { cwd: "/" });
  await cursor.execute("id", { prompt: "fix it", allowToolUse: true }, undefined, undefined, { cwd: "/" });
  // `--print` alone can write and run shell commands; `--` keeps "- explain" from parsing as a flag.
  expect(calls).toEqual([
    ["cursor-agent", ["--print", "--output-format", "text", "--trust", "--mode", "ask", "--", "- explain"]],
    ["cursor-agent", ["--print", "--output-format", "text", "--trust", "--force", "--", "fix it"]],
  ]);
});

test("grok_build denies shell, edits, and MCP tools unless tool use is allowed", async () => {
  const { tools, calls } = load(grokAuth);
  const grok = tools.get("grok_build")!;

  await grok.execute("id", { prompt: "explain" }, undefined, undefined, { cwd: "/w" });
  await grok.execute("id", { prompt: "fix it", allowToolUse: true }, undefined, undefined, { cwd: "/w" });
  // A headless run without --always-approve still auto-approves `touch`, and `--tools` alone
  // left idea's MCP terminal reachable, so the read-only run needs every deny.
  const base = ["--no-alt-screen", "--cwd", "/w"];
  expect(calls).toEqual([
    [
      "grok",
      [
        ...base,
        "--single=explain",
        "--output-format",
        "plain",
        "--tools",
        "read_file,grep,list_dir",
        "--deny",
        "MCPTool",
        "--deny",
        "Bash",
        "--deny",
        "Edit",
        "--deny",
        "Write",
      ],
    ],
    ["grok", [...base, "--single=fix it", "--output-format", "plain", "--always-approve"]],
  ]);
});
