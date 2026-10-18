import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingTemplateHeadings } from "./pr-template-check";

const repo = mkdtempSync(join(tmpdir(), "pr-template-"));
mkdirSync(join(repo, ".github"));
writeFileSync(join(repo, ".github/pull_request_template.md"), "## Summary\n\ntext\n\n## Test plan\n- [ ] run\n");
afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("reports template headings missing from an inline or file body", () => {
  expect(missingTemplateHeadings("gh pr create --draft --body '## Summary\nx'", repo)).toEqual(["Test plan"]);
  writeFileSync(join(repo, "body.md"), "## Summary\n## Test plan\n");
  expect(missingTemplateHeadings("gh pr create --draft --body-file body.md", repo)).toEqual([]);
});

test("stays silent when gh applies the template itself or there is nothing to check", () => {
  for (const command of ["gh pr create --draft --fill", "gh pr create --draft -T x", "gh pr create --draft --body-file -", "gh pr view --body x"]) {
    expect(missingTemplateHeadings(command, repo)).toEqual([]);
  }
  expect(missingTemplateHeadings("gh pr create --draft --body x", tmpdir())).toEqual([]);
});

test("checks only a real gh pr create segment and ignores flag-like body text", () => {
  for (const command of [
    `git commit -m "docs: explain PR flow" -m "Why: agents run gh pr create --body and skip the template"`,
    "echo gh pr create --body hi",
  ]) {
    expect(missingTemplateHeadings(command, repo)).toEqual([]);
  }
  expect(missingTemplateHeadings("gh pr create --draft --body '## Summary\nrun npm test -w pkg'", repo)).toEqual(["Test plan"]);
  expect(missingTemplateHeadings("GH_REPO=o/r gh pr create --draft --body '## Summary'", repo)).toEqual(["Test plan"]);
  expect(missingTemplateHeadings(`gh pr create --draft --body "$(cat <<'EOF'\n## Summary\nx\nEOF\n)"`, repo)).toEqual(["Test plan"]);
});

test("does not require sections the template marks optional", () => {
  const optional = mkdtempSync(join(tmpdir(), "pr-template-optional-"));
  try {
    mkdirSync(join(optional, ".github"));
    writeFileSync(
      join(optional, ".github/pull_request_template.md"),
      "## Summary\ntext\n\n## Screenshots\n\n<!-- pr-template:optional -->\n- Before:\n\n## Notes\n<!-- other comment -->\n",
    );
    expect(missingTemplateHeadings("gh pr create --draft --body '## Summary\nx'", optional)).toEqual(["Notes"]);
  } finally {
    rmSync(optional, { recursive: true, force: true });
  }
});
