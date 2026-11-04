import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "sonar-quality-gate");

// A home with stubbed tools and a Git repo carrying sonar-project.properties.
// `os` is what the stubbed `uname -s` reports.
function fixture(os: "Darwin" | "Linux") {
  const home = mkdtempSync(join(tmpdir(), "sonar-quality-gate-"));
  const bin = join(home, "bin");
  const repo = join(home, "repo");
  mkdirSync(bin);
  mkdirSync(join(home, "dotfiles/sonarqube"), { recursive: true });
  writeFileSync(join(home, "dotfiles/sonarqube/compose.yaml"), "");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("uname", `echo ${os}`);
  stub("docker", `touch '${home}/docker-called'`);
  stub("dscacheutil", ":");
  stub("curl", `echo '{"status":"UP","valid":true}'`);
  stub("sonar-scanner", `printf '%s\\n' "$@" > '${home}/args'; printf '%s' "$SONAR_TOKEN" > '${home}/scanner-token'`);
  for (const tool of ["jq", "git"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  writeFileSync(join(repo, "sonar-project.properties"), "sonar.projectKey=my-key\n");
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    Bun.spawnSync([script, ...args], {
      cwd: repo,
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        DOTFILES_ROOT: join(home, "dotfiles"),
        SONAR_HOST_URL: "http://sonar.test",
        ...env,
      },
    });
  return { home, repo, stub, run, cleanup: () => rmSync(home, { force: true, recursive: true }) };
}

test("sonar-project.properties continuations, spaced keys, and a final line without a newline all reach the scanner", () => {
  const f = fixture("Darwin");
  try {
    writeFileSync(join(f.repo, "untracked.txt"), "");
    writeFileSync(
      join(f.repo, "sonar-project.properties"),
      "sonar.exclusions=gen/**,\\\n    vendor/**\nsonar.projectKey = my-key",
    );

    const r = f.run([], { SONAR_TOKEN: "t" });

    expect(r.stdout.toString()).toContain("passed (my-key)");
    expect(readFileSync(join(f.home, "args"), "utf8")).toContain(
      "-Dsonar.exclusions=gen/**,vendor/**,sonar-project.properties,untracked.txt\n",
    );
  } finally {
    f.cleanup();
  }
});

test("on Linux without SONAR_TOKEN or a token file, the gate fails and points at the token file", () => {
  const f = fixture("Linux");
  try {
    const r = f.run();

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(join(f.home, ".config/sonar-quality-gate/token"));
    expect(existsSync(join(f.home, "args"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("on Linux with a token file, the gate analyses with that token and never starts a server", () => {
  const f = fixture("Linux");
  try {
    mkdirSync(join(f.home, ".config/sonar-quality-gate"), { recursive: true });
    writeFileSync(join(f.home, ".config/sonar-quality-gate/token"), "vm-token");

    const r = f.run();

    expect(r.stdout.toString()).toContain("passed (my-key)");
    expect(readFileSync(join(f.home, "scanner-token"), "utf8")).toBe("vm-token");
    expect(existsSync(join(f.home, "docker-called"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("on Linux with the Mac's server unreachable, the gate fails without analysing", () => {
  const f = fixture("Linux");
  try {
    f.stub("curl", "exit 7");

    const r = f.run([], { SONAR_TOKEN: "t" });

    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("SonarQube is not up at http://sonar.test");
    expect(existsSync(join(f.home, "args"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("--issue-token on the Mac prints a fresh token named for the VM and leaves the Mac's Keychain token alone", () => {
  const f = fixture("Darwin");
  try {
    f.stub("security", `echo "$@" >> '${f.home}/security-calls'; [[ $1 == find-generic-password ]] && echo admin-pw`);
    f.stub(
      "curl",
      `case "$*" in
  *user_tokens/search*) echo '{"userTokens":[]}' ;;
  *user_tokens/generate*) echo "$*" > '${f.home}/generate'; echo '{"token":"vm-tok"}' ;;
  *) echo '{"status":"UP","valid":true}' ;;
esac`,
    );

    const r = f.run(["--issue-token", "vmname"]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("vm-tok\n");
    expect(readFileSync(join(f.home, "generate"), "utf8")).toContain("name=dotfiles-quality-gate-vmname");
    expect(readFileSync(join(f.home, "security-calls"), "utf8")).not.toContain("add-generic-password");
  } finally {
    f.cleanup();
  }
});
