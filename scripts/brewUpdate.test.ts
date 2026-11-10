import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "brew-update-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The whole script against stubs: a copy beside stub siblings, and stub
// brew/uname/omp. FAIL names the one step that exits 3.
function sandbox() {
  const home = mkdtempSync(join(dir, "home-"));
  const scripts = join(home, "scripts");
  const bin = join(home, ".local/bin");
  mkdirSync(scripts);
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  copyFileSync(resolve(import.meta.dir, "brewUpdate"), join(scripts, "brewUpdate"));
  const stub = (path: string, body: string) => writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const name of ["skill-sync", "tool-release-review"]) stub(join(scripts, name), "exit 0");
  stub(join(scripts, "tool-restart"), '[ "$FAIL" = tool-restart ] && exit 1; exit 0');
  stub(join(scripts, "python"), '[ "$FAIL" = python ] && exit 3; exit 0');
  stub(join(bin, "omp"), '[ "$FAIL" = omp ] && exit 3; exit 0');
  stub(join(home, ".bun/bin/bun"), '[ "$FAIL" = bun ] && exit 3; exit 0');
  stub(join(bin, "brew"), 'echo "$*" >>"$HOME/brew.log"; [ "$FAIL" = "$1" ] && exit 3; exit 0');
  stub(join(bin, "uname"), 'echo "$OS"');
  const run = (os: string, fail: string) =>
    Bun.spawnSync(["/bin/bash", join(scripts, "brewUpdate")], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, OS: os, FAIL: fail },
      timeout: 10_000,
    });
  return { home, run };
}

test.each([
  ["Darwin", "none", 0, true],
  ["Darwin", "upgrade", 3, false],
  ["Darwin", "python", 3, true],
  ["Darwin", "bun", 3, true],
  // tool-restart --cleanup-check reports a process still on an old keg.
  ["Darwin", "tool-restart", 0, false],
  ["Linux", "omp", 3, false],
])("on %s, a failing %s step sets exit %i (brew cleanup ran: %p)", (os, fail, status, cleaned) => {
  const { home, run } = sandbox();
  const result = run(os, fail);
  expect(result.exitCode).toBe(status);
  const log = existsSync(join(home, "brew.log")) ? readFileSync(join(home, "brew.log"), "utf8") : "";
  expect(log.includes("cleanup")).toBe(cleaned);
  if (fail === "upgrade" || fail === "omp") expect(result.stderr.toString()).toContain("brewUpdate: ");
});

test("hook state older than a week is removed and newer state is kept", () => {
  const { home, run } = sandbox();
  const cache = join(home, ".cache");
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  // Children first: adding one would bring a directory's own mtime back to now.
  const entry = (path: string, old: boolean) => {
    if (path.endsWith(".count")) {
      mkdirSync(join(cache, "agent-fail-fast"), { recursive: true });
      writeFileSync(join(cache, path), "1");
    } else {
      mkdirSync(join(cache, path, "files"), { recursive: true });
    }
    if (old) utimesSync(join(cache, path), monthAgo, monthAgo);
  };
  entry("agent-japanese-prose/omp/old-session", true);
  entry("agent-japanese-prose/omp/new-session", false);
  entry("agent-fail-fast/old.count", true);
  entry("agent-fail-fast/new.count", false);

  expect(run("Darwin", "none").exitCode).toBe(0);

  const left = (path: string) => existsSync(join(cache, path));
  expect({
    oldSession: left("agent-japanese-prose/omp/old-session"),
    newSession: left("agent-japanese-prose/omp/new-session"),
    oldCount: left("agent-fail-fast/old.count"),
    newCount: left("agent-fail-fast/new.count"),
  }).toEqual({ oldSession: false, newSession: true, oldCount: false, newCount: true });
});
