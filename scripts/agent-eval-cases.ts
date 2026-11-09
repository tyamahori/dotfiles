// The five fixed cases and what makes each one pass (docs/agent-eval.md). Every case's revision is
// a hash of this file, so runs graded by different criteria or fixtures are never compared.
// Fixtures are strings rather than files so that the review case's seeded defects stay inert to
// this repository's own analyzers; each run writes them to a fresh workspace.
import { type Assertion, asRow, type CaseId } from "./agent-eval-core.ts";

export type CheckCall = { id: string; module: string; fn: string; args: unknown[] };
// `want` stays in the parent: the process running the agent's code only ever sees the call.
export type Check = CheckCall & { want: unknown };

// One declaration of a final answer gives both the schema handed to the CLI and the check repeated on
// what the CLI wrote, so the two cannot drift. Only the types these five answers use exist here.
export type Shape = { schema: object; accepts(value: unknown): boolean };

export type EvalCase = {
  files: Readonly<Record<string, string>>;
  // Committed on top of `files`: what the review case is asked to review.
  change: Readonly<Record<string, string>>;
  prompts: readonly string[];
  output: Shape;
  // Run against the agent's code once it finishes, from outside the workspace it could edit.
  checks: readonly Check[];
  changes: { required: readonly string[]; allowed: readonly string[] };
  gradeOutput(output: unknown): Assertion[];
};

export type Observed = { output: unknown; changed: readonly string[]; checks: ReadonlyMap<string, boolean> };

const LINE_TOLERANCE = 2;
const LIMIT_BYTES = 3145728;

const source = (...lines: string[]) => `${lines.join("\n")}\n`;

const STRING: Shape = { schema: { type: "string" }, accepts: (value) => typeof value === "string" };
const INTEGER: Shape = { schema: { type: "integer" }, accepts: (value) => Number.isInteger(value) };

const arrayOf = (item: Shape): Shape => ({
  schema: { type: "array", items: item.schema },
  accepts: (value) => Array.isArray(value) && value.every((entry) => item.accepts(entry)),
});

const objectOf = (fields: Record<string, Shape>): Shape => {
  const entries = Object.entries(fields);
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(entries.map(([name, field]) => [name, field.schema])),
      required: Object.keys(fields),
      additionalProperties: false,
    },
    accepts: (value) => {
      const row = asRow(value);
      return (
        Object.keys(row).length === entries.length &&
        entries.every(([name, field]) => Object.hasOwn(row, name) && field.accepts(row[name]))
      );
    },
  };
};

const SUMMARY = objectOf({ summary: STRING });

// The final message has to have its shape but is not graded in the cases with behaviour checks: saying
// "done" earns nothing, and only what the code does counts.
const notGraded = (): Assertion[] => [];

