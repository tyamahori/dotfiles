/**
 * Blocks OMP's native `read`/`grep` tools from loading `.env`-style credential
 * files into context. Shell-level reads (cat/head/tail/tee/...) are covered
 * separately by the `env-file-read` rule in agents/command-rules.json via
 * deny-commands.ts. `glob` is left alone: it only lists filenames, never
 * content. ponytail: filename heuristic, not a security sandbox — a script
 * that opens the file itself (e.g. `read_text(".env")` in a Python one-liner)
 * still gets through; see docs/omp.md.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Case-insensitive: APFS is, so `.ENV` opens `.env`.
const ENV_FILE_PATTERN = /(?:^|\/)(?:\.env(?:\..+)?|[^/]*\.env)$/i;
// A glob basename (`.env*`, `.e*`, `{.env,x}`) opens the same files through
// grep; block it when it can match any of these representative names.
const ENV_SAMPLES = [".env", ".env.local", "x.env"];

function isEnvPart(part: string): boolean {
  if (ENV_FILE_PATTERN.test(part)) return true;
  const base = part.slice(part.lastIndexOf("/") + 1).toLowerCase();
  if (!/[*?[{]/.test(base)) return false;
  const glob = new Bun.Glob(base);
  return ENV_SAMPLES.some((name) => glob.match(name));
}

function isEnvPath(raw: string, cwd = process.cwd()): boolean {
  return raw.split(";").some((segment) => {
    const noQuery = segment.trim().split("?")[0];
    // Selectors (`.env:1-5:raw`) and archive members (`a.zip:.env.local`)
    // follow colons, as do URI schemes (`local://`): test every part.
    if (noQuery.split(":").some(isEnvPart)) return true;
    // A symlink can give a credential file an innocent name.
    try {
      return ENV_FILE_PATTERN.test(realpathSync(resolve(cwd, noQuery.split(":")[0].replace(/^~(?=\/|$)/, homedir()))));
    } catch {
      return false;
    }
  });
}

interface ToolCallEvent {
  toolName: string;
  input?: { path?: unknown };
}

type ToolCallResult = { block: true; reason: string } | undefined;

interface ExtensionApi {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx?: { cwd?: string }) => ToolCallResult): void;
}

const REASON =
  "`.env`-style credential files are blocked from the read/grep tools. These files hold plaintext secrets — don't load one into context unless the user explicitly asked you to inspect that exact file.";

export default function denyEnvReads(pi: ExtensionApi) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read" && event.toolName !== "grep") return;
    const path = event.input?.path;
    if (typeof path !== "string") return;
    if (isEnvPath(path, ctx?.cwd || process.cwd())) return { block: true, reason: REASON };
  });
}

export { isEnvPath };
