import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const base = "name: t\nservices:\n  app:\n    image: alpine:3.21\n";

for (const row of [
  {
    name: "compose config validates a variant layered on its base",
    hook: "pre-commit-compose-config",
    // compose.prod.yaml alone has no image, so it is only valid as an overlay.
    files: { "compose.yaml": base, "compose.prod.yaml": "services:\n  app:\n    environment: {A: \"1\"}\n" },
    stage: ["compose.yaml", "compose.prod.yaml"],
    blockedWith: null,
  },
  {
    name: "compose config rejects an unknown key in a staged override",
    hook: "pre-commit-compose-config",
    files: { "compose.yaml": base, "compose.override.yaml": "services:\n  app:\n    imagee: x\n" },
    stage: ["compose.override.yaml"],
    blockedWith: "additional properties 'imagee' not allowed",
  },
  {
    name: "semgrep blocks a privileged Compose service",
    hook: "pre-commit-semgrep",
    files: { "compose.yaml": `${base}    privileged: true\n` },
    stage: ["compose.yaml"],
    blockedWith: "compose-privileged",
  },
  {
    name: "semgrep honours nosemgrep on a Compose finding",
    hook: "pre-commit-semgrep",
    files: { "compose.yaml": `${base}    privileged: true # nosemgrep: compose-privileged\n` },
    stage: ["compose.yaml"],
    blockedWith: null,
  },
]) {
  test(row.name, () => {
    const scratch = resolve(root, ".agent-msgs/scratch");
    mkdirSync(scratch, { recursive: true });
    const cwd = mkdtempSync(resolve(scratch, "compose-check-"));
    const run = (args: string[]) => {
      const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    };
    try {
      expect(run(["git", "init", "--quiet"]).status).toBe(0);
      for (const [file, content] of Object.entries(row.files)) writeFileSync(resolve(cwd, file), content);
      expect(run(["git", "add", "--", ...row.stage]).status).toBe(0);
      const commit = run([resolve(root, "git/global-hooks/checks", row.hook)]);
      if (row.blockedWith) {
        expect(commit.status).toBe(1);
        expect(commit.stdout + commit.stderr).toContain(row.blockedWith);
      } else {
        expect(commit.stdout + commit.stderr).toBe("");
        expect(commit.status).toBe(0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
}