const samePath = (value: unknown, path: string) => typeof value === "string" && value.replace(/^\.\//, "") === path;

function gradeInvestigation(output: unknown): Assertion[] {
  const answer = asRow(output);
  return [
    { id: "defining-file", pass: samePath(answer.definingFile, "src/limits/active.ts") },
    { id: "limit-bytes", pass: answer.limitBytes === LIMIT_BYTES },
  ];
}

const INVESTIGATION: EvalCase = {
  files: {
    "README.md": source("# Upload service", "", "See docs/limits.md for the limits."),
    "docs/limits.md": source("# Limits", "", "Uploads are limited to 10 MiB."),
    "src/upload.ts": source(
      'import { LIMIT_BYTES } from "./limits";',
      "",
      "export function acceptUpload(size: number): boolean {",
      "  return size <= LIMIT_BYTES;",
      "}",
    ),
    "src/limits/index.ts": source('export { ACTIVE_LIMIT_BYTES as LIMIT_BYTES } from "./active";'),
    "src/limits/active.ts": source("export const ACTIVE_LIMIT_BYTES = 3 * 1024 * 1024;"),
    "src/limits/legacy.ts": source("export const LIMIT_BYTES = 10 * 1024 * 1024;"),
  },
  change: {},
  prompts: [
    "Investigate this repository without modifying any file. What byte limit does acceptUpload in src/upload.ts " +
      "actually enforce, and which file defines that number? Answer with the repository-relative path of the " +
      "defining file and the limit in bytes.",
  ],
  output: objectOf({ definingFile: STRING, limitBytes: INTEGER }),
  checks: [],
  changes: { required: [], allowed: [] },
  gradeOutput: gradeInvestigation,
};

const paginateCheck = (id: string, total: number, want: number): Check => ({
  id,
  module: "src/paginate.ts",
  fn: "pageCount",
  args: [total, 10],
  want,
});

const BUG_FIX: EvalCase = {
  files: {
    "src/paginate.ts": source(
      "export function pageCount(total: number, pageSize: number): number {",
      "  return Math.floor(total / pageSize) + 1;",
      "}",
    ),
    "src/report.ts": source(
      'import { pageCount } from "./paginate";',
      "",
      "export function footer(total: number, pageSize: number): string {",
      '  return pageCount(total, pageSize) + " page(s)";',
      "}",
    ),
  },
  change: {},
  prompts: [
    "pageCount in src/paginate.ts is wrong: 20 items at 10 per page reports 3 pages, and an empty list should have " +
      "0 pages. Fix the root cause in src/paginate.ts only. Do not change any other file and do not commit.",
  ],
  output: SUMMARY,
  checks: [
    paginateCheck("empty-list", 0, 0),
    paginateCheck("one-item", 1, 1),
    paginateCheck("exact-page", 10, 1),
    paginateCheck("just-over-a-page", 11, 2),
    paginateCheck("exact-multiple", 20, 2),
    paginateCheck("partial-last-page", 25, 3),
    { id: "report-footer", module: "src/report.ts", fn: "footer", args: [20, 10], want: "2 page(s)" },
  ],
  changes: { required: ["src/paginate.ts"], allowed: ["src/paginate.ts"] },
  gradeOutput: notGraded,
};

const CROSS_FILE_PATHS = ["src/money.ts", "src/cart.ts", "src/invoice.ts", "src/receipt.ts"];

const CROSS_FILE: EvalCase = {
  files: {
    "src/money.ts": source(
      "export function formatPrice(cents: number): string {",
      '  return "USD " + (cents / 100).toFixed(2);',
      "}",
    ),
    "src/cart.ts": source(
      'import { formatPrice } from "./money";',
      "",
      "export function cartTotal(items: number[]): string {",
      "  return formatPrice(items.reduce((sum, cents) => sum + cents, 0));",
      "}",
    ),
    "src/invoice.ts": source(
      'import { formatPrice } from "./money";',
      "",
      "export function invoiceLine(label: string, cents: number): string {",
      '  return label + ": " + formatPrice(cents);',
      "}",
    ),
    "src/receipt.ts": source(
      'import { formatPrice } from "./money";',
      "",
      "export function receiptFooter(cents: number): string {",
      '  return "Paid " + formatPrice(cents);',
      "}",
    ),
  },
  change: {},
  prompts: [
    "Change formatPrice in src/money.ts to take one object argument { cents, currency } and return the currency " +
      "code, a space, and the amount with two decimals, for example EUR 1.50. Update every consumer under src/ so " +
      "that it keeps working. cartTotal and receiptFooter keep their signatures and stay in USD. invoiceLine gains " +
      "a third argument: invoiceLine(label, cents, currency). Do not commit.",
  ],
  output: SUMMARY,
  checks: [
    {
      id: "format-eur",
      module: "src/money.ts",
      fn: "formatPrice",
      args: [{ cents: 150, currency: "EUR" }],
      want: "EUR 1.50",
    },
    {
      id: "format-usd",
      module: "src/money.ts",
      fn: "formatPrice",
      args: [{ cents: 150, currency: "USD" }],
      want: "USD 1.50",
    },
    { id: "cart-usd", module: "src/cart.ts", fn: "cartTotal", args: [[100, 50]], want: "USD 1.50" },
    {
      id: "invoice-eur",
      module: "src/invoice.ts",
      fn: "invoiceLine",
      args: ["Tea", 250, "EUR"],
      want: "Tea: EUR 2.50",
    },
    {
      id: "invoice-usd",
      module: "src/invoice.ts",
      fn: "invoiceLine",
      args: ["Tea", 250, "USD"],
      want: "Tea: USD 2.50",
    },
    { id: "receipt-usd", module: "src/receipt.ts", fn: "receiptFooter", args: [999], want: "Paid USD 9.99" },
  ],
  changes: { required: CROSS_FILE_PATHS, allowed: CROSS_FILE_PATHS },
  gradeOutput: notGraded,
};

const SESSION_REVIEWED = source(
  "export type Session = { userId: string; expiresAtMs: number };",
  "",
  "export function createSession(userId: string, nowMs: number, ttlMs: number): Session {",
  "  return { userId, expiresAtMs: nowMs + ttlMs };",
  "}",
  "",
  "export function isExpired(session: Session, nowMs: number): boolean {",
  "  return nowMs < session.expiresAtMs;",
  "}",
  "",
  "export function remainingMs(session: Session, nowMs: number): number {",
  "  return Math.max(0, session.expiresAtMs - nowMs);",
  "}",
);

const RETRY_LINES = (condition: string) =>
  source(
    "// Calls task at most maxAttempts times and rethrows the last error.",
    "export async function withRetry<T>(task: () => Promise<T>, maxAttempts: number): Promise<T> {",
    "  let lastError: unknown;",
    `  for (let attempt = 0; ${condition}; attempt++) {`,
    "    try {",
    "      return await task();",
    "    } catch (error) {",
    "      lastError = error;",
    "    }",
    "  }",
    "  throw lastError;",
    "}",
    "",
    "export function backoffMs(attempt: number): number {",
    "  return 100 * 2 ** attempt;",
    "}",
  );

const SEARCH_LINES = (statement: string) =>
  source(
    "export type Query = { sql: string; params: string[] };",
    "",
    "export function searchNotes(term: string): Query {",
    `  return ${statement};`,
    "}",
    "",
    "export function countNotes(): Query {",
    '  return { sql: "SELECT COUNT(*) FROM notes", params: [] };',
    "}",
  );

const lineOf = (text: string, needle: string): number => {
  const index = text.split("\n").findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`review fixture has no line containing: ${needle}`);
  return index + 1;
};

