// tool_call hook: deny bare python/python3 invocations in the bash tool so
// Python always runs through uv (see the Python section of
// agents/global-instructions.md). Port of claude/hooks/deny-bare-python.sh —
// keep the two in sync. Matches python at a command position — start of
// string or after ; & | ( && || — optionally preceded by env-var assignments
// or `command`; `uv run python ...` is untouched because there python is an
// argument, not the command.

// Heredoc bodies are data, not commands — drop them before matching so a
// line like "python ..." inside a commit-message heredoc is not denied.
// The line opening the heredoc is kept (a `python3 <<EOF` command must
// still match). Only the first heredoc per line is tracked; an unmatched
// terminator skips the rest of the input, trading a possible false
// negative for never false-positiving on data.
export function stripHeredocs(cmd: string): string {
  const kept: string[] = [];
  let skip = false;
  let delim = '';
  let dash = false;
  for (const line of cmd.split('\n')) {
    if (skip) {
      const candidate = dash ? line.replace(/^\t+/, '') : line;
      if (candidate === delim) skip = false;
      continue;
    }
    kept.push(line);
    const m = line.match(/<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (m) {
      dash = m[1] === '-';
      delim = m[3];
      skip = true;
    }
  }
  return kept.join('\n');
}

// `m` flag: ^/$ match line boundaries, mirroring grep's per-line matching.
export const BARE_PYTHON =
  /(^|[;&|(])[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=[^ \t\n]*[ \t]+)*(?:command[ \t]+)?python3?(?=[ \t]|$)/m;

const REASON =
  'Bare python/python3 is blocked on this machine. FIRST read skill://efficient-python if you have not already this session — it defines the required uv invocation forms and style rules. Then run Python through uv: `uv run script.py`, `uv run python -c ...`, `uv run --with <pkg> ...`, or `uvx <tool>`. Inside a project with pyproject.toml/uv.lock, `uv run` uses the project environment.';

interface ToolCallEvent {
  toolName: string;
  input?: { command?: unknown };
}

type ToolCallResult = { block: true; reason: string } | undefined;

interface ExtensionApi {
  on(
    event: 'tool_call',
    handler: (event: ToolCallEvent) => Promise<ToolCallResult>,
  ): void;
}

export default function denyBarePython(pi: ExtensionApi) {
  pi.on('tool_call', async (event) => {
    if (event.toolName !== 'bash') return;
    const cmd = event.input?.command;
    if (typeof cmd !== 'string') return;
    if (BARE_PYTHON.test(stripHeredocs(cmd))) {
      return { block: true, reason: REASON };
    }
  });
}
