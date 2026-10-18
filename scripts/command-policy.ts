import { resolve } from "node:path";
import ruleTable from "../agents/command-rules.json";

type Client = "claude" | "codex" | "omp" | "copilot";
type CommandMatch = {
  executables: string[];
  subcommand?: string;
  nextArgPattern?: string;
  anyArgPattern?: string;
  noArgPattern?: string;
  // Exempt the command when every operand after the first `skipOperands`
  // (e.g. grep's search pattern) matches. Unlike noArgPattern, one allowed
  // path cannot carry a source path along with it.
  operandPattern?: string;
  skipOperands?: number;
  requireNoRedirection?: boolean;
};

type Rule = {
  id: string;
  matcher: "command" | "curl-web-fetch" | "git-commit-subject-only" | "search-allowlist";
  commands: CommandMatch[];
  excludeAfterPipe?: boolean;
  clients: Client[];
  // Applies only when every listed variable has exactly this value (e.g. a
  // rule that only makes sense inside a Herdr pane).
  requireEnv?: Record<string, string>;
  replacement: { type: "command"; value: string } | { type: "native-tool" };
  // One shared `reason`, or per-client `reasons` when the wording must name
  // that client's tools.
  reason?: string;
  reasons?: Partial<Record<Client, string>>;
};

type RuleTable = { rules: Rule[] };

const rules = (ruleTable as RuleTable).rules.map((rule) => ({
  ...rule,
  commands: rule.commands.map(({ nextArgPattern, anyArgPattern, noArgPattern, operandPattern, ...match }) => ({
    ...match,
    nextArgPattern: nextArgPattern ? new RegExp(nextArgPattern) : undefined,
    anyArgPattern: anyArgPattern ? new RegExp(anyArgPattern) : undefined,
    noArgPattern: noArgPattern ? new RegExp(noArgPattern) : undefined,
    operandPattern: operandPattern ? new RegExp(operandPattern) : undefined,
  })),
}));
const repoRoot = resolve(import.meta.dir, "..");

/**
 * This is intentionally a token scanner, not a shell parser. It recognizes
 * quotes, comments, separators, redirections, and the first heredoc per line.
 * ponytail: first heredoc per line, no shell expansion, wrapper unwrapping
 * (except `command`), or recursive script-body inspection. Unsupported shell
 * constructs may pass through; this is tool guidance, not a security sandbox.
 */
type Operator = ";" | "&" | "&&" | "|" | "|&" | "||" | "(" | ")" | "<" | ">" | "<<" | ">>" | ">&" | "&>" | "newline";
type Token = { type: "word"; value: string } | { type: "operator"; value: Operator; fd?: string };
type OperatorToken = Extract<Token, { type: "operator" }>;
type Segment = { words: string[]; followsPipe: boolean; redirected: boolean };

// `<<` inside `$((…))` or `((…))` is a left shift, not a heredoc.
function heredocIndex(tokens: Token[]): number {
  let arithmetic = 0;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    const after = tokens[at + 1];
    if (token.type !== "operator") continue;
    const doubled = after?.type === "operator" && after.value === token.value;
    if (token.value === "(" && doubled) arithmetic += 1;
    else if (token.value === ")" && doubled && arithmetic > 0) arithmetic -= 1;
    else if (token.value === "<<" && arithmetic === 0) return at;
  }
  return -1;
}

function heredocOpening(line: string): { delimiter: string; stripTabs: boolean } | undefined {
  const tokens = tokenize(line);
  const opening = heredocIndex(tokens);
  const next = tokens[opening + 1];
  if (opening === -1 || next?.type !== "word") return undefined;
  const stripTabs = next.value.startsWith("-");
  let delimiter = stripTabs ? next.value.slice(1) : next.value;
  if (next.value === "-" && tokens[opening + 2]?.type === "word") {
    delimiter = tokens[opening + 2].value;
  }
  return { delimiter, stripTabs };
}

