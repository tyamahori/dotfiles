---
name: claude-artifacts-ops
description: OMPからClaude Code経由でClaude Artifacts(claude.ai)を作成・取得させたいときに使う。経路（Herdr上の対話Claude Code）・事前確認・承認区分・Artifact指定方法・受け渡し形式・失敗時の扱いを定義する。
---

## 経路

Artifactの公開はClaude Code組み込みの `Artifact` ツールで行う（公式: https://code.claude.com/docs/en/artifacts ）。ブラウザ操作（`claude-in-chrome`等）は使わない。

`Artifact` ツールは `claude -p`・Agent SDK・MCPサーバー文脈では既定で無効になる。そのため `claude -p` は使えない。OMPは `omp-herdr-collab` の spawn/send で**対話セッションのClaude Code**を起動して依頼する。`claude -p` で「Artifactツールが無い」と確認しても、利用不可の証拠にはならない。

## 事前確認

依頼の前にOMP側で確かめ、満たさなければ依頼せずにユーザーへ報告する。

1. `claude auth status` が `authMethod: claude.ai` で、`subscriptionType` が pro/max/team/enterprise であること。APIキー・gateway・Bedrock/Vertex/Foundry では公開できない。
2. 環境変数 `CLAUDE_CODE_DISABLE_ARTIFACT`・`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` が未設定で、Claudeの設定に `enableArtifact: false` も `permissions.deny` の `Artifact` も無いこと。
3. `HERDR_ENV=1` であること（spawn/send の前提）。

briefingの最初の手順で、ペイン側のClaudeにも `Artifact` ツールの有無を確かめさせる。無ければローカルHTMLで代用させず、`status: unavailable` と理由を書かせる。

## 手順

```bash
S=~/.agents/skills/omp-herdr-collab/scripts
F=artifact-<name>                       # flow名。.agent-msgs/$F/ が台帳
mkdir -p .agent-msgs/$F/artifacts
# briefing を .agent-msgs/$F/briefing.md に書く（下の受け渡し形式）
$S/spawn.sh claude <repo>-claude-artifact          # stdout: name=... pane=...
$S/send.sh --to <repo>-claude-artifact --from <repo>-omp --tag handoff --flow $F --body - <<EOF
[HANDOFF] <タスク名>
briefing: <briefing の絶対パス>
coordinator: <repo>-omp
ledger-directory: <.agent-msgs/$F の絶対パス>
return-mode: artifact-import
return-directory: <.agent-msgs/$F/artifacts の絶対パス>
期待する成果物: Artifact URL を書いた return file
EOF
herdr agent wait <repo>-claude-artifact
# return file を読み、内容を確認してから台帳へ取り込む
$S/send.sh --record-only --from <repo>-claude-artifact --to <repo>-omp --tag fyi --flow $F --body <return file>
$S/despawn.sh <pane>
```

1依頼につき1ペインとする。新規ペインは新しい会話なので、既存Artifactを誤って更新しない。

## 操作範囲

| 操作 | 既定 |
|---|---|
| 既存Artifactの内容取得 | 既定で許可 |
| 新規Artifactの作成(非公開・自分のアカウント内) | 既定で許可 |
| 既存Artifactの上書き更新 | 都度承認必須 |
| 公開・共有リンクの発行 | 都度承認必須 |

共有・公開はClaude Codeではなく、ユーザーがページ上部の Share から行う。公開中のArtifactは編集・上書きしない。試作は新規Artifactとして作成する。

## Artifactの指定方法

- 既存Artifactは URL（`https://claude.ai/artifact/<id>`）で明示する。「直前の」のような曖昧な指定は認めない。
- タイトルはHTMLの `<title>` が優先され、依頼文で指定したタイトルは使われない（2026-10-17 実測）。タイトルを指定したいときは、公開前にHTMLの `<title>` を直しておく。

## 受け渡し形式

- 公開するHTMLは `.agent-msgs/scratch/artifacts/<name>.html` に置く。CSSとJSはインラインにし、画像は data URI にする。外部から読み込めるのは Google Fonts と許可された CDN だけ。
- briefingでは、新規・非公開で公開すること、ファイルを編集しないこと、共有しないことを指示する。return file の本文は次の形式に固定する。

```
[FYI] artifact publish result
status: published | unavailable | failed
url: <https://claude.ai/artifact/... or none>
source: <公開したファイルのパス>
diff: <ファイルへの変更、または none>
reason: <公開できなかったときだけ>
返信不要
```

## 失敗時の扱い

Artifactが見つからない、内容を取得できない、公開に失敗した、といった場合は「推測で埋めない」を `omp-herdr-collab` の trust boundary と同じ強さで守る。URLが return file に無ければ、`herdr agent read <name>` で `Artifact(...)` の結果行を確かめる。それでも無ければ未公開としてユーザーへ報告する。

## UI方針との関係

このskillはArtifact操作の手続きだけを定める。HTMLの見た目は global instructions の「Skills to load first」節に従う（読み物は素のHTML+CSSで書き、部品ライブラリを使わない。frontend-design・ja-html-typography・nondesigner-design が正本）。
