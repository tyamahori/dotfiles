import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// `gh pr create --body` skips the repo's PR template, so agents that pass a
// body silently drop its sections. This finds the template headings missing
// from the body. ponytail: substring match on the raw command text, not a
// shell parser — a body passed as `"$VAR"` reads as missing every heading;
// the deny reason tells the agent to inline it or use --body-file.

const CREATE = /(^|[\s;&|(])gh\s+pr\s+create(\s|$)/;
const TEMPLATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

function bodyText(command: string, cwd: string): string | undefined {
  // gh fills the body from the template itself with these flags.
  if (/\s(?:--fill\S*|--template|-T|--web|-w)(?:[\s=]|$)/.test(command)) return undefined;
  const file = command.match(/\s(?:--body-file|-F)(?:\s+|=)(['"]?)([^'"\s]+)\1/);
  if (file) {
    if (file[2] === "-") return undefined;
    const path = isAbsolute(file[2]) ? file[2] : join(cwd, file[2]);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
  return /\s(?:--body|-b)(?:[\s=]|$)/.test(command) ? command : undefined;
}

/** Template headings absent from a `gh pr create` body; empty when nothing to check. */
export function missingTemplateHeadings(command: string, cwd: string): string[] {
  if (!CREATE.test(command)) return [];
  const template = TEMPLATES.map((name) => join(cwd, name)).find((path) => existsSync(path));
  if (!template) return [];
  const body = bodyText(command, cwd);
  if (body === undefined) return [];
  return readFileSync(template, "utf8")
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#+\s+/, "").trim())
    .filter((heading) => !body.includes(heading));
}

export function templateReason(missing: string[]): string {
  return (
    `This repo has a PR template, and \`gh pr create --body\` skips it. The body is missing these template sections: ${missing.join(", ")}. ` +
    "Fill every section (tick only verified checkboxes), passing the body inline or via --body-file so it can be checked."
  );
}
