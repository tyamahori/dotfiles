import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { resolve } from "node:path";
import { denyCommand } from "./command-policy";

let which: Mock<typeof Bun.which>;
beforeEach(() => { which = spyOn(Bun, "which"); });
afterEach(() => which.mockRestore());

test("denies executable positions, not quoted prose or script arguments", () => {
  which.mockReturnValue("/available/uv");
  expect(denyCommand("MODE='two words' command python3 app.py", "claude")).toBeDefined();
  expect(denyCommand("echo done && python -c 'print(1)'", "codex")).toBeDefined();
  expect(denyCommand("printf '%s' 'example; python3 script.py | grep text'", "omp")).toBeUndefined();
  expect(denyCommand("sh -c 'python3 script.py'", "claude")).toBeUndefined();
  expect(denyCommand("uv run python3 script.py", "codex")).toBeUndefined();
  expect(denyCommand("echo done # python3 script.py", "omp")).toBeUndefined();
});

test("heredoc data is ignored but its opening command remains enforceable", () => {
  which.mockReturnValue("/available/uv");
  expect(denyCommand("cat <<'EOF' > out\npython3 script.py\ngrep text\nEOF", "claude")).toBeUndefined();
  expect(denyCommand("python3 <<'EOF'\nprint(1)\nEOF", "omp")).toBeDefined();
  expect(denyCommand("cat <<-EOF\n\tpython3 script.py\n\tEOF\npython app.py", "codex")).toBeDefined();
  expect(denyCommand("echo '<<EOF'\npython app.py", "omp")).toBeDefined();
});

test("Python pipelines are denied while read filters and write-mode cat stay allowed", () => {
  which.mockReturnValue("/available/uv");
  expect(denyCommand("printf data | python3 -c 'print(input())'", "omp")).toBeDefined();
  expect(denyCommand("git log | grep fix | head -n 5", "claude")).toBeUndefined();
  expect(denyCommand("git log |\n grep fix", "omp")).toBeUndefined();
  expect(denyCommand("cat > out", "omp")).toBeUndefined();
  expect(denyCommand("cat file", "omp")).toBeDefined();
  expect(denyCommand("sed -n '1,5p' file", "claude")).toBeDefined();
  expect(denyCommand("grep value file", "codex")).toBeUndefined();
  expect(denyCommand("grep value file", "claude")).toContain("Grep");
  expect(denyCommand("grep value file", "omp")).toContain("glob");
});

test("replacement availability is checked on each invocation", () => {
  for (const command of ["python3 app.py", "curl https://example.com/", "brew upgrade"]) {
    which.mockReturnValue(null);
    expect(denyCommand(command, "omp")).toBeUndefined();
    which.mockReturnValue("/available/replacement");
    expect(denyCommand(command, "omp")).toBeDefined();
  }
  const wrapper = resolve(import.meta.dir, "brewUpdate");
  which.mockImplementation((command) => command === wrapper ? wrapper : null);
  expect(denyCommand("brew upgrade", "omp")).toBeDefined();
});

test("only simple webpage GETs are redirected to ax", () => {
  which.mockReturnValue("/available/ax");
  expect(denyCommand("curl -fsSL https://example.com/docs/", "codex")).toBeDefined();
  expect(denyCommand("curl https://example.com/index.html", "claude")).toBeDefined();
  for (const command of [
    "curl -H 'Authorization: Bearer secret' https://example.com/",
    "curl https://user:secret@example.com/",
    "curl -X POST -d '{}' https://example.com/",
    "curl https://api.example.com/users",
    "curl https://example.com/v1/users",
    "curl 'https://example.com/?token=secret'",
    "curl -o page.html https://example.com/",
    "curl https://example.com/archive.tar.gz",
    "curl https://example.com/page.json",
    "curl -I https://example.com/",
    "curl -v https://example.com/",
    "curl --retry 3 https://example.com/",
    "curl https://localhost/health",
    "curl https://example.com/ > page.html",
  ]) expect(denyCommand(command, "omp")).toBeUndefined();
});

test("brew matches the exact upgrade subcommand, not argument text", () => {
  which.mockReturnValue("/available/brewUpdate");
  expect(denyCommand("brew upgrade --cask", "codex")).toBeDefined();
  expect(denyCommand("command brew upgrade omp", "claude")).toBeDefined();
  for (const command of ["brew update", "brew uses upgrade", "brew upgrades", "brew info upgrade", "echo 'brew upgrade'"]) {
    expect(denyCommand(command, "omp")).toBeUndefined();
  }
});

test("gh pr create is denied unless it opens a draft", () => {
  which.mockReturnValue("/available/gh");
  expect(denyCommand("gh pr create --title t --body b", "claude")).toContain("--draft");
  expect(denyCommand("git push -u origin x && gh pr create --fill", "omp")).toBeDefined();
  for (const command of ["gh pr create --draft --fill", "gh pr create -d --title t", "gh pr view 3", "gh pr ready 3", "echo 'gh pr create'"]) {
    expect(denyCommand(command, "codex")).toBeUndefined();
  }
});

