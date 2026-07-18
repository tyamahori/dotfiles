---
name: efficient-python
description: Token-efficient Python usage for coding agents on this machine — uv invocation forms (uv run / --with / uvx / PEP 723 scripts), when to prefer jq/shell/ax over Python and vice versa, one-shot style rules, and default libraries for throwaway scripts. Load BEFORE writing or running any Python: one-off analysis, inline heredocs, helper scripts, or scripts committed to repos and skills.
---

# efficient-python

Goal: every Python invocation runs correctly on the first try with the fewest
tokens. These rules come from an audit of real session logs (2026-07,
re-runnable via `~/dotfiles/scripts/audit-python-usage`); the waste there was
bare-python denials, missing-module retries, and re-running failed commands
unchanged — not slow code.

## Invocation: always uv

The global interpreter is uv-managed and intentionally bare. A PreToolUse hook
denies bare `python` / `python3`; a denial means switch to the uv form below,
never retry.

| Situation | Form |
| --- | --- |
| stdlib one-off | `uv run - <<'PY'` … `PY` or `uv run script.py` |
| needs third-party libs | `uv run --with pkg1 --with pkg2 - <<'PY'` … `PY` |
| Python CLI tool (ruff, yt-dlp, …) | `uvx <tool>` — never install it |
| reusable script kept in a repo or skill | PEP 723 header + uv shebang (below) |
| different Python version | `uv run --python 3.13 …` (auto-installs the interpreter) |
| project with `pyproject.toml` / `uv.lock` | `uv sync` (else `uv venv` + `uv pip install`), then `uv run <cmd>` |

Any script that will be called again later — committed to a repo, embedded in
a skill, referenced from docs — must be self-contained via PEP 723 inline
metadata, so every future caller gets the interpreter and deps in one shot:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
```

`chmod +x` and invoke as `./script.py` (or `uv run script.py`). Never write
`python3 script.py` into a skill, doc, or wrapper script: every future agent
call of it burns a deny round-trip. This was the single largest waste source
in the audit (~400 calls from one skill).

If `uv` itself is not on PATH (stripped-PATH shells, worktree hooks), restore
the devbox env with `eval "$(/usr/local/bin/devbox global shellenv)"` — uv is
installed via devbox global, not in `~/.local/bin` (that holds only the python
shims). Do not fall back to bare python.

## Dependencies: --with in the first invocation

- If a third-party lib makes the task cleaner, add `--with` from the start.
  A missing package is never a reason to downgrade to a stdlib workaround
  (unless the user asked for dependency-free) — `--with` is cheap, isolated,
  and needs no cleanup.
- Never import a third-party package in a heredoc without `--with`: the
  global interpreter has nothing installed, so it's a guaranteed
  `ModuleNotFoundError` → rewrite → rerun cycle.
- Don't `pip install` into the global interpreter, and don't hard-code
  `/usr/bin/python3`, Homebrew, pyenv, or nix interpreters.

## Tool choice: cheapest tool that finishes in one step

- JSON/JSONL field extraction, counting, filtering → `jq`.
- Text search → `rg` / `grep`. Web fetch/scrape → `ax` (see the ax section of
  the global instructions).
- Switch to Python as soon as the shell version needs more than ~2 pipe
  stages of sed/awk, any state across lines, or arithmetic over records. One
  Python heredoc beats a shell-fumbling retry loop — don't keep patching a
  fragile pipeline.
- Don't pipe shell output into an inline parser
  (`cmd | uv run - <<'PY' … json.load(sys.stdin)`) unless upstream output is
  guaranteed JSON. Otherwise do the whole job in Python (read the file, or
  `subprocess.run`) so a failure is one debuggable step, not a broken pipe
  with two suspects.

## Style: written once, runs once

Inline scripts are write-once code; optimize for first-run success per token.

- `pathlib.Path` for all path/file work: `Path(p).read_text()`,
  `Path(d).glob("*.jsonl")`, `/` joins — not `os.path` + `open()` loops.
- f-strings, comprehensions, `json.loads(Path(p).read_text())`.
- To inspect data, print the whole structure once (`print(repr(x)[:2000])`)
  and read it — not a print-tweak-rerun cycle.
- On failure: read the traceback, change the code or the approach. Never
  re-issue a failing command unchanged (the audit found the same failing
  script re-run up to 6×). Two failures of one approach → different approach.

## Default libraries for throwaway work

| Task | Reach for | Not |
| --- | --- | --- |
| HTTP beyond a trivial GET | `--with httpx` | urllib boilerplate, requests |
| CSV / tables / stats | `--with pandas` (huge data: `--with polars`) | manual csv loops |
| HTML parsing in code | `--with beautifulsoup4 --with lxml`; plain extraction → `ax` CLI instead | regex over HTML |
| YAML | `--with pyyaml` | hand parsing |
| Images | `--with pillow` | |

stdlib `json`, `re`, `collections`, `itertools`, `urllib` (single simple GET)
stay the right tool for small jobs — the table applies once the task outgrows
them.
