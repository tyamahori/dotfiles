// Slack messages posted or updated on the user's behalf must end with this
// exact notice (agents/global-instructions.md "Machine facts"). Shared by the
// Claude/Codex PreToolUse hook and the OMP extension for Slack MCP write
// tools. ponytail: shell posts (`slack api chat.*`, curl) are not parsed;
// add a command check if agents start posting that way.
export const SLACK_NOTICE = "[自動投稿です。玉堀の秘書システムによるものです。]";

// Posting tools only. Drafts land in the user's composer and are sent by the
// user, so they are not "posted on my behalf".
const WRITE_TOOL = /slack.*(?:send_message|schedule_message|post_message|update_message|chat_?(?:post|update))(?!_draft)/i;
const BODY_FIELDS = ["message", "text", "markdown_text", "body", "content"];

export const SLACK_NOTICE_REASON =
  `Slack posts made on the user's behalf must end exactly with ${SLACK_NOTICE} (no trailing text or whitespace). Append it to the message body and retry.`;

/** Denial reason when a Slack write tool call lacks the closing notice. */
export function slackNoticeViolation(toolName: string, input: unknown): string | undefined {
  if (!WRITE_TOOL.test(toolName) || /draft/i.test(toolName)) return;
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const bodies = BODY_FIELDS.map((key) => fields[key]).filter((value): value is string => typeof value === "string");
  // ponytail: a body in an unknown field (or blocks-only) is denied, not guessed at.
  if (bodies.length === 0 || bodies.some((body) => !body.endsWith(SLACK_NOTICE))) return SLACK_NOTICE_REASON;
}