function stripHeredocs(command: string): string {
  const kept: string[] = [];
  let delimiter: string | undefined;
  let stripTabs = false;

  for (const line of command.split("\n")) {
    if (delimiter) {
      const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) delimiter = undefined;
      continue;
    }

    kept.push(line);
    const opening = heredocOpening(line);
    if (opening) ({ delimiter, stripTabs } = opening);
  }

  return kept.join("\n");
}

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let atWordStart = true;

  const pushWord = () => {
    if (!atWordStart) tokens.push({ type: "word", value: word });
    word = "";
    atWordStart = true;
  };
  const pushOperator = (value: Operator) => {
    // Digits glued to a redirection name a file descriptor (`2>`), not a word.
    const fd = /^[<>]/.test(value) && /^\d+$/.test(word) ? word : undefined;
    if (fd !== undefined) {
      word = "";
      atWordStart = true;
    }
    pushWord();
    tokens.push({ type: "operator", value, fd });
  };

  const consumeQuotedCharacter = (character: string): boolean => {
    if (escaped) {
      if (character !== "\n") {
        word += character;
        atWordStart = false;
      }
      escaped = false;
      return true;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      return true;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      atWordStart = false;
      return true;
    }
    if (character === "'" || character === '"') {
      quote = character;
      atWordStart = false;
      return true;
    }
    return false;
  };

  const consumeUnquotedCharacter = (index: number): number => {
    const character = command[index];
    if (character === "#" && atWordStart) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      return index;
    }
    if (character === "\n") {
      pushOperator("newline");
      return index;
    }
    if (character === " " || character === "\t" || character === "\r") {
      pushWord();
      return index;
    }

    const pair = command.slice(index, index + 2);
    if (["&&", "||", "|&", "<<", ">>", ">&", "&>"].includes(pair)) {
      pushOperator(pair as Operator);
      return index + 1;
    }
    if (";&|()<>".includes(character)) {
      pushOperator(character as Operator);
      return index;
    }

    word += character;
    atWordStart = false;
    return index;
  };

  let index = 0;
  while (index < command.length) {
    const consumed = consumeQuotedCharacter(command[index]);
    index = (consumed ? index : consumeUnquotedCharacter(index)) + 1;
  }
  pushWord();
  return tokens;
}

// An output target is not an argument. Only stdout sent to a file makes a
// reader write-mode: `2>/dev/null` and `>&2` still print to the agent.
function writesStdoutToFile(redirection: OperatorToken, target: string): boolean {
  if (redirection.value === "&>") return true;
  if (redirection.fd !== undefined && redirection.fd !== "1") return false;
  return redirection.value !== ">&" || !/^(?:\d+|-)$/.test(target);
}

export function segments(command: string): Segment[] {
  const result: Segment[] = [];
  let words: string[] = [];
  let followsPipe = false;
  let redirected = false;
  let output: OperatorToken | undefined;

  const finish = () => {
    if (words.length) result.push({ words, followsPipe, redirected });
    words = [];
    redirected = false;
  };

  for (const token of tokenize(stripHeredocs(command))) {
    if (token.type === "word") {
      if (output) redirected ||= writesStdoutToFile(output, token.value);
      else words.push(token.value);
      output = undefined;
      continue;
    }
    // `<` stays a read (its target remains a word); `<<` feeds literal text.
    if (token.value === "<" || token.value === "<<") {
      redirected ||= token.value === "<<";
      continue;
    }
    if (token.value === ">" || token.value === ">>" || token.value === ">&" || token.value === "&>") {
      output = token;
      continue;
    }
    output = undefined;
    const continuedPipe: boolean = token.value === "newline" && followsPipe && words.length === 0;
    finish();
    followsPipe = token.value === "|" || token.value === "|&" || continuedPipe;
  }
  finish();
  return result;
}

