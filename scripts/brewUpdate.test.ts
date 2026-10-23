import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "brew-update-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Only the function: running the whole script would upgrade Homebrew.
const source = readFileSync(resolve(import.meta.dir, "brewUpdate"), "utf8");
const fn = /^stale_omp_executable\(\) \{\n[\s\S]*?^\}\n/m.exec(source)![0];

function stale(ps: string, lsof: string) {
  for (const [name, out] of [["ps", ps], ["lsof", lsof]]) {
    writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s' '${out}'\n`, { mode: 0o755 });
  }
  const r = Bun.spawnSync(["/bin/bash", "-c", `${fn}stale_omp_executable /c/Cellar/omp/2/bin/omp`], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
  });
  return { status: r.exitCode, out: r.stdout.toString().trim() };
}

test("a session launched as plain `omp` on an old keg blocks brew cleanup", () => {
  expect(stale("omp --allow-home\n", "p42\nn/c/Cellar/omp/1/bin/omp\n")).toEqual({ status: 0, out: "/c/Cellar/omp/1/bin/omp" });
  expect(stale("omp --allow-home\n", "p42\nn/c/Cellar/omp/2/bin/omp\n").status).toBe(1);
  expect(stale("/c/Cellar/omp/1/bin/omp worker\n", "").status).toBe(0);
});

// The whole script against stubs: a copy beside stub siblings, and stub
// brew/uname/ps/lsof/omp. FAIL names the one step that exits 3.
test.each([
  ["Darwin", "none", 0, true],
  ["Darwin", "upgrade", 3, false],
  ["Darwin", "python", 3, true],
  ["Linux", "omp", 3, false],
])("on %s, a failing %s step sets exit %i (brew cleanup ran: %p)", (os, fail, status, cleaned) => {
  const home = mkdtempSync(join(dir, "home-"));
  const scripts = join(home, "scripts");
  const bin = join(home, ".local/bin");
  mkdirSync(scripts);
  mkdirSync(bin, { recursive: true });
  copyFileSync(resolve(import.meta.dir, "brewUpdate"), join(scripts, "brewUpdate"));
  const stub = (path: string, body: string) => writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const name of ["skill-sync", "tool-release-review"]) stub(join(scripts, name), "exit 0");
  stub(join(scripts, "python"), '[ "$FAIL" = python ] && exit 3; exit 0');
  stub(join(bin, "omp"), '[ "$FAIL" = omp ] && exit 3; exit 0');
  stub(join(bin, "brew"), 'echo "$*" >>"$HOME/brew.log"; [ "$FAIL" = "$1" ] && exit 3; exit 0');
  stub(join(bin, "uname"), 'echo "$OS"');
  for (const name of ["ps", "lsof"]) stub(join(bin, name), "exit 0");

  const result = Bun.spawnSync(["/bin/bash", join(scripts, "brewUpdate")], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, OS: os, FAIL: fail },
    timeout: 10_000,
  });
  expect(result.exitCode).toBe(status);
  const log = existsSync(join(home, "brew.log")) ? readFileSync(join(home, "brew.log"), "utf8") : "";
  expect(log.includes("cleanup")).toBe(cleaned);
  if (fail === "upgrade" || fail === "omp") expect(result.stderr.toString()).toContain("brewUpdate: ");
});
