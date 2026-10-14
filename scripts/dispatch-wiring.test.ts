import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Regression guard: git/global-hooks/dispatch must reference every script in
// checks/, or a check silently stops running on real commits (direct
// invocation tests of a checks/* script never exercise dispatch, so a
// dropped line here has no other test coverage).
const root = resolve(import.meta.dir, "..");
const dispatch = readFileSync(resolve(root, "git/global-hooks/dispatch"), "utf8");
const checks = readdirSync(resolve(root, "git/global-hooks/checks"));

for (const check of checks) {
  test(`dispatch wires checks/${check}`, () => {
    expect(dispatch).toContain(`checks/${check}"`);
  });
}
