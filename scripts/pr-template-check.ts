import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { commandIndex, segments } from "./command-policy.ts";

// `gh pr create --body` skips the repo's PR template, so agents that pass a
// body silently drop its sections. This finds the template headings missing
// from the body. Flags are read from the `gh pr create` segment's words, so a
// commit message or echo that only mentions the phrase, or a body that
// contains `-w`, does not count. ponytail: the heading match runs on the raw
// command text, not the expanded body — a body passed as `"$VAR"` reads as
// missing every heading; the deny reason tells the agent to inline it or use
// --body-file.

const TEMPLATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];
// A heading whose first non-blank line is this marker may be left out.
const OPTIONAL_MARKER = "<!-- pr-template:optional -->";

/** Arguments after `gh pr create`, skipping assignments and shell prefixes (`time`, `then`, `{`); undefined when absent. */
function createArguments(command: string): string[] | undefined {
  for (const { words } of segments(command)) {
    const start = commandIndex(words);
    if (words[start] === "gh" && words[start + 1] === "pr" && words[start + 2] === "create") {
      return words.slice(start + 3);
    }
  }
  return undefined;
}

function bodyText(args: string[], command: string, cwd: string): string | undefined {
  // gh fills the body from the template itself with these flags.
  if (args.some((arg) => /^(?:--fill\S*|--template|-T|--web|-w)(?:=|$)/.test(arg))) return undefined;
  const fileIndex = args.findIndex((arg) => /^(?:--body-file|-F)(?:=|$)/.test(arg));
  if (fileIndex >= 0) {
    const flag = args[fileIndex];
    const file = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args[fileIndex + 1];
    if (!file || file === "-") return undefined;
    // The shell expands `~/`, so read the same file it would.
    const path = resolve(cwd, file.replace(/^~(?=\/|$)/, homedir()));
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
  const bodyIndex = args.findIndex((arg) => /^(?:--body|-b)(?:=|$)/.test(arg));
  if (bodyIndex < 0) return undefined;
  const flag = args[bodyIndex];
  const body = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : (args[bodyIndex + 1] ?? "");
  // The tokenizer drops heredoc text, so `--body "$(cat <<EOF …)"` falls back to the raw command.
  return body.includes("$") ? command : body;
}

function requiredHeadings(template: string): string[] {
  const lines = template.split("\n");
  let fence: string | undefined;
  return lines.flatMap((line, index) => {
    // A `# comment` inside a fenced shell snippet is not a section.
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? undefined : marker;
      return [];
    }
    if (fence || !/^#{1,6}\s+\S/.test(line)) return [];
    const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== "");
    if (next?.trim() === OPTIONAL_MARKER) return [];
    return [line.replace(/^#+\s+/, "").trim()];
  });
}

/** Template headings absent from a `gh pr create` body; empty when nothing to check. */
export function missingTemplateHeadings(command: string, cwd: string): string[] {
  const template = TEMPLATES.map((name) => join(cwd, name)).find((path) => existsSync(path));
  if (!template) return [];
  const args = createArguments(command);
  if (!args) return [];
  const body = bodyText(args, command, cwd);
  if (body === undefined) return [];
  return requiredHeadings(readFileSync(template, "utf8")).filter((heading) => !body.includes(heading));
}

export function templateReason(missing: string[]): string {
  return (
    `This repo has a PR template, and \`gh pr create --body\` skips it. The body is missing these template sections: ${missing.join(", ")}. ` +
    "Fill every section (tick only verified checkboxes), passing the body inline or via --body-file so it can be checked."
  );
}