const REVIEW_CHANGE = {
  "src/session.ts": SESSION_REVIEWED,
  "src/retry.ts": RETRY_LINES("attempt <= maxAttempts"),
  "src/search.ts": SEARCH_LINES(`{ sql: "SELECT id FROM notes WHERE title = '" + term + "'", params: [] }`),
  // The decoy: a correct rewrite. Flagging it is a false positive like any other finding away from a seed.
  "src/total.ts": source(
    "export function sum(values: number[]): number {",
    "  return values.reduce((total, value) => total + value, 0);",
    "}",
  ),
};

const REVIEW_SEEDS = [
  {
    id: "inverted-expiry",
    file: "src/session.ts",
    line: lineOf(REVIEW_CHANGE["src/session.ts"], "nowMs < session.expiresAtMs"),
  },
  {
    id: "extra-retry",
    file: "src/retry.ts",
    line: lineOf(REVIEW_CHANGE["src/retry.ts"], "attempt <= maxAttempts"),
  },
  {
    id: "sql-from-input",
    file: "src/search.ts",
    line: lineOf(REVIEW_CHANGE["src/search.ts"], "+ term +"),
  },
];

type Seed = (typeof REVIEW_SEEDS)[number];

function hitsSeed(finding: unknown, seed: Seed): boolean {
  const { file, line } = asRow(finding);
  return samePath(file, seed.file) && typeof line === "number" && Math.abs(line - seed.line) <= LINE_TOLERANCE;
}

