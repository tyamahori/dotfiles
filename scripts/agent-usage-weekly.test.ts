import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const report = "model\tagent_type\tcalls\ta\tb\tc\td\te\tf\tcost\nmodel\tmain\t1\t0\t0\t0\t0\t0\t0\t3.50\n\n- compaction: 2 / handoff: 1\n- cacheWrite >50k の応答: 30/100 tokens (30%).\n";

test.each([
  [0, 0],
  [23, 0],
  [23, 7],
])("weekly report handles snapshot exit %i and notification exit %i", (snapshotStatus, notificationStatus) => {
  home = mkdtempSync(join(tmpdir(), "agent-usage-weekly-"));
  const bin = join(home, ".local/bin");
  const snapshotDir = join(home, "dotfiles/agents/skills/agent-usage-review/scripts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(home, "input.md"), report);
  writeFileSync(join(snapshotDir, "snapshot.sh"), '#!/bin/bash\ncat "$HOME/input.md"\nif [ "$SNAPSHOT_STATUS" -ne 0 ]; then echo "snapshot unavailable" >&2; fi\nexit "$SNAPSHOT_STATUS"\n');
  writeFileSync(join(bin, "osascript"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$HOME/notification"\nexit "$NOTIFICATION_STATUS"\n', { mode: 0o755 });

  const result = Bun.spawnSync(["/bin/bash", join(import.meta.dir, "agent-usage-weekly")], {
    env: { HOME: home, PATH: "/usr/bin:/bin", SNAPSHOT_STATUS: String(snapshotStatus), NOTIFICATION_STATUS: String(notificationStatus) },
    timeout: 10_000,
  });
  expect(result.exitCode).toBe(snapshotStatus);
  const notification = readFileSync(join(home, "notification"), "utf8");
  if (snapshotStatus === 0) {
    expect(notification).toContain("3.50 / compaction 2回 / churn 30%");
    expect(notification).toContain("警告");
    const stateDir = join(home, ".local/state/agent-usage");
    expect(readFileSync(join(stateDir, readdirSync(stateDir)[0]), "utf8")).toBe(report);
  } else {
    expect(result.stderr.toString()).toContain("snapshot unavailable");
    expect(notification).toContain("失敗");
    expect(notification).not.toContain("3.50");
  }
});
