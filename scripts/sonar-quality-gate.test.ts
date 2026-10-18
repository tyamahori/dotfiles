import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "sonar-quality-gate");

test("sonar-project.properties continuations, spaced keys, and a final line without a newline all reach the scanner", () => {
  const home = mkdtempSync(join(tmpdir(), "sonar-quality-gate-"));
  try {
    const bin = join(home, "bin");
    const repo = join(home, "repo");
    mkdirSync(bin);
    mkdirSync(join(home, "dotfiles/sonarqube"), { recursive: true });
    writeFileSync(join(home, "dotfiles/sonarqube/compose.yaml"), "");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("docker", ":");
    stub("dscacheutil", ":");
    stub("curl", `echo '{"status":"UP","valid":true}'`);
    stub("sonar-scanner", `printf '%s\\n' "$@" > '${home}/args'`);
    for (const tool of ["jq", "git"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q", repo]);
    writeFileSync(join(repo, "untracked.txt"), "");
    writeFileSync(join(repo, "sonar-project.properties"), "sonar.exclusions=gen/**,\\\n    vendor/**\nsonar.projectKey = my-key");

    const r = Bun.spawnSync([script], {
      cwd: repo,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, DOTFILES_ROOT: join(home, "dotfiles"), SONAR_HOST_URL: "http://sonar.test", SONAR_TOKEN: "t" },
    });

    expect(r.stdout.toString()).toContain("passed (my-key)");
    expect(readFileSync(join(home, "args"), "utf8")).toContain("-Dsonar.exclusions=gen/**,vendor/**,sonar-project.properties,untracked.txt\n");
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
