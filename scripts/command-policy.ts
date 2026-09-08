import { resolve } from "node:path";
import ruleTable from "../agents/command-rules.json";

type Client = "claude" | "codex" | "omp";
type CommandMatch = {
  executables: string[];
  subcommand?: string;
  nextArgPattern?: string;
  requireNoRedirection?: boolean;
};

type Rule = {
  id: string;
  matcher: "command" | "curl-web-fetch";
  commands: CommandMatch[];
  excludeAfterPipe?: boolean;
  clients: Client[];
  replacement: { type: "command"; value: string } | { type: "native-tool" };
  reasons: Record<Client, string>;
};

type RuleTable = { rules: Rule[] };

const rules = (ruleTable as RuleTable).rules.map((rule) => ({
  ...rule,
  commands: rule.commands.map(({ nextArgPattern, ...match }) => ({
    ...match,
    nextArgPattern: nextArgPattern ? new RegExp(nextArgPattern) : undefined,
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
type Operator = ";" | "&" | "&&" | "|" | "||" | "(" | ")" | "<" | ">" | "<<" | ">>" | "newline";
type Token = { type: "word"; value: string } | { type: "operator"; value: Operator };
type Segment = { words: string[]; followsPipe: boolean };

function heredocOpening(line: string): { delimiter: string; stripTabs: boolean } | undefined {
  const tokens = tokenize(line);
  const opening = tokens.findIndex((token) => token.type === "operator" && token.value === "<<");
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
    pushWord();
    tokens.push({ type: "operator", value });
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
    if (pair === "&&" || pair === "||" || pair === "<<" || pair === ">>") {
      pushOperator(pair);
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

function segments(command: string): { segments: Segment[]; hasRedirection: boolean } {
  const result: Segment[] = [];
  let words: string[] = [];
  let followsPipe = false;
  let hasRedirection = false;

  const finish = () => {
    if (words.length) result.push({ words, followsPipe });
    words = [];
  };

  for (const token of tokenize(stripHeredocs(command))) {
    if (token.type === "word") {
      words.push(token.value);
      continue;
    }
    if (token.value === "<" || token.value === ">" || token.value === "<<" || token.value === ">>") {
      hasRedirection = true;
      continue;
    }
    const continuedPipe = token.value === "newline" && followsPipe && words.length === 0;
    finish();
    followsPipe = token.value === "|" || continuedPipe;
  }
  finish();
  return { segments: result, hasRedirection };
}

function commandIndex(words: string[]): number {
  let index = 0;
  while (/^[A-Za-z_]\w*=/.test(words[index] ?? "")) index += 1;
  if (words[index] === "command") index += 1;
  return index;
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
      !/^(?:localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url.hostname) &&
      !/(^|[.-])api([.-]|$)/i.test(url.hostname) &&
      !/\/(?:api|v\d+|graphql|health|healthz|metrics|status|download|downloads)(?:\/|$)/i.test(url.pathname) &&
      (!extension || /^html?$/i.test(extension))
    );
  } catch {
    return false;
  }
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
    const matched = parsed.segments.some(({ words, followsPipe }) => {
      if (rule.excludeAfterPipe && followsPipe) return false;
      const index = commandIndex(words);
      return rule.commands.some((match) =>
        match.executables.includes(words[index]) &&
        (!match.subcommand || words[index + 1] === match.subcommand) &&
        (!match.nextArgPattern || match.nextArgPattern.test(words[index + 1] ?? "")) &&
        (!match.requireNoRedirection || !parsed.hasRedirection) &&
        (rule.matcher !== "curl-web-fetch" || (!parsed.hasRedirection && isSimpleWebFetch(words.slice(index + 1))))
      );
    });
    if (!matched || !replacementAvailable(rule)) continue;
    return rule.reasons[client];
  }
}
