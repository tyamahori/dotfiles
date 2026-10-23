import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");

for (const fixture of [
  {
    name: "Compose warnings",
    file: "compose.yaml",
    hook: "pre-commit-dclint",
    clean: "name: lint-check\nservices:\n  app:\n    image: alpine:3.21\n",
    bad: "services:\n  app:\n    image: alpine:3.21\n",
    rule: "require-project-name-field",
  },
  {
    name: "Dockerfile shell warnings",
    file: "Dockerfile.dev",
    hook: "pre-commit-hadolint",
    clean: "FROM scratch\nCOPY . /app\n",
    bad: "FROM alpine:3.21\nRUN echo hello | cat\n",
    rule: "DL4006",
  },
  {
    name: "SQL lint warnings",
    file: "query.sql",
    hook: "pre-commit-sqruff",
    clean: "select a, b from t;\n",
    bad: "SELECT a,b FROM t WHERE x = 1\n",
    rule: "LT01",
  },
  {
    name: "Compose short-form syntax",
    file: "compose.yaml",
    hook: "pre-commit-compose-canonical",
    clean: "name: lint-check2\nservices:\n  app:\n    image: alpine:3.21\n    volumes:\n      - type: bind\n        source: ./data\n        target: /var/lib/data\n",
    bad: "name: lint-check2\nservices:\n  app:\n    image: alpine:3.21\n    volumes:\n      - ./data:/var/lib/data\n",
    rule: "short-form volumes",
  },
]) {
  test(`${fixture.name} block edits and commits; clean files pass`, () => {
    const scratch = resolve(root, ".agent-msgs/scratch");
    mkdirSync(scratch, { recursive: true });
    const cwd = mkdtempSync(resolve(scratch, "container-lint-"));
    const run = (args: string[], input?: string) => {
      const result = spawnSync(args[0], args.slice(1), {
        cwd, input, encoding: "utf8",
      });
      if (result.error) throw result.error;
      return result;
    };
    try {
      expect(run(["git", "init", "--quiet"]).status).toBe(0);
      const file = resolve(cwd, fixture.file);
      const payload = JSON.stringify({ tool_input: { file_path: file } });
      for (const [content, blocked] of [[fixture.bad, true], [fixture.clean, false]] as const) {
        writeFileSync(file, content);
        expect(run(["git", "add", "--", fixture.file]).status).toBe(0);
        const edit = run([resolve(root, "scripts/lint-on-edit")], payload);
        expect(edit.status).toBe(0);
        const commit = run([resolve(root, "git/global-hooks/checks", fixture.hook)]);
        if (blocked) {
          expect(JSON.parse(edit.stdout).decision).toBe("block");
          expect(edit.stdout).toContain(fixture.rule);
          expect(commit.status).toBe(1);
          expect(commit.stdout + commit.stderr).toContain(fixture.rule);
        } else {
          expect(edit.stdout).toBe("");
          expect(commit.status).toBe(0);
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
}

test("lint-on-edit stays silent on a clean merge-key compose file and on YAML under a compose directory", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(resolve(scratch, "container-lint-"));
  const files = {
    "compose.yaml": "x-common: &common\n  image: alpine:3.21\nname: lint-merge\nservices:\n  a:\n    <<: *common\n  b:\n    <<: *common\n",
    "compose/prometheus.yml": "global:\n  scrape_interval: 15s\n",
  };
  try {
    mkdirSync(resolve(cwd, "compose"));
    for (const [name, content] of Object.entries(files)) {
      const file = resolve(cwd, name);
      writeFileSync(file, content);
      const edit = spawnSync(resolve(root, "scripts/lint-on-edit"), {
        input: JSON.stringify({ tool_input: { file_path: file } }),
        encoding: "utf8",
      });
      expect({ name, status: edit.status, stdout: edit.stdout }).toEqual({ name, status: 0, stdout: "" });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("lint-on-edit still runs hadolint on a Dockerfile with a YAML extension", () => {
  const scratch = resolve(root, ".agent-msgs/scratch");
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(resolve(scratch, "container-lint-"));
  try {
    const file = resolve(cwd, "Dockerfile.yml");
    writeFileSync(file, "FROM alpine:3.21\nRUN echo hello | cat\n");
    const edit = spawnSync(resolve(root, "scripts/lint-on-edit"), {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      encoding: "utf8",
    });
    expect(edit.stdout).toContain("DL4006");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
