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
