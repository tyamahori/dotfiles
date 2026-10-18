import { expect, test } from "bun:test";
import { join } from "node:path";

const extension = join(import.meta.dir, "../extensions/notify.ts");

// The platform check runs when the module loads, so the override has to
// precede a dynamic import inside a child process.
test("registers its handlers on Linux, where delivery goes through notify-send", () => {
  const driver = `
    Object.defineProperty(process, "platform", { value: "linux" });
    const { default: install } = await import(${JSON.stringify(extension)});
    const events = [];
    install({ on: (event) => events.push(event) });
    console.log(JSON.stringify(events));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", driver]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual(
    expect.arrayContaining(["agent_end", "tool_approval_requested"]),
  );
});
