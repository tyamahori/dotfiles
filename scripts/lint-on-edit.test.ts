import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const hook = resolve(import.meta.dir, "lint-on-edit");
let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

// Edit time must agree with git/global-hooks/checks/pre-commit-json.
test("lint-on-edit judges JSON the way the pre-commit check does", () => {
  home = mkdtempSync(join(tmpdir(), "lint-on-edit-"));
  const jsonc = '// comment\n{"a": 1}\n';
  const unsorted = '{\n  "b": 1,\n  "a": 2\n}\n';
  const cases: [string, string, boolean][] = [
    ["proj/biome.json", jsonc, false],
    ["proj/app/turbo.json", jsonc, false],
    ["proj/.eslintrc.json", jsonc, false],
    ["proj/.devcontainer.json", jsonc, false],
    ["proj/data.json", jsonc, true],
    ["dotfiles/omp/dap.json", unsorted, true],
    [".omp/agent/dap.json", unsorted, true],
    [".claude/settings.json", unsorted, true],
    ["proj/.claude/settings.json", unsorted, false],
  ];
  for (const [rel, content, blocked] of cases) {
    const file = join(home, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    const r = Bun.spawnSync([hook], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: file } })),
    });
    expect({ rel, status: r.exitCode, blocked: r.stdout.toString().includes('"block"') }).toEqual({
      rel,
      status: 0,
      blocked,
    });
  }
});
