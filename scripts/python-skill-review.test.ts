import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "python-skill-review");

test.each([
  ["release list", "exit 1"],
  // view runs inside the `| while` loop, where bash 3.2 skips the ERR trap.
  ["release view", '[ "$2" = list ] && { echo 0.9.0; exit 0; }\nexit 1'],
])("a failing gh %s still notifies once under launchd", (_step, gh) => {
  const home = mkdtempSync(join(tmpdir(), "python-skill-review-"));
  try {
    // The script prepends $HOME/.local/bin to PATH and finds the audit next to itself.
    const bin = join(home, ".local/bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, "repo/scripts"), { recursive: true });
    cpSync(script, join(home, "repo/scripts/python-skill-review"));
    const stub = (path: string, body: string) => {
      writeFileSync(path, `#!/bin/bash\n${body}\n`);
      chmodSync(path, 0o755);
    };
    stub(join(home, "repo/scripts/audit-python-usage"), "echo '{}'");
    stub(join(bin, "devbox"), ":");
    stub(join(bin, "gh"), gh);
    stub(join(bin, "osascript"), `printf '%s\\n' "$2" >> '${home}/notified'`);

    const r = Bun.spawnSync([join(home, "repo/scripts/python-skill-review")], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });

    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(home, "notified"), "utf8")).toMatch(/^display notification "レビューが失敗しました（exit 1）[^\n]*\n$/);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