// Options and the number right after one (`-n 50`, `-n +2`, `-c 1k`) are not
// operands; anything else is, including the pattern and a file named `1k`.
function operandsMatch(args: string[], skip: number, pattern: RegExp): boolean {
  const operands = args.filter((word, at) => !word.startsWith("-") && !(/^\+?\d+(?:[bkmgKMG]|[KMG]i?B)?$/.test(word) && args[at - 1]?.startsWith("-"))).slice(skip);
  return operands.length > 0 && operands.every((word) => pattern.test(word));
}

// Flags that cannot widen what a search reads or prints: no -e/-f (a pattern
// can then hide a file operand), no -r/-R/-L (recursion, rg's symlink follow),
// and the context/max-count flags only with an attached number (`-A2`).
const SAFE_SHORT_FLAGS = /^-(?:[ivncowxFqsHhl]+|[ABCm]\d+)$/;
const SAFE_LONG_FLAGS: Record<string, true> = {
  "--ignore-case": true,
  "--invert-match": true,
  "--line-number": true,
  "--count": true,
  "--only-matching": true,
  "--word-regexp": true,
  "--line-regexp": true,
  "--fixed-strings": true,
  "--quiet": true,
  "--silent": true,
  "--files-with-matches": true,
};

// Allowlist for the `search-allowlist` matcher: a post-pipe filter whose one
// operand is the pattern (it reads stdin), or a file-names-only `-l` search.
function isSafeSearch(args: string[], followsPipe: boolean, redirected: boolean): boolean {
  if (redirected) return false;
  const operands: string[] = [];
  let listOnly = false;
  for (const argument of args) {
    if (!argument.startsWith("-")) {
      operands.push(argument);
      continue;
    }
    if (!SAFE_SHORT_FLAGS.test(argument) && !Object.hasOwn(SAFE_LONG_FLAGS, argument)) return false;
    if (argument === "--files-with-matches" || /^-[^-]*l/.test(argument)) listOnly = true;
  }
  return (followsPipe && operands.length === 1) || (listOnly && operands.length > 0);
}

function commandIndex(words: string[]): number {
  let index = 0;
  while (/^[A-Za-z_]\w*=/.test(words[index] ?? "")) index += 1;
  if (words[index] === "command") index += 1;
  return index;
}

function subcommandMatches(words: string[], index: number, subcommand: string): boolean {
  if (words[index] !== "git") return words[index + 1] === subcommand;
  let cursor = index + 1;
  while (cursor < words.length) {
    const option = words[cursor];
    if (option === "--") return words[cursor + 1] === subcommand;
    if (option === "-C" || option === "-c" || option === "--exec-path") {
      cursor += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|exec-path)=/.test(option) || /^-[Cc].+/.test(option)) {
      cursor += 1;
      continue;
    }
    return option === subcommand;
  }
  return false;
}

function isSimpleWebFetch(args: string[]): boolean {
  // Unknown options stay with curl: ax cannot preserve their semantics.
  const urls: string[] = [];
  for (const argument of args) {
    if (/^-[fsSL]+$/.test(argument) || ["--fail", "--silent", "--show-error", "--location"].includes(argument)) continue;
    if (argument.startsWith("-")) return false;
    urls.push(argument);
  }
  if (urls.length !== 1) return false;

  try {
    const url = new URL(urls[0]);
    const filename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const extension = filename.includes(".") ? filename.slice(filename.indexOf(".") + 1) : "";
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !/^(?:(?:.+\.)?localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname) &&
      !/(^|[.-])api([.-]|$)/i.test(url.hostname) &&
      !/\/(?:api|v\d+|graphql|health|healthz|metrics|status|download|downloads)(?:\/|$)/i.test(url.pathname) &&
      (!extension || /^html?$/i.test(extension))
    );
  } catch {
    return false;
  }
}

