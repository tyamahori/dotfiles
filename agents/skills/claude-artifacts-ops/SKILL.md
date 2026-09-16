---
name: claude-artifacts-ops
description: OMPからClaude Code経由でClaude Artifacts(claude.ai)を操作・作成させたいときに使う。認証前提・操作範囲の承認区分・Artifact指定方法・受け渡し形式・失敗時の扱いのルールを定義する。
---

## 前提

- 経路はブラウザ操作を使わない。Claude API/SDK、すなわちClaude Codeを通常利用しているときと同じ操作感を想定する。`claude-in-chrome`等のブラウザ拡張経由は採用しない。
- 認証（APIキー/SDK呼び出し）はClaude Code側で事前設定済みとして扱う。依頼ごとの同意ステップは不要。
- 呼び出し失敗（認証エラー、レート制限等）はOMPが待たずに即ユーザーへ報告する。

## 操作範囲

| 操作 | 既定 |
|---|---|
| 既存Artifactの内容取得 | 既定で許可 |
| 新規Artifactの作成(未公開・自分のアカウント内) | 既定で許可 |
| 既存Artifactの上書き更新 | 都度承認必須 |
| 公開・共有リンクの発行 | 都度承認必須 |

公開中のArtifactは編集・上書きしない。試作は別成果物として新規作成する。

## Artifactの指定方法

- 既存Artifactを対象にする場合は公開URL(`/artifact/<id>`)で明示する。「直前の」のような曖昧指定は許さない。
- 新規作成の場合、既定はClaude Codeに**新規チャット**で作らせる(1依頼=1チャット=1 URLで追跡を単純にし、公開Artifactの誤上書き経路を塞ぐ)。既存チャットの続きで作らせたい場合はその都度明示指定する。

## 受け渡し形式

- OMP→Claude Codeへ渡す成果物(HTML・指示文)は `.agent-msgs/scratch/artifacts/<name>.html` に置く。
- Claude Codeからの完了報告に必須の項目:
  1. Artifact ID/URL
  2. 生成物の内容(ブラウザ操作でないためスクリーンショットではなく、テキスト/HTML自体で確認)
  3. 反映した/しなかった差分

## 失敗時の扱い

対象Artifactが見つからない、内容取得不可、API呼び出し失敗等は「推測で埋めない」を`omp-herdr-collab`のtrust boundaryと同じ強さで適用する。不確実な情報で結果を埋めず、状態を明示してユーザーに報告する。

## UI方針との関係

このskillはArtifacts操作の手続きのみを定める。生成するHTML自体の見た目・部品選定は`~/.claude/CLAUDE.md`の「Diagrams and shared artifacts」節に従う(読み物HTMLに部品ライブラリを追加しない。frontend-design/ja-html-typography/nondesigner-designが正本)。
</content>
<parameter name="i">Create authored claude-artifacts-ops skill from managed skill content