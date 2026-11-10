import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const editHook = resolve(import.meta.dir, "japanese-prose-hook-edit");
const stopHook = resolve(import.meta.dir, "japanese-prose-hook-stop");
const dir = mkdtempSync(join(tmpdir(), "japanese-prose-hook-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Each case gets its own cache, so what one session records cannot leak into another case.
function sandbox(name: string) {
  const cache = join(dir, name);
  const run = (hook: string, payload: Record<string, unknown>) => {
    const r = Bun.spawnSync([hook], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, XDG_CACHE_HOME: cache },
      stdin: Buffer.from(JSON.stringify({ session_id: "s1", cwd: dir, ...payload })),
    });
    return { status: r.exitCode, out: r.stdout.toString() };
  };
  const edit = (event: "PreToolUse" | "PostToolUse", file: string) =>
    run(editHook, { hook_event_name: event, tool_input: { file_path: file } });
  // The session directories under agent-japanese-prose/claude; empty when nothing is recorded.
  const sessions = () => {
    const root = join(cache, "agent-japanese-prose/claude");
    return existsSync(root) ? readdirSync(root).map((s) => join(root, s)) : [];
  };
  return { edit, stop: () => run(stopHook, { hook_event_name: "Stop" }), sessions };
}

test("editing a file that is not prose records nothing and prints nothing", () => {
  const { edit, sessions } = sandbox("non-prose");
  expect(edit("PreToolUse", join(dir, "main.ts"))).toEqual({ status: 0, out: "" });
  expect(edit("PostToolUse", join(dir, "main.ts"))).toEqual({ status: 0, out: "" });
  expect(sessions()).toEqual([]);
});

test("editing a prose file records its pre-edit baseline and its path for the stop review", () => {
  const { edit, sessions } = sandbox("prose");
  // A file that does not exist yet has no findings; the linter is not run for it.
  const file = join(dir, "new-note.md");
  expect(edit("PreToolUse", file)).toEqual({ status: 0, out: "" });
  expect(edit("PostToolUse", file)).toEqual({ status: 0, out: "" });

  const [session] = sessions();
  const [baseline] = readdirSync(join(session, "baselines"));
  expect(JSON.parse(readFileSync(join(session, "baselines", baseline), "utf8"))).toEqual({
    schemaVersion: 1,
    file,
    findings: [],
  });
  const [recorded] = readdirSync(join(session, "files"));
  expect(readFileSync(join(session, "files", recorded), "utf8")).toBe(`${file}\n`);
});

test("ending a turn with nothing recorded prints nothing", () => {
  expect(sandbox("idle").stop()).toEqual({ status: 0, out: "" });
});

test("a recorded file that is gone when the turn ends is forgotten without a report", () => {
  const { edit, stop, sessions } = sandbox("gone");
  edit("PostToolUse", join(dir, "deleted-note.md"));
  expect(sessions()).toHaveLength(1);
  expect(stop()).toEqual({ status: 0, out: "" });
  expect(sessions()).toEqual([]);
});
