# Official source entry points

Use these entry points for a model-migration review.
The table is an index, not a summary of the pages.
Each URL was reached with `/usr/bin/curl -sIL -o /dev/null -w '%{http_code} %{url_effective}\n' <URL>` on 2026-09-05; the final response was HTTP 200.

| Provider | What it covers | URL | Checked |
| --- | --- | --- | --- |
| Anthropic | Claude model list | https://platform.claude.com/docs/en/models/overview | 2026-09-05 |
| Anthropic | Per-model migration guide, what's new, and prompting guide (replace `<model>` with the slug from the model list, e.g. `fable-5-1`) | https://platform.claude.com/docs/en/models/<model>/migration-guide, https://platform.claude.com/docs/en/models/<model>/whats-new-<model>, https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-<model> | 2026-09-05 |
| Anthropic | Claude model migration and deprecations | https://platform.claude.com/docs/en/about-claude/model-deprecations | 2026-09-05 |
| Anthropic | Prompt-engineering overview | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview | 2026-09-05 |
| Anthropic | Claude Code changelog | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md | 2026-09-05 |
| OpenAI | Model page (replace `<model>` with the API id, e.g. `gpt-6-astra`) | https://developers.openai.com/api/docs/models/<model>.md | 2026-09-05 |
| OpenAI | Latest-model migration and prompting guide | https://developers.openai.com/api/docs/guides/latest-model.md | 2026-09-05 |
| OpenAI | Reasoning effort guidance | https://developers.openai.com/api/docs/guides/reasoning.md | 2026-09-05 |
| OpenAI | Codex documentation | https://developers.openai.com/codex | 2026-09-05 |
| OpenAI | Codex CLI changelog | https://learn.chatgpt.com/docs/changelog?type=codex-cli | 2026-09-05 |
| OpenAI | Codex configuration reference | https://developers.openai.com/codex/config-reference | 2026-09-05 |
| OpenAI | Model list | https://developers.openai.com/api/docs/models | 2026-09-05 |
| OMP | Release notes | https://github.com/can1357/oh-my-pi/releases | 2026-09-05 |
