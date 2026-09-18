/**
 * Blocks OMP's native `read`/`grep` tools from loading `.env`-style credential
 * files into context. Shell-level reads (cat/head/tail/tee/...) are covered
 * separately by the `env-file-read` rule in agents/command-rules.json via
 * deny-commands.ts. `glob` is left alone: it only lists filenames, never
 * content. ponytail: filename heuristic, not a security sandbox — a script
 * that opens the file itself (e.g. `read_text(".env")` in a Python one-liner)
 * still gets through; see docs/omp.md.
 */
const ENV_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\..+)?|[^/]*\.env)$/;

function isEnvPath(raw: string): boolean {
  return raw.split(";").some((segment) => {
    const noQuery = segment.trim().split("?")[0];
    const lastSlash = noQuery.lastIndexOf("/");
    const lastColon = noQuery.lastIndexOf(":");
    const noSelector = lastColon > lastSlash ? noQuery.slice(0, lastColon) : noQuery;
    return ENV_FILE_PATTERN.test(noSelector) || ENV_FILE_PATTERN.test(noQuery);
  });
}

interface ToolCallEvent {
  toolName: string;
  input?: { path?: unknown };
}

type ToolCallResult = { block: true; reason: string } | undefined;

interface ExtensionApi {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent) => ToolCallResult,
  ): void;
}

const REASON =
  "`.env`-style credential files are blocked from the read/grep tools. These files hold plaintext secrets — don't load one into context unless the user explicitly asked you to inspect that exact file.";

export default function denyEnvReads(pi: ExtensionApi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "read" && event.toolName !== "grep") return;
    const path = event.input?.path;
    if (typeof path !== "string") return;
    if (isEnvPath(path)) return { block: true, reason: REASON };
  });
}

export { isEnvPath };