// Matched by location alone, so the wording of a finding neither helps nor hurts. Several findings
// on one seed are one finding; anything that hits no seed is a false positive.
function gradeReview(output: unknown): Assertion[] {
  const answer = asRow(output).findings;
  const findings: unknown[] = Array.isArray(answer) ? answer : [];
  const falsePositives = findings.filter((finding) => !REVIEW_SEEDS.some((seed) => hitsSeed(finding, seed))).length;
  return [
    ...REVIEW_SEEDS.map((seed) => ({
      id: `seed:${seed.id}`,
      pass: findings.some((finding) => hitsSeed(finding, seed)),
    })),
    { id: "false-positives", pass: falsePositives === 0, count: falsePositives },
  ];
}

const REVIEW: EvalCase = {
  files: {
    "src/session.ts": SESSION_REVIEWED.replace("nowMs < session.expiresAtMs", "nowMs >= session.expiresAtMs"),
    "src/retry.ts": RETRY_LINES("attempt < maxAttempts"),
    "src/search.ts": SEARCH_LINES('{ sql: "SELECT id FROM notes WHERE title = ?", params: [term] }'),
    "src/total.ts": source(
      "export function sum(values: number[]): number {",
      "  let total = 0;",
      "  for (const value of values) total += value;",
      "  return total;",
      "}",
    ),
  },
  change: REVIEW_CHANGE,
  prompts: [
    "Review the most recent commit in this repository (git show HEAD). Report only defects that this commit " +
      "introduces and that make the code behave wrongly or unsafely, not style. Give each finding as the " +
      "repository-relative file, the line number in the current version of that file, and a short summary. Report " +
      "nothing for code that is correct. Do not modify any file and do not commit.",
  ],
  output: objectOf({ findings: arrayOf(objectOf({ file: STRING, line: INTEGER, summary: STRING })) }),
  checks: [],
  changes: { required: [], allowed: [] },
  gradeOutput: gradeReview,
};

const CONTINUATION: EvalCase = {
  files: {
    "CHANGELOG.md": source("# Changelog"),
    "src/tags.ts": source("export function normalizeTag(tag: string): string {", "  return tag.toLowerCase();", "}"),
  },
  change: {},
  prompts: [
    "Add src/slug.ts exporting slugify(title: string): string. It trims surrounding whitespace, lowercases the " +
      "text, and joins the words with a hyphen. Also add a line about it to CHANGELOG.md. Do not commit.",
    "Correction to your previous work: slugify must join the words with an underscore, not a hyphen. CHANGELOG.md " +
      "must be exactly what the last commit has, so undo your edit there. Everything else you were asked for still " +
      "applies. Do not commit.",
  ],
  output: SUMMARY,
  checks: [
    {
      id: "corrected-separator",
      module: "src/slug.ts",
      fn: "slugify",
      args: ["  Hello Big World "],
      want: "hello_big_world",
    },
    { id: "single-word", module: "src/slug.ts", fn: "slugify", args: ["One"], want: "one" },
    { id: "existing-code-intact", module: "src/tags.ts", fn: "normalizeTag", args: ["AbC"], want: "abc" },
  ],
  changes: { required: ["src/slug.ts"], allowed: ["src/slug.ts"] },
  gradeOutput: notGraded,
};

export const CASES: Readonly<Record<CaseId, EvalCase>> = {
  investigation: INVESTIGATION,
  "bug-fix": BUG_FIX,
  "cross-file": CROSS_FILE,
  review: REVIEW,
  continuation: CONTINUATION,
};

export function expectedTree(evalCase: EvalCase): Map<string, string> {
  return new Map(Object.entries({ ...evalCase.files, ...evalCase.change }));
}

export function grade(evalCase: EvalCase, observed: Observed): Assertion[] {
  const missing = evalCase.changes.required.filter((path) => !observed.changed.includes(path));
  const unexpected = observed.changed.filter((path) => !evalCase.changes.allowed.includes(path));
  return [
    ...evalCase.gradeOutput(observed.output),
    ...evalCase.checks.map((check) => ({ id: `behaviour:${check.id}`, pass: observed.checks.get(check.id) === true })),
    { id: "required-changes", pass: missing.length === 0, count: missing.length },
    { id: "no-unexpected-changes", pass: unexpected.length === 0, count: unexpected.length },
  ];
}
