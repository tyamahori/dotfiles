import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const zsh = Bun.which("zsh");
const sqlite3 = Bun.which("sqlite3");
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

// The fixture HOME has no completion dump, so this start runs a full compinit
// (about 1,000 file opens). It takes ~0.4 s alone, but in a run of every test
// file those opens have stalled past the default 5 s; nothing here asserts speed.
test.skipIf(!zsh)(
  "a shell without starship or a tty starts without errors from them",
  () => {
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
  },
  30_000,
);

test.skipIf(!zsh || !sqlite3)("the prompt shows each pool's newest usage sample, not an older higher one", () => {
  const home = join(dir, "usage-home");
  mkdirSync(join(home, ".omp/agent"), { recursive: true });
  const db = new Database(join(home, ".omp/agent/agent.db"));
  db.run(
    "CREATE TABLE usage_history (provider TEXT, account_key TEXT, limit_id TEXT, used_fraction REAL, resets_at INTEGER, recorded_at INTEGER)",
  );
  db.run("CREATE TABLE auth_credentials (provider TEXT, data TEXT)");
  db.run(
    `INSERT INTO auth_credentials VALUES ('anthropic', '{"orgId":"org-p","orgName":"me@example.com''s Organization"}')`,
  );
  const sample = db.query("INSERT INTO usage_history VALUES (?1, ?2, ?3, ?4, NULL, ?5)");
  const now = Date.now();
  sample.run("anthropic", "oauth|account:a|org:org-p", "anthropic:7d", 0.9, now - 30 * 60_000);
  sample.run("anthropic", "oauth|account:a|org:org-p", "anthropic:7d", 0.1, now);
  sample.run("openai-codex", "codex", "openai-codex:primary", 0.03, now);
  db.close();
  // Linux keeps sqlite3 in the devbox profile, outside /usr/bin.
  const bin = join(dir, "usage-bin");
  mkdirSync(bin);
  symlinkSync(sqlite3!, join(bin, "sqlite3"));

  const fn = /^_agent_usage_refresh\(\) \{\n[\s\S]*?^\}\n/m.exec(readFileSync(zshrc, "utf8"))![0];
  const r = Bun.spawnSync([zsh!, "-f", "-c", `${fn}_agent_usage_refresh; print -r -- "$STARSHIP_AGENT_USAGE"`], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
  });
  expect(stripVTControlCharacters(r.stdout.toString())).toBe("Claude personal A:10%(-)\nCodex 3%(-)\n");
});
