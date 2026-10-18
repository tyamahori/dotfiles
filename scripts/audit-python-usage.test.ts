import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "audit-python-usage");

test("a same-day --save rerun diffs against the previous day's snapshot, not its own file", () => {
  const home = mkdtempSync(join(tmpdir(), "audit-python-usage-"));
  try {
    const state = join(home, ".local/state/python-usage-audit");
    const projects = join(home, "projects");
    mkdirSync(state, { recursive: true });
    mkdirSync(projects);
    writeFileSync(join(state, "2000-01-01.json"), JSON.stringify({ totals: { python_cmds: 1 } }));

    // uv keeps its cache and managed Pythons under the real HOME; keep using them.
    const env = {
      ...process.env,
      HOME: home,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(homedir(), ".cache/uv"),
      UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? join(homedir(), ".local/share/uv/python"),
    };
    const run = () => {
      const r = Bun.spawnSync(["uv", "run", "--script", script, "--save", "--projects-dir", projects], { env });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stderr.toString();
    };

    expect(run()).toContain("delta vs 2000-01-01.json");
    expect(run()).toContain("delta vs 2000-01-01.json");
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}, 60_000);

// +14 and -12 hours: at any moment at least one of them is on a different date than UTC.
test.each(["Pacific/Kiritimati", "Etc/GMT+12"])("the snapshot is named by the local date in %s", (tz) => {
  const home = mkdtempSync(join(tmpdir(), "audit-python-usage-"));
  try {
    const projects = join(home, "projects");
    mkdirSync(projects);
    const env = {
      ...process.env,
      HOME: home,
      TZ: tz,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? join(homedir(), ".cache/uv"),
      UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? join(homedir(), ".local/share/uv/python"),
    };
    const r = Bun.spawnSync(["uv", "run", "--script", script, "--save", "--projects-dir", projects], { env });
    const local = Bun.spawnSync(["date", "+%Y-%m-%d"], { env }).stdout.toString().trim();
    expect(r.stderr.toString()).toContain(`python-usage-audit/${local}.json`);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}, 60_000);
