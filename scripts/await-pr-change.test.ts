import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../agents/skills/github-pr-respond/scripts/await-pr-change.sh");

test("passes a numeric repo name to GraphQL as a string", () => {
  const dir = mkdtempSync(join(tmpdir(), "await-pr-change-"));
  try {
    const log = join(dir, "args");
    // A merged PR ends the wait after the first query.
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\0' "$@" > '${log}'\necho state=MERGED\n`, { mode: 0o755 });
    const result = Bun.spawnSync(["bash", script, "acme", "2048", "7"], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
    });
    expect(result.stdout.toString()).toBe("PR #7 is state=MERGED\n");
    const args = readFileSync(log, "utf8").split("\0");
    // `-F name=2048` would send the number 2048 for a String! variable.
    expect(args).toContainEqual("name=2048");
    expect(args[args.indexOf("name=2048") - 1]).toBe("-f");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
