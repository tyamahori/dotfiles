import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "init-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const log = join(dir, "curl.log");
const stub = (path: string, body: string) => writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// Each installer's default location, moved under the temp dir with the tool already in it.
let script = readFileSync(resolve(import.meta.dir, "init"), "utf8");
for (const [real, tool] of [
  ["/opt/homebrew/bin", "brew"],
  ["/nix/var/nix/profiles/default/bin", "nix"],
  ["/usr/local/bin", "devbox"],
]) {
  const fake = join(dir, tool);
  mkdirSync(fake);
  stub(join(fake, tool), ":");
  script = script.replaceAll(real, fake);
}
writeFileSync(join(dir, "init"), script);
const bin = join(dir, "bin");
mkdirSync(bin);
stub(join(bin, "uname"), '[ "$1" = -m ] && echo arm64 || echo Darwin');
stub(join(bin, "curl"), `echo "$*" >>"${log}"`);

test("installed tools off a non-login PATH do not rerun the installers", () => {
  writeFileSync(log, "");
  const r = Bun.spawnSync(["/bin/bash", join(dir, "init")], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } });
  expect(r.exitCode).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("");
});
