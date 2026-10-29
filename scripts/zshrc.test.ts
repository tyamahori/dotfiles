import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const zsh = Bun.which("zsh");
const zshrc = resolve(import.meta.dir, "../dotfiles/.zshrc");
const dir = mkdtempSync(join(tmpdir(), "zshrc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!zsh)("a completion cache follows a nix store update (new path, mtime 1970)", () => {
  const fn = /^_cache_completion\(\) \{\n[\s\S]*?^\}\n/m.exec(readFileSync(zshrc, "utf8"))![0];
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const version of ["1", "2"]) {
    const store = join(dir, `store-${version}`);
    writeFileSync(store, `#!/bin/sh\necho "#compdef tool v${version}"\n`, { mode: 0o755 });
    utimesSync(store, 1, 1);
  }
  const run = (version: string) => {
    rmSync(join(bin, "tool"), { force: true });
    symlinkSync(join(dir, `store-${version}`), join(bin, "tool"));
    const r = Bun.spawnSync([zsh!, "-f", "-c", `_comp_cache_dir=${dir}/cache\n${fn}_cache_completion tool tool`], {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(r.exitCode).toBe(0);
    return readFileSync(join(dir, "cache/_tool"), "utf8");
  };
  expect(run("1")).toBe("#compdef tool v1\n");
  expect(run("2")).toBe("#compdef tool v2\n");
});

test.skipIf(!zsh)("a shell without starship or a tty starts without errors from them", () => {
  const home = join(dir, "home");
  const bin = join(dir, "only-fzf");
  mkdirSync(home);
  mkdirSync(bin);
  const fzf = Bun.which("fzf");
  if (fzf) symlinkSync(fzf, join(bin, "fzf"));
  writeFileSync(join(home, ".zshrc"), readFileSync(zshrc));
  const r = Bun.spawnSync([zsh!, "-i", "-c", "exit"], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: "dumb" },
  });
  const err = r.stderr.toString();
  expect(err).not.toContain("starship");
  expect(err).not.toContain("can't change option: zle");
});
