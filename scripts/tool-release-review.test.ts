import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "tool-release-review");

test("a failing claude cleans up the report, records nothing, and exits non-zero", () => {
  const home = mkdtempSync(join(tmpdir(), "tool-release-review-"));
  try {
    const bin = join(home, "bin");
    const state = join(home, ".local/state/tool-release-review");
    mkdirSync(bin);
    mkdirSync(state, { recursive: true });
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    // Only claude is "installed", at a newer version than the reviewed one.
    stub("claude", '[ "$1" = --version ] && { echo "2.0.0 (Claude Code)"; exit 0; }\ncat >/dev/null\nexit 1');
    stub("gh", 'case "$2" in list) echo v2.0.0 ;; view) echo notes ;; esac');
    symlinkSync(Bun.which("jq")!, join(bin, "jq"));
    writeFileSync(join(state, "reviewed.json"), '{"claude":"1.0.0"}');

    const r = Bun.spawnSync([script], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TOOL_RELEASE_REVIEW_PANE: "off" },
    });

    expect(r.exitCode).toBe(1);
    expect(readdirSync(state).filter((f) => f.startsWith("report-"))).toEqual([]);
    expect(existsSync(join(state, "reported.json"))).toBe(false);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