test(".env-style credential files are blocked across cat/head/tail/tee, not near-miss names", () => {
  which.mockReturnValue("/available/replacement");
  expect(denyCommand("cat ~/.config/jev/credentials.env", "claude")).toBeDefined();
  expect(denyCommand("head -n 1 credentials.env", "codex")).toBeDefined();
  expect(denyCommand("tail -f .env", "omp")).toBeDefined();
  expect(denyCommand("less .env.local", "claude")).toBeDefined();
  expect(denyCommand("strings ~/.config/jev/credentials.env", "codex")).toBeDefined();
  expect(denyCommand("cat credentials.env > /tmp/copy", "omp")).toBeDefined();
  expect(denyCommand("printf x | tee .env", "claude")).toBeDefined();
  expect(denyCommand("cat config.env.example", "codex")).toBeUndefined();
  expect(denyCommand("cat notes.environment", "codex")).toBeUndefined();
  expect(denyCommand("cat README.md", "codex")).toBeUndefined();
});

test("grep/awk on .env stay outside this rule; the pattern argument would false-positive", () => {
  which.mockReturnValue("/available/replacement");
  expect(denyCommand("grep KEY .env", "codex")).toBeUndefined();
  expect(denyCommand("awk '{print}' .env", "codex")).toBeUndefined();
});

test("sleeps of 10s or more are denied as polling; short readiness sleeps stay allowed", () => {
  for (const command of ["sleep 60; gh pr checks 612", "unset GH_TOKEN; sleep 45 && gh run list", "sleep 10", "sleep 1m", "sleep 12.5s"]) {
    expect(denyCommand(command, "omp")).toBeDefined();
  }
  expect(denyCommand("sleep 30", "codex")).toContain("--watch");
  for (const command of ["sleep 2 && curl -sf http://localhost:3000/health", "sleep 9", "sleep 0.5", "echo 'sleep 60'"]) {
    expect(denyCommand(command, "claude")).toBeUndefined();
  }
});

test("global installs are denied; project-local installs and owner scripts stay allowed", () => {
  for (const command of ["brew install pict", "npm i -g typescript", "pnpm add --global x", "pip install requests", "go install golang.org/x/tools/gopls@latest", "uv tool install ruff", "cargo install ripgrep"]) {
    expect(denyCommand(command, "codex")).toBeDefined();
  }
  for (const command of ["npm install", "pnpm add zod", "uv add httpx", "go get ./...", "brew bundle --file ~/.Brewfile", "uv pip install -e .", "brew info pict"]) {
    expect(denyCommand(command, "omp")).toBeUndefined();
  }
});

test("sweeping git stages are denied; explicit paths are not", () => {
  for (const command of ["git add -A", "git add .", "git add -u", "git commit -am 'msg'", "git commit --all -m x"]) {
    expect(denyCommand(command, "claude")).toBeDefined();
  }
  for (const command of ["git add src/a.ts docs/b.md", "git add -p src/a.ts", "git commit -m 'add -A flag docs'", "git commit --amend --no-edit"]) {
    expect(denyCommand(command, "claude")).toBeUndefined();
  }
});

test("remote pulls require effective fast-forward-only", () => {
  for (const command of ["git pull", "git pull --rebase", "git pull origin main", "git -C repo pull", "git -c pull.ff=false pull"]) {
    expect(denyCommand(command, "claude")).toBeDefined();
  }
  for (const command of ["git pull --ff-only", "git pull origin main --ff-only", "git -C repo pull --ff-only", "git -c pull.ff=only pull --ff-only"]) {
    expect(denyCommand(command, "claude")).toBeUndefined();
  }
  for (const command of ["git pull --ff-only --no-ff", "git pull --no-ff --ff-only", "git pull --ff-only --ff", "git -C repo pull --ff=false --ff-only"]) {
    expect(denyCommand(command, "claude")).toBeDefined();
  }
});

test("raw git worktree add is denied for OMP only inside Herdr", () => {
  which.mockReturnValue("/available/herdr");
  const saved = process.env.HERDR_ENV;
  try {
    process.env.HERDR_ENV = "1";
    expect(denyCommand("git worktree add ../repo-pr1 -b feat/x origin/main", "omp")).toContain("herdr worktree create");
    for (const command of ["git worktree list", "git worktree remove ../repo-pr1", "git add src/worktree.ts"]) {
      expect(denyCommand(command, "omp")).toBeUndefined();
    }
    expect(denyCommand("git worktree add ../x", "claude")).toBeUndefined();
    which.mockReturnValue(null);
    expect(denyCommand("git worktree add ../x", "omp")).toBeUndefined();
    which.mockReturnValue("/available/herdr");
    delete process.env.HERDR_ENV;
    expect(denyCommand("git worktree add ../x", "omp")).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = saved;
  }
});

test("in-place shell edits are denied for clients with an edit tool", () => {
  for (const command of ["sed -i '' 's/a/b/' f", "sed -Ei 's/a/b/' f", "gsed --in-place 's/a/b/' f", "perl -pi -e 's/a/b/' f", "perl -i.bak -pe 1 f"]) {
    expect(denyCommand(command, "omp")).toBeDefined();
  }
  for (const command of ["sed 's/a/b/' f > g", "printf x | sed 's/-i/x/'", "perl -Ilib script.pl"]) {
    expect(denyCommand(command, "omp")).toBeUndefined();
  }
  expect(denyCommand("sed -i 's/a/b/' f", "codex")).toBeUndefined();
});

test("agents may not launch hunk's watch session", () => {
  expect(denyCommand("hunk diff --watch", "omp")).toBeDefined();
  expect(denyCommand("hunk session list", "omp")).toBeUndefined();
});
