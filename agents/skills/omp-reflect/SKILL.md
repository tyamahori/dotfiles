---
name: omp-reflect
description: 「振り返って」「リフレクトして」「reflectして」と言われたときに使う。直前のセッションのtranscriptを judgment/tooling/divergent の3視点を持つread-only subagentで並列にマイニングし、synthesizerで恒久的な学びだけに仕分けてから、承認された項目だけをlearn/manage_skillでmemoryに記録する。authored skillへの反映そのものはomp-learning-loopに委ねる。
---

# OMP Reflect

セッションのtranscriptを複数視点で振り返り、恒久的な学びの候補を`learn`/`manage_skill`経由でmemoryに書き込む、というのがこのskillの仕事である。authored skillには触れない。昇格の判断は`omp-learning-loop`に委ねる。あちらはリポジトリの証拠と突き合わせたうえで、より確度の高い格上げを別途行う。今の運用は、作業中のエージェントが思いついたことだけを単発で`learn`する形に留まっており、セッション全体を独立した複数視点で事後的に掘り返す工程が欠けていた。

## いつ使うか

ユーザーが「振り返って」「reflectして」と言ったときに起動する。雑談や、既存skillの手順どおりに済んだだけのセッションではスキップする。単発の出来事は学びではない。

## 1. 自分のtranscriptを特定する

`hub op:"list"` で現在のセッションのidを確認する（トップレベルなら通常 `Main`）。このskill自身がサブエージェントとして起動されている場合は自分自身のidを使う。他セッションのtranscriptは読まない — プライバシー境界を越える。

`history://<id>` を読む。セッションが短すぎて実質的な内容がない場合は、ここで終了してその旨を報告する。

## 2. 3つの視点でread-onlyレビューを並列起動

`task` tool で1回の呼び出しに3件の `tasks[]` を積み、それぞれ `agent: "scout"` で並列実行する（読み取り専用、ファイル変更なし）。各taskには下記テンプレートをそのまま渡し、`<TRANSCRIPT>` をstep 1で読んだtranscript本文に差し替える。

| レンズ | テンプレート |
|---|---|
| Judgment | [references/judgment-reviewer.md](references/judgment-reviewer.md) |
| Tooling | [references/tooling-reviewer.md](references/tooling-reviewer.md) |
| Divergent | [references/divergent-reviewer.md](references/divergent-reviewer.md) |

`task`の`context`には「同じtranscriptを別の視点で読む3人のreviewer、成果は後段のsynthesizerが統合する」とだけ書き、3件の間で指摘を調整させない。独立した指摘であることが、後段の収束判定（2人以上が同じ指摘に至ったか）の材料になる。

## 3. Synthesizerで仕分け

`task` tool で1件、`agent: "scout"` を起動する。[references/synthesizer.md](references/synthesizer.md) をそのまま渡し、3人のreviewer出力を該当箇所へ埋め込む。Accepted / Rejected / Backlog の表が返る。

## 4. 機械的強制チェック

Synthesizerが返したAccepted表を確認する。lintルール、script、metadata flag、runtime checkで機械的に代替できる項目はBacklogへ移す。skill文として書くのは機械が強制できないものだけに絞る。

## 5. ユーザー承認

Accepted / Rejected / Backlog をそのままユーザーに提示し、承認を待つ。ユーザーはAccepted行を1件ずつ採否し、routingを修正してよい。承認前にmemoryへ何も書かない。

## 6. 承認された項目を記録する

Accepted行ごとに、routingに応じて`learn`（必要なら`skill`引数でmanaged skillを同時に作成・更新）を呼ぶ。ここではauthored skillやinstructionsファイルを直接編集しない — 反映は次回の`omp-learning-loop`実行に委ねる。

| Routing | 記録方法 |
|---|---|
| 既存skillへの本文追加・修正 | `learn`のmemoryに該当skillパスと変更点の要点を明記 |
| `tune description: <skill path>` | `learn`のmemoryに「このskillが発火すべきだった場面」と「descriptionへの追記案」を明記 |
| `new skill via create-skill: <name>` | `learn`の`skill`引数で`action:"create"`のmanaged skill草案を作成 |

Backlog項目はファイルせず、要約としてユーザーに報告するだけにとどめる（このマシンには自動連携するdevexトラッカーがない）。

## 7. まとめて報告

- memoryに記録した項目: 何を、どこへ
- 作成・更新したmanaged skill: 一覧
- Backlog: 一覧と提案する機構
- Rejected: 理由付きで一覧
