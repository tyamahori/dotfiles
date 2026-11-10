# デザイン系 skill の使い分け

画面や資料の見た目に関わる skill は複数あり、担当範囲と既定値が一部で重なります。
この文書は、どの依頼にどの skill を使うかと、値がぶつかったときにどちらを優先するかをまとめたものです。
毎セッション読み込まれる要約は `agents/global-instructions.md` の「Skills to load first」節（Diagrams の項目）にあり、この表と食い違ったら両方を同じ変更で直します。
図表を作ってレビューし共有する流れ（archify、Plannotator、Claude Artifact）は `docs/diagram-workflow.md` にあります。

## どの依頼にどれを使うか

| 依頼 | 使う skill | 補足 |
| --- | --- | --- |
| 新しい画面・ページ・手書き HTML を作る | `frontend-design` | 配色・書体・レイアウトの初期案を決める |
| 既存のアプリ画面・ダッシュボード・ランディングページが AI っぽいので手直しする | `unslop` | 機能・内容・節の順は変えず、余白、色、アイコン、文言、書体、レイアウト、細部、画像、動きの順に直す |
| 読ませる資料（Artifact、報告書、一枚もの、スライド構成）を仕上げる、配置を直す | `nondesigner-design` | 4 原則で監査する。`unslop` は当てない |
| 日本語の HTML | `ja-html-typography` | 上の三つと併用し、和文の改行・字間ではこちらを優先する |
| 構成案を並べて選ぶ | `prototype` | 明示的に呼び出したときだけ動く |
| 構造が主役の図 | `archify` | `docs/diagram-workflow.md` の流れに従う |
| 文書が主役の HTML、レビュー用の設計資料 | `visual-html-renderer`、`reviewable-design-doc` | 固定テンプレートなので、どのデザイン skill でも見た目を変えない。直したいなら手書きに切り替える |
| 画面の確認 | `browser-verify` | `unslop` の付属スクリプトは使わない |

新しく作るのか、既にある画面を直すのかで `frontend-design` と `unslop` を分けます。
読ませる資料かアプリの画面かで `nondesigner-design` と `unslop` を分けます。
「AI っぽい」と言われたとき、対象が文章なら `natural-japanese`（英文は `humanizer`）、画面なら `unslop` です。

## 値がぶつかったとき

小さなラベルにモノスペースや広い字間を既定で当てません。
`frontend-design` はモノスペースの小さなデータラベルをテンプレートの癖に数え、`unslop` は大文字で字間を広げたラベルを直す対象にし、16px 未満の字間を 0〜0.01em にしています。
`nondesigner-design` のラベル族も、同じ役割は同じ型にするという反復の原則だけを残し、書体と字間の固定値を外しました。

配色と書体の初期値は `frontend-design` の計画で決めます。
`unslop` の `references/tokens.md` には、ほぼ黒の地に差し色を一色置く案や、クリーム地にセリフ体の見出しを置く案があり、`frontend-design` が避けるよう言う AI の既定の組み合わせに近いものが含まれます。
`unslop` を使うときも、方向性は対象の製品から決め、tokens は値の幅を知るための参考にとどめます。

`unslop` の文言と書体の規則は英語を前提にしています（文頭だけ大文字にする、英文書体の選び方など）。
日本語の画面では、組版は `ja-html-typography`、文言は `natural-japanese` を優先します。

## unslop を使うときの約束

`unslop` は監査の結果と方向性 5 行をユーザーに見せ、返事を待ってから編集に入ります。
画像生成ツールがあればヒーロー画像を作る手順もありますが、生成は費用がかかるので、プロンプト・モデル・サイズを見せて毎回先に確認します（`references/visuals.md`）。
どちらも上流の規則で、省かずに守ります。

付属の `scripts/snapshot.mjs`（公開中のページを HTML とスクリーンショットに保存する）と `scripts/story.mjs`（手直しの過程を動画にする）は使いません。
どちらも対象のプロジェクトに Playwright を入れる必要があり、表示の確認は `browser-verify` の経路で足ります。
また `story.mjs` が立てるローカルサーバー（127.0.0.1）は、配信するファイルの範囲を文字列の前方一致で判定し、symlink もたどるため、story ディレクトリの外のファイルを返せます（`97daa3e` の 387〜388 行）。
動画が必要になったら、この点を確かめてから使うかどうかを決めます。

ライセンスは CC BY 4.0 です。内容を写したり改変したりするときは、作者のクレジットを残します。

`docs/software-engineering.md` に出てくる `unslop` は pstack の文章向け skill で、この UI 向けの `unslop`（heydamir/unslop）とは別物です。

## 導入と更新

`frontend-design`（anthropics/skills）、`unslop`（heydamir/unslop）、`prototype`（emilkowalski/skills）、`archify` はサードパーティの global skill で、`scripts/agent-tools` の `global_skills` 配列で宣言しています。
未導入のものは `scripts/agent-tools` が入れ、更新は他の global skill とまとめて `npx -y skills@latest update -g` で行います。
`--agent '*'` は付けません。50 個近い他ツールの dot ディレクトリに symlink を撒くためです。
`prototype` は上流の `disable-model-invocation: true` を維持しており、OMP では `/skill:prototype` に対象と比べたい点を添えて呼び出します。
比較中も元の事実と数値は固定し、架空のデータで埋めず、静止画や PDF でも意味が伝わる構成を保ちます。
本来は UI 部品向けの skill で、説明資料を読みやすくする効果はまだ確かめていません。

`nondesigner-design` と `ja-html-typography` は authored skill で、`agents/skills/` に置いています。
変えたら `scripts/link` を実行し、新しいセッションで確かめます。
