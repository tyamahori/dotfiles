import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function sandbox(claude: string, reviewed: string) {
  const home = mkdtempSync(join(tmpdir(), "tool-release-review-"));
  const bin = join(home, "bin");
  const state = join(home, ".local/state/tool-release-review");
  mkdirSync(bin);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/bash\n${claude}\n`);
  chmodSync(join(bin, "claude"), 0o755);
  symlinkSync(Bun.which("jq")!, join(bin, "jq"));
  writeFileSync(join(state, "reviewed.json"), reviewed);
  const run = (...args: string[]) =>
    Bun.spawnSync([script, ...args], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TOOL_RELEASE_REVIEW_PANE: "off" },
    });
  return { home, state, run };
}

test("a failing --ack keeps the reviewed baseline", () => {
  const { home, state, run } = sandbox("exit 3", '{"claude":"1.0.0"}');
  try {
    expect(run("--ack").exitCode).not.toBe(0);
    expect(readFileSync(join(state, "reviewed.json"), "utf8")).toBe('{"claude":"1.0.0"}');
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("a tool that disappeared moves the baseline without a review", () => {
  // claude would fail the run if asked to review.
  const { home, state, run } = sandbox(
    '[ "$1" = --version ] && { echo "2.0.0 (Claude Code)"; exit 0; }\nexit 1',
    '{"claude":"2.0.0","codex":"1.0.0"}',
  );
  try {
    expect(run().exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(state, "reviewed.json"), "utf8"))).toEqual({ claude: "2.0.0" });
    expect(readdirSync(state).filter((f) => f.startsWith("report-"))).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
