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

// claude at 2.0.0 that fails the run if it is asked to review.
const idleClaude = '[ "$1" = --version ] && { echo "2.0.0 (Claude Code)"; exit 0; }\nexit 1';
const stub = (home: string, name: string, body: string) => {
  writeFileSync(join(home, "bin", name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(home, "bin", name), 0o755);
};
const reviewed = (state: string) => JSON.parse(readFileSync(join(state, "reviewed.json"), "utf8"));
const reports = (state: string, prefix: string) => readdirSync(state).filter((f) => f.startsWith(prefix));

test("--ack records the tools it finds and keeps the reviewed version of one it does not", () => {
  const { home, state, run } = sandbox(idleClaude, '{"claude":"1.0.0","codex":"1.0.0"}');
  try {
    expect(run("--ack").exitCode).toBe(0);
    expect(reviewed(state)).toEqual({ claude: "2.0.0", codex: "1.0.0" });
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("--ack replaces a baseline that was left empty by an interrupted write", () => {
  const { home, state, run } = sandbox(idleClaude, "");
  try {
    expect(run("--ack").exitCode).toBe(0);
    expect(reviewed(state)).toEqual({ claude: "2.0.0" });
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("a tool that is not found keeps its reviewed version and starts no review", () => {
  const { home, state, run } = sandbox(idleClaude, '{"claude":"2.0.0","codex":"1.0.0"}');
  try {
    expect(run().exitCode).toBe(0);
    expect(reviewed(state)).toEqual({ claude: "2.0.0", codex: "1.0.0" });
    expect(reports(state, "report-")).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("a tool the baseline has never seen is recorded at its current version without a review", () => {
  const { home, state, run } = sandbox(idleClaude, '{"claude":"2.0.0"}');
  try {
    stub(home, "codex", 'echo "codex-cli 1.5.0"');
    expect(run().exitCode).toBe(0);
    expect(reviewed(state)).toEqual({ claude: "2.0.0", codex: "1.5.0" });
    expect(reports(state, "report-")).toEqual([]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("a tool found again is reviewed from the version kept while it was missing", () => {
  const { home, state, run } = sandbox(
    '[ "$1" = --version ] && { echo "2.0.0 (Claude Code)"; exit 0; }\ncat >/dev/null\necho report',
    '{"claude":"2.0.0","codex":"1.0.0"}',
  );
  try {
    expect(run().exitCode).toBe(0); // codex is not found on this run
    stub(home, "codex", 'echo "codex-cli 1.2.0"');
    stub(
      home,
      "gh",
      'case "$2" in list) printf "rust-v%s\\n" 1.2.0 1.1.0 1.0.0 0.9.0 ;; view) echo "notes of $3" ;; esac',
    );
    expect(run().exitCode).toBe(0);
    const [notes] = reports(state, "notes-");
    expect(readFileSync(join(state, notes), "utf8").match(/notes of \S+/g)).toEqual([
      "notes of rust-v1.2.0",
      "notes of rust-v1.1.0",
    ]);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