// Mirrors git/global-hooks/checks/commit-msg-why before the commit runs, so the
// pre-commit checks are not paid for a message the hook will reject. Only one
// literal single-line `-m` counts: a second `-m`, a quoted newline, or any `$`
// (`$(cat <<EOF …)`, `$'…'`, variables) may carry a body this scanner cannot see.
function isSubjectOnlyCommit(args: string[]): boolean {
  const messages: string[] = [];
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    if (args[cursor] === "--") break;
    const kind = commitArgument(args[cursor]);
    if (kind === "exempt") return false;
    if (kind === "next") {
      cursor += 1;
      messages.push(args[cursor] ?? "");
    } else if (kind) {
      messages.push(kind.message);
    }
  }
  return (
    messages.length === 1 &&
    !/[\n$]/.test(messages[0]) &&
    !/^(?:fixup!|squash!|amend!|Merge |Revert )/.test(messages[0])
  );
}

// One `git commit` argument: "exempt" ends the scan (commit-msg-why passes it
// too), "next" means the following argument is a message.
function commitArgument(argument: string): "exempt" | "next" | { message: string } | undefined {
  if (/^--(?:file|reuse-message|reedit-message|fixup|squash|no-verify|template|edit)(?:=|$)/.test(argument)) return "exempt";
  if (argument === "--message") return "next";
  if (argument.startsWith("--message=")) return { message: argument.slice("--message=".length) };
  if (!/^-[A-Za-z]/.test(argument)) return undefined;
  // A short-option cluster ends at the first letter that takes a value.
  for (let offset = 1; offset < argument.length; offset += 1) {
    const letter = argument[offset];
    if ("FCctne".includes(letter)) return "exempt"; // message file, reused message, template, --no-verify, editor
    if (letter === "m") return offset + 1 < argument.length ? { message: argument.slice(offset + 1) } : "next";
  }
  return undefined;
}

function replacementAvailable(rule: Pick<Rule, "replacement">): boolean {
  if (rule.replacement.type === "native-tool") return true;
  const replacement = rule.replacement.value.startsWith("scripts/")
    ? resolve(repoRoot, rule.replacement.value)
    : rule.replacement.value;
  return Bun.which(replacement) !== null;
}

/** Returns the client-specific denial reason, or undefined when the command is allowed. */
export function denyCommand(command: string, client: Client): string | undefined {
  const parsed = segments(command);
  for (const rule of rules) {
    if (!rule.clients.includes(client)) continue;
    if (rule.requireEnv && Object.entries(rule.requireEnv).some(([name, value]) => process.env[name] !== value)) continue;
    const matched = parsed.some(({ words, followsPipe, redirected }) => {
      if (rule.excludeAfterPipe && followsPipe) return false;
      if (rule.matcher === "search-allowlist") {
        // Any word naming a searcher counts, so `env`, `command`, `xargs`,
        // `sudo`, and absolute paths cannot hide it.
        const at = words.findIndex((word) => rule.commands[0].executables.includes(word.slice(word.lastIndexOf("/") + 1)));
        return at !== -1 && !(at === 0 && isSafeSearch(words.slice(1), followsPipe, redirected));
      }
      const index = commandIndex(words);
      return rule.commands.some((match) =>
        match.executables.includes(words[index]) &&
        (!match.subcommand || subcommandMatches(words, index, match.subcommand)) &&
        (!match.nextArgPattern || match.nextArgPattern.test(words[index + 1] ?? "")) &&
        (!match.anyArgPattern || words.slice(index + 1).some((word) => match.anyArgPattern!.test(word))) &&
        (!match.noArgPattern || !words.slice(index + 1).some((word) => match.noArgPattern!.test(word))) &&
        (!match.operandPattern || !operandsMatch(words.slice(index + 1), match.skipOperands ?? 0, match.operandPattern)) &&
        (!match.requireNoRedirection || !redirected) &&
        (rule.matcher !== "curl-web-fetch" || (!redirected && isSimpleWebFetch(words.slice(index + 1)))) &&
        (rule.matcher !== "git-commit-subject-only" || isSubjectOnlyCommit(words.slice(words.indexOf("commit", index) + 1)))
      );
    });
    if (!matched || !replacementAvailable(rule)) continue;
    return rule.reasons?.[client] ?? rule.reason;
  }
}
