import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "apps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, "bin");
const home = join(dir, "home");
const log = join(dir, "log");
mkdirSync(bin);
mkdirSync(join(home, ".local/bin"), { recursive: true });
writeFileSync(join(home, ".local/bin/omp"), "", { mode: 0o755 });

const stubs: Record<string, string> = {
  uname: "echo Linux",
  sudo: `echo "sudo $*" >>"${log}"`,
  npm: '[ "$1" != ls ]',
  snap: "exit 1",
  "apt-cache": ":",
  dpkg: '[ -n "$INSTALLED" ]',
  systemctl: ":",
  id: '[ "$1" = -un ] && echo me || echo docker',
  ax: ":",
};
for (const [name, body] of Object.entries(stubs)) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// The apt list files already exist, as on a rerun after a failed `apt-get update`.
const listsExist = '[() { case "$3" in /etc/apt/sources.list.d/*) return 1 ;; esac; builtin [ "$@"; }';

function run(env: Record<string, string>) {
  writeFileSync(log, "");
  const script = resolve(import.meta.dir, "apps");
  const r = Bun.spawnSync(["/bin/bash", "-c", `${listsExist}; source "$0"`, script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
  });
  return { status: r.exitCode, err: r.stderr.toString(), calls: readFileSync(log, "utf8") };
}

test("a rerun after a failed apt-get update refreshes the lists before installing", () => {
  const r = run({ USER: "me" });
  expect(r.status).toBe(0);
  expect(r.calls).toMatch(/^sudo apt-get update\nsudo apt-get install -y claude-code /m);
});

test("nothing missing means no apt-get update", () => {
  expect(run({ USER: "me", INSTALLED: "1" }).calls).not.toContain("apt-get");
});

test("an unset USER (cron, env -i) still reaches the docker group check", () => {
  const r = run({});
  expect(r.err).not.toContain("unbound variable");
  expect(r.status).toBe(0);
});
