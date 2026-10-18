import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "clean-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, "bin");
mkdirSync(bin);
const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stub("uname", "echo Linux");
stub("sudo", '[ -n "$SUDO_RC" ] && exit "$SUDO_RC"\n[ "$1" = -v ] && exit 0\nexec "$@"');
stub("du", "printf '2.0G\\t/\\n'");

function clean(home: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(["/bin/bash", resolve(import.meta.dir, "clean")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
  });
}

test("a failed sudo keeps the previous reports", () => {
  const home = join(dir, "mac");
  mkdirSync(join(home, "Desktop"), { recursive: true });
  const report = join(home, "Desktop/SortedDiskSpace.txt");
  writeFileSync(report, "previous\n");
  expect(clean(home, { SUDO_RC: "1" }).exitCode).not.toBe(0);
  expect(readFileSync(report, "utf8")).toBe("previous\n");
});

test("a home without ~/Desktop (headless Linux) still gets the report", () => {
  const home = join(dir, "linux");
  mkdirSync(home);
  expect(clean(home).exitCode).toBe(0);
  expect(existsSync(join(home, "Desktop/SortedDiskSpace.txt"))).toBe(true);
});
