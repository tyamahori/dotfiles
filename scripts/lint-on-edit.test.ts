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

function lintOnEdit(file: string) {
  const r = Bun.spawnSync([hook], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home!, GIT_CONFIG_NOSYSTEM: "1" },
    stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: file } })),
  });
  const out = r.stdout.toString();
  return { status: r.exitCode, reason: out ? (JSON.parse(out).reason as string) : "" };
}

// A repo without a team lint config gets the dotfiles readability rules
// (more than 4 parameters is one); `legacy` is in HEAD with one such finding.
const legacy = "export function old(a, b, c, d, e) {\n  return a + b + c + d + e;\n}\n";
function repoWithLegacy() {
  home = mkdtempSync(join(tmpdir(), "lint-on-edit-"));
  const repo = join(home, "proj");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.ts"), legacy);
  Bun.spawnSync(
    ["/bin/bash", "-c", "git init -q && git add a.ts && git -c user.email=t@t -c user.name=t commit -q -m seed"],
    {
      cwd: repo,
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  return join(repo, "a.ts");
}

test("editing a file whose only oxlint finding is already committed does not block", () => {
  const file = repoWithLegacy();
  writeFileSync(file, legacy + "export const ok = 1;\n");
  expect(lintOnEdit(file)).toEqual({ status: 0, reason: "" });
});

test("an edit that adds an oxlint finding is blocked with only the new finding", () => {
  const file = repoWithLegacy();
  writeFileSync(file, legacy + "export function added(a, b, c, d, e) {\n  return a;\n}\n");
  const r = lintOnEdit(file);
  expect(r.reason).toContain("a.ts:4 ");
  expect(r.reason).not.toContain("a.ts:1 ");
});

test("a TS file outside any git repository gets every oxlint finding", () => {
  home = mkdtempSync(join(tmpdir(), "lint-on-edit-"));
  const file = join(home, "loose.ts");
  writeFileSync(file, "debugger;\n");
  expect(lintOnEdit(file).reason).toContain("no-debugger");
});
