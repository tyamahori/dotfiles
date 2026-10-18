import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "model-pins-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
for (const sub of ["scripts", "claude", "codex", "omp"]) mkdirSync(join(repo, sub));
copyFileSync(resolve(import.meta.dir, "model-pins"), join(repo, "scripts/model-pins"));
writeFileSync(join(repo, "codex/config.toml"), 'model = "gpt-c"\n');
writeFileSync(join(repo, "omp/config.yml"), "modelRoles:\n  slow: openai/y\n");

const run = (action: string) =>
  Bun.spawnSync(["/bin/bash", join(repo, "scripts/model-pins"), action], { env: { PATH: process.env.PATH!, HOME: repo } });
const state = join(repo, ".local/state/model-migration/last-reviewed.tsv");

test("a failed ack keeps the reviewed baseline", () => {
  writeFileSync(join(repo, "claude/settings.json"), '{"model": "opus"}');
  expect(run("ack").exitCode).toBe(0);
  const reviewed = readFileSync(state, "utf8");
  writeFileSync(join(repo, "claude/settings.json"), '{"model": ');
  expect(run("ack").exitCode).not.toBe(0);
  expect(readFileSync(state, "utf8")).toBe(reviewed);
  writeFileSync(join(repo, "claude/settings.json"), '{"model": "opus"}');
  expect(run("check").exitCode).toBe(0);
});
