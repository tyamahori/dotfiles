import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
