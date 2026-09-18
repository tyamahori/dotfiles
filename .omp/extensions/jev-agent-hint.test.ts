import { expect, test } from "bun:test";
import { extractAgentRoster } from "./jev-agent-hint.ts";

const SAMPLE_TASK_DESCRIPTION = `Delegate work to background subagents.

# Available Agents
Pick the most specific agent.
### scout (READ-ONLY)
MUST be used for exploratory codebase research, rapid code analysis, and
broad pattern searches. Fast read-only scout returning compressed context.

### reviewer
Code review specialist for quality/security analysis
### security-reviewer
Read-only security specialist for evidence-backed repository vulnerability discovery
### task
General-purpose subagent with full capabilities for delegated multi-step tasks
### sonic
Low-reasoning agent for strictly mechanical updates or data collection only`;

test("extractAgentRoster pulls every ### heading and trims its description", () => {
	const roster = extractAgentRoster(SAMPLE_TASK_DESCRIPTION);
	expect(Object.keys(roster)).toEqual(["scout", "reviewer", "security-reviewer", "task", "sonic"]);
	expect(roster.scout).toContain("MUST be used for exploratory codebase research");
	expect(roster.scout).not.toContain("\n");
	expect(roster.sonic).toBe("Low-reasoning agent for strictly mechanical updates or data collection only");
});

test("extractAgentRoster returns an empty roster when no ### headings are present", () => {
	expect(extractAgentRoster("just a plain description with no headings")).toEqual({});
});
