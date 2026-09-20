import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const syncSource = readFileSync(resolve(root, "scripts/sync"), "utf8");

type Fixture = {
	dir: string;
	bare: string;
	work: string;
	env: NodeJS.ProcessEnv;
};

/** Isolated bare remote + one clone, with a fixture-local copy of scripts/sync
 * (REPO_ROOT resolves from the script's own location) and a HOME/git config
 * sandbox so the real machine's identity, hooks, and remotes are never touched. */
function makeFixture(): Fixture {
	const scratch = resolve(root, ".agent-msgs/scratch");
	mkdirSync(scratch, { recursive: true });
	const dir = mkdtempSync(resolve(scratch, "sync-test-"));
	const home = resolve(dir, "home");
	mkdirSync(home, { recursive: true });
	writeFileSync(resolve(home, ".gitconfig"), "");
	const bare = resolve(dir, "remote.git");
	const work = resolve(dir, "work");

	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: resolve(home, ".config"),
		GIT_CONFIG_GLOBAL: resolve(home, ".gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};

	run(["git", "init", "--quiet", "--bare", "-b", "main", bare], dir, env);
	run(["git", "clone", "--quiet", bare, work], dir, env);
	run(["git", "config", "--local", "commit.gpgsign", "false"], work, env);
	run(["git", "config", "--local", "tag.gpgsign", "false"], work, env);
	mkdirSync(resolve(work, "docs/ops"), { recursive: true });
	mkdirSync(resolve(work, "scripts"), { recursive: true });
	writeFileSync(resolve(work, "scripts/sync"), syncSource);
	chmodSync(resolve(work, "scripts/sync"), 0o755);
	writeFileSync(resolve(work, "fileA.txt"), "v1\n");
	writeFileSync(resolve(work, "docs/ops/note.md"), "v1\n");
	run(["git", "add", "-A"], work, env);
	run(["git", "commit", "--quiet", "-m", "initial"], work, env);
	run(["git", "push", "--quiet", "-u", "origin", "main"], work, env);

	return { dir, bare, work, env };
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
	const result = spawnSync(args[0], args.slice(1), { cwd, env, input, encoding: "utf8" });
	if (result.error) throw result.error;
	return result;
}

function runSync(fx: Fixture, args: string[] = []) {
	return run([resolve(fx.work, "scripts/sync"), ...args], fx.work, fx.env);
}

function headSha(cwd: string, env: NodeJS.ProcessEnv, ref = "HEAD") {
	return run(["git", "rev-parse", ref], cwd, env).stdout.trim();
}

function cleanup(fx: Fixture) {
	rmSync(fx.dir, { recursive: true, force: true });
}

test("sync commits only staged content, leaves unstaged/untracked/docs-ops untouched", () => {
	const fx = makeFixture();
	try {
		writeFileSync(resolve(fx.work, "fileB.txt"), "v1\n");
		run(["git", "add", "fileB.txt"], fx.work, fx.env);
		run(["git", "commit", "--quiet", "-m", "seed fileB"], fx.work, fx.env);
		run(["git", "push", "--quiet"], fx.work, fx.env);

		writeFileSync(resolve(fx.work, "fileA.txt"), "v2\n");
		run(["git", "add", "fileA.txt"], fx.work, fx.env);
		writeFileSync(resolve(fx.work, "fileA.txt"), "v3\n"); // unstaged edit on top of staged one
		writeFileSync(resolve(fx.work, "fileB.txt"), "unstaged-edit\n");
		writeFileSync(resolve(fx.work, "fileC.txt"), "untracked\n");
		writeFileSync(resolve(fx.work, "docs/ops/note.md"), "unstaged journal edit\n");

		const beforeAhead = headSha(fx.work, fx.env);
		const result = runSync(fx, ["-m", "sync fileA"]);
		expect(result.status).toBe(0);

		const remoteContent = run(
			["git", "show", "origin/main:fileA.txt"],
			fx.work,
			fx.env,
		).stdout;
		expect(remoteContent).toBe("v2\n");
		expect(headSha(fx.work, fx.env)).not.toBe(beforeAhead);
		expect(headSha(fx.work, fx.env)).toBe(headSha(fx.work, fx.env, "origin/main"));

		expect(readFileSync(resolve(fx.work, "fileA.txt"), "utf8")).toBe("v3\n");
		expect(readFileSync(resolve(fx.work, "fileB.txt"), "utf8")).toBe("unstaged-edit\n");
		expect(readFileSync(resolve(fx.work, "fileC.txt"), "utf8")).toBe("untracked\n");
		expect(readFileSync(resolve(fx.work, "docs/ops/note.md"), "utf8")).toBe(
			"unstaged journal edit\n",
		);
		const status = run(["git", "status", "--porcelain"], fx.work, fx.env).stdout;
		expect(status).toContain(" M fileA.txt");
		expect(status).toContain(" M fileB.txt");
		expect(status).toContain(" M docs/ops/note.md");
		expect(status).toContain("?? fileC.txt");
	} finally {
		cleanup(fx);
	}
});

test("staged docs/ops changes block sync without touching HEAD/index/worktree/remote", () => {
	const cases: Array<{ name: string; mutate: (work: string, env: NodeJS.ProcessEnv) => void }> = [
		{
			name: "modified docs/ops file staged",
			mutate: (work) => writeFileSync(resolve(work, "docs/ops/note.md"), "staged journal edit\n"),
		},
		{
			name: "docs/ops file renamed out of docs/ops",
			mutate: (work, env) => {
				run(["git", "mv", "docs/ops/note.md", "note-moved.md"], work, env);
			},
		},
	];
	for (const { mutate } of cases) {
		const fx = makeFixture();
		try {
			mutate(fx.work, fx.env);
			run(["git", "add", "-A"], fx.work, fx.env);
			const headBefore = headSha(fx.work, fx.env);
			const remoteBefore = headSha(fx.work, fx.env, "origin/main");
			const indexBefore = run(["git", "diff", "--cached"], fx.work, fx.env).stdout;

			const result = runSync(fx);
			expect(result.status).not.toBe(0);

			expect(headSha(fx.work, fx.env)).toBe(headBefore);
			expect(headSha(fx.work, fx.env, "origin/main")).toBe(remoteBefore);
			expect(run(["git", "diff", "--cached"], fx.work, fx.env).stdout).toBe(indexBefore);
		} finally {
			cleanup(fx);
		}
	}
});

test("clean behind-only branch fast-forwards via the configured remote (not hard-coded origin)", () => {
	const fx = makeFixture();
	try {
		// Advance the bare remote from a second clone, then rename the local remote.
		const helper = resolve(fx.dir, "helper");
		run(["git", "clone", "--quiet", fx.bare, helper], fx.dir, fx.env);
		writeFileSync(resolve(helper, "fileA.txt"), "from-helper\n");
		run(["git", "add", "fileA.txt"], helper, fx.env);
		run(["git", "commit", "--quiet", "-m", "helper advance"], helper, fx.env);
		run(["git", "push", "--quiet"], helper, fx.env);

		run(["git", "remote", "rename", "origin", "upstream2"], fx.work, fx.env);
		expect(run(["git", "config", "branch.main.remote"], fx.work, fx.env).stdout.trim()).toBe(
			"upstream2",
		);

		const remoteHead = headSha(helper, fx.env);
		const result = runSync(fx);
		expect(result.status).toBe(0);
		expect(headSha(fx.work, fx.env)).toBe(remoteHead);
		expect(readFileSync(resolve(fx.work, "fileA.txt"), "utf8")).toBe("from-helper\n");
	} finally {
		cleanup(fx);
	}
});

test("diverged/conflicting pull refuses to rebase, stash, or auto-resolve", () => {
	const fx = makeFixture();
	try {
		run(["git", "config", "pull.rebase", "true"], fx.work, fx.env);
		run(["git", "config", "merge.autoStash", "true"], fx.work, fx.env);

		const helper = resolve(fx.dir, "helper");
		run(["git", "clone", "--quiet", fx.bare, helper], fx.dir, fx.env);
		writeFileSync(resolve(helper, "fileA.txt"), "remote-diverged\n");
		run(["git", "add", "fileA.txt"], helper, fx.env);
		run(["git", "commit", "--quiet", "-m", "remote diverges"], helper, fx.env);
		run(["git", "push", "--quiet"], helper, fx.env);

		writeFileSync(resolve(fx.work, "fileA.txt"), "local-diverged\n");
		run(["git", "add", "fileA.txt"], fx.work, fx.env);
		run(["git", "commit", "--quiet", "-m", "local diverges"], fx.work, fx.env);

		const headBefore = headSha(fx.work, fx.env);
		const result = runSync(fx);
		expect(result.status).not.toBe(0);
		expect(headSha(fx.work, fx.env)).toBe(headBefore);
		expect(readFileSync(resolve(fx.work, "fileA.txt"), "utf8")).toBe("local-diverged\n");
		// No rebase/stash artifacts left behind.
		expect(run(["git", "stash", "list"], fx.work, fx.env).stdout.trim()).toBe("");
	} finally {
		cleanup(fx);
	}
});

test("empty stage makes no commit; unstaged changes survive; existing ahead commit still pushes", () => {
	const fx = makeFixture();
	try {
		writeFileSync(resolve(fx.work, "fileA.txt"), "ahead-commit\n");
		run(["git", "add", "fileA.txt"], fx.work, fx.env);
		run(["git", "commit", "--quiet", "-m", "unpushed ahead commit"], fx.work, fx.env);
		const aheadSha = headSha(fx.work, fx.env);
		writeFileSync(resolve(fx.work, "fileB.txt"), "just unstaged\n");

		const result = runSync(fx);
		expect(result.status).toBe(0);
		expect(headSha(fx.work, fx.env)).toBe(aheadSha);
		expect(headSha(fx.work, fx.env, "origin/main")).toBe(aheadSha);
		expect(readFileSync(resolve(fx.work, "fileB.txt"), "utf8")).toBe("just unstaged\n");
		expect(run(["git", "status", "--porcelain"], fx.work, fx.env).stdout).toContain("fileB.txt");
	} finally {
		cleanup(fx);
	}
});

test("failing local commit hook blocks commit and push; failing remote hook blocks push only", () => {
	// Case A: local pre-commit hook fails -> no commit, remote unchanged, staged change kept.
	{
		const fx = makeFixture();
		try {
			const hooksDir = resolve(fx.work, ".git/hooks/pre-commit");
			writeFileSync(hooksDir, "#!/bin/sh\nexit 1\n");
			chmodSync(hooksDir, 0o755);
			writeFileSync(resolve(fx.work, "fileA.txt"), "blocked-by-local-hook\n");
			run(["git", "add", "fileA.txt"], fx.work, fx.env);
			const headBefore = headSha(fx.work, fx.env);
			const remoteBefore = headSha(fx.work, fx.env, "origin/main");

			const result = runSync(fx, ["-m", "should fail"]);
			expect(result.status).not.toBe(0);
			expect(headSha(fx.work, fx.env)).toBe(headBefore);
			expect(headSha(fx.work, fx.env, "origin/main")).toBe(remoteBefore);
			expect(run(["git", "diff", "--cached"], fx.work, fx.env).stdout).toContain(
				"blocked-by-local-hook",
			);
		} finally {
			cleanup(fx);
		}
	}

	// Case B: remote pre-receive hook rejects -> local commit persists, push fails.
	{
		const fx = makeFixture();
		try {
			const preReceive = resolve(fx.bare, "hooks/pre-receive");
			writeFileSync(preReceive, "#!/bin/sh\nexit 1\n");
			chmodSync(preReceive, 0o755);
			writeFileSync(resolve(fx.work, "fileA.txt"), "should-be-pushed\n");
			run(["git", "add", "fileA.txt"], fx.work, fx.env);
			writeFileSync(resolve(fx.work, "fileB.txt"), "left unstaged\n");
			const remoteBefore = headSha(fx.work, fx.env, "origin/main");

			const result = runSync(fx, ["-m", "commit ok, push rejected"]);
			expect(result.status).not.toBe(0);
			expect(headSha(fx.work, fx.env)).not.toBe(remoteBefore);
			expect(headSha(fx.work, fx.env, "origin/main")).toBe(remoteBefore);
			expect(readFileSync(resolve(fx.work, "fileB.txt"), "utf8")).toBe("left unstaged\n");
		} finally {
			cleanup(fx);
		}
	}
});

test("missing upstream and unmerged index both exit non-zero without committing or pushing", () => {
	// Case A: branch has no upstream configured.
	{
		const fx = makeFixture();
		try {
			run(["git", "checkout", "--quiet", "-b", "no-upstream"], fx.work, fx.env);
			writeFileSync(resolve(fx.work, "fileA.txt"), "staged-but-no-upstream\n");
			run(["git", "add", "fileA.txt"], fx.work, fx.env);
			const headBefore = headSha(fx.work, fx.env);

			const result = runSync(fx, ["-m", "no upstream"]);
			expect(result.status).not.toBe(0);
			expect(headSha(fx.work, fx.env)).toBe(headBefore);
		} finally {
			cleanup(fx);
		}
	}

	// Case B: unmerged index (simulated merge conflict) at start.
	{
		const fx = makeFixture();
		try {
			run(["git", "checkout", "--quiet", "-b", "feature"], fx.work, fx.env);
			writeFileSync(resolve(fx.work, "fileA.txt"), "feature-side\n");
			run(["git", "add", "fileA.txt"], fx.work, fx.env);
			run(["git", "commit", "--quiet", "-m", "feature change"], fx.work, fx.env);

			run(["git", "checkout", "--quiet", "main"], fx.work, fx.env);
			writeFileSync(resolve(fx.work, "fileA.txt"), "main-side\n");
			run(["git", "add", "fileA.txt"], fx.work, fx.env);
			run(["git", "commit", "--quiet", "-m", "main change"], fx.work, fx.env);

			const mergeResult = run(["git", "merge", "feature"], fx.work, fx.env);
			expect(mergeResult.status).not.toBe(0); // conflict expected
			expect(run(["git", "ls-files", "-u"], fx.work, fx.env).stdout).not.toBe("");
			const headBefore = headSha(fx.work, fx.env);
			const worktreeBefore = readFileSync(resolve(fx.work, "fileA.txt"), "utf8");

			const result = runSync(fx);
			expect(result.status).not.toBe(0);
			expect(headSha(fx.work, fx.env)).toBe(headBefore);
			expect(run(["git", "ls-files", "-u"], fx.work, fx.env).stdout).not.toBe("");
			expect(readFileSync(resolve(fx.work, "fileA.txt"), "utf8")).toBe(worktreeBefore);
		} finally {
			cleanup(fx);
		}
	}
});
