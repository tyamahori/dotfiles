# 図表 / Artifact ワークフロー

archify、Plannotator、Claude Artifact を組み合わせて、図表を「作る」「人が直す」「共有する」を分けるための手引きです。
目的は二つです。
ひとつは、図の見た目やラベルに残りがちな AI くささを減らすこと。
もうひとつは、OMP / Claude Code / Codex のどこから始めても同じ流れに乗せることです。

普段は「まず使う」だけ覚えれば足ります。
配線や再構築の話は、その後ろの参照部にまとめています。

## まず使う

1. **図そのものは archify で作る。**
2. **出荷前に Plannotator で人が注釈する。**
3. **社内外への共有面は Claude Artifact にする。**
4. **正本はリポジトリ内の JSON IR / Markdown に置く。**

この4点を崩さない限り、入口が OMP でも Claude Code でも Codex でも運用は同じです。

## 役割分担

| 役割 | ツール | 何を持つか |
| --- | --- | --- |
| 図の生成 | archify | typed JSON IR、決定的レンダ、検証 |
| 人のレビュー | Plannotator | plan / diff / HTML への注釈と差し戻し |
| 共有面 | Claude Artifact | 関係者向けの見せ方、コメントしやすい表示 |
| 正本 | リポジトリ | `docs/diagrams/*.json` や元の Markdown |

**HTML を正本にしない**のが重要です。
HTML は共有しやすいが、差分管理と再生成に弱いからです。
archify の JSON IR を残しておけば、見た目を直しても図の意味を崩しません。

## どの依頼をどこへ流すか

### archify を使うもの

- architecture
- workflow
- sequence
- data-flow
- lifecycle / state

共通しているのは、**構造が主役**であることです。
ノード、境界、経路、状態、依存関係を見せたいなら archify に寄せます。

### archify ではなく既存の HTML 系を使うもの

- 設計資料そのもの
- 議論用の説明文が主役の HTML
- コメント取り込み前提の reviewable design doc
- 図は補助で、本文が主役のレポート

この系統は `reviewable-design-doc` や `visual-html-renderer` の担当です。
**図が主役か、文書が主役か**で分けてください。

### Plannotator を必ず挟みたいもの

- plan の承認前レビュー
- stakeholder 向けに出す HTML
- コード diff / PR のレビュー
- 「見た目は通るが、言葉選びが少し機械っぽい」成果物

Plannotator は生成器ではなく、**人間の判断を戻す面**です。
図を直接きれいにするより、違和感を発見して IR 側へ戻すために使います。

## 日常の最短手順

### 1. まず一枚の図に絞る

最初の依頼は広げすぎない方がうまくいきます。
例えば次の粒度です。

```text
Use archify to create a high-level runtime architecture diagram.
Show 8–12 core components, one primary path, external dependencies, and trust boundaries.
Put supporting detail in cards instead of adding more edges.
```

悪い依頼は「全部入り」です。
良い依頼は、**主要経路ひとつ + 境界 + 補足はカード**まで決めています。

### 2. JSON IR をリポジトリに置く

推奨置き場:

```text
docs/diagrams/<topic>.<type>.json
```

例:

```text
docs/diagrams/auth-login.sequence.json
docs/diagrams/runtime-overview.architecture.json
```

HTML は生成物として同じディレクトリに並べるか、一時出力にします。

### 3. ローカルでレンダと検証を通す

```bash
node ~/.agents/skills/archify/bin/archify.mjs validate architecture docs/diagrams/runtime-overview.architecture.json --quality showcase --json
node ~/.agents/skills/archify/bin/archify.mjs deliver architecture docs/diagrams/runtime-overview.architecture.json /tmp/runtime-overview.html --quality showcase --open --json
```

`deliver` を通してから共有します。
レイアウト破綻やラベル衝突を黙って抱えたまま出さないためです。

### 4. Plannotator で人がレビューする

- Claude Code / OMP: `/plannotator-annotate /tmp/runtime-overview.html`
- Codex: `!plannotator annotate /tmp/runtime-overview.html`

HTML をその場で直すのではなく、注釈を見て **JSON IR を修正** します。
直したらもう一度 `deliver` します。

### 5. Claude Artifact で共有する

claude.ai 側に `archify.zip` を Skill としてアップロード済みなら、JSON IR を渡して Artifact 化できます。
共有面は Artifact に任せ、リポジトリの正本は IR のまま維持します。

claude.ai 側で archify が実行できない場合は、ローカルで生成した HTML か share card PNG を添付して代用します。
このときも正本は JSON IR です。

## AI くささを減らすルール

### 1. ノード数を欲張らない

最初の一枚は 8〜12 ノード程度に抑えます。
多すぎると「全部同じ重要度」に見え、いかにも自動生成の図になります。

### 2. 主経路をひとつ決める

矢印を全部濃くしないでください。
一番読ませたい経路をひとつだけ主役にします。
キャッシュミス、例外、ロールバックは二次経路として扱います。

### 3. ラベルは社内語彙に寄せる

`Processing Layer`、`Data Service`、`User Interaction Module` のような無難な汎用語は避けます。
実際のチームが使う名前、サービス名、責務名をそのまま使う方が自然です。

### 4. 詳細はカードへ逃がす

補足事情まで全部エッジに載せると図が機械っぽくなります。
判断理由、例外条件、補助説明はカード側へ送ります。

### 5. 見た目を毎回変えない

preset と theme は文書群ごとに固定します。
毎回スタイルが揺れると、同じ発信者の成果物に見えません。
迷ったら `signal-flow` + dark を基準にします。

### 6. 人のレビューを最後に入れる

最後に残る AI くささは、レイアウトより**言葉**です。
Plannotator で「この語が硬い」「この境界名が抽象的すぎる」を拾い、IR に戻して直します。

## 各ホストでの動き方

| ホスト | archify | Plannotator | 補足 |
| --- | --- | --- | --- |
| OMP | `~/.agents/skills/archify` を global discovery | `@plannotator/pi-extension` | `scripts/omp-plugins` が pi-extension を再現 |
| Claude Code | `~/.claude/skills/archify` への symlink | marketplace plugin + `plannotator-*` skills | `claude/settings.json` の宣言が正本 |
| Codex | `~/.agents/skills/archify` を global discovery | `codex/hooks.json` の Stop hook + `plannotator-*` skills | `/hooks` で trust が必要 |

入口が違っても、成果物の正本を repo に置く点は同じです。

## このリポジトリで管理するもの / しないもの

### 管理するもの

- `scripts/link`
- `scripts/omp-plugins`
- `claude/settings.json`
- `codex/hooks.json`
- `agents/global-instructions.md`
- `omp/APPEND_SYSTEM.md`
- このガイド
- 各プロジェクトの diagram JSON IR

### 管理しないもの

- `~/.local/bin/plannotator` 本体
- `~/.plannotator/` のランタイムや履歴
- Claude Code / Codex の trust 状態
- claude.ai にアップロードした Skill
- 一時生成した HTML や PNG

管理しないものは、再構築手順だけ文書化して、実体は持ち込みません。

## 確認コマンド

```bash
plannotator --version
node ~/.agents/skills/archify/bin/archify.mjs doctor
claude plugin list
omp plugin list
```

期待値は次のとおりです。

- `plannotator --version` が返る
- `doctor` が `Archify is ready.` で終わる
- `claude plugin list` に `plannotator@plannotator` が enabled で見える
- `omp plugin list` に `@plannotator/pi-extension` が見える

Codex は `codex/hooks.json` を更新したあと、対話セッションで `/hooks` を開いて trust を更新してください。
trust 前でも skill 自体は見えますが、plan review の自動起動は始まりません。

## 更新と再構築

- **Plannotator を更新する**: `curl -fsSL https://plannotator.ai/install.sh | bash -s -- --non-interactive`
- **archify を更新する**: `npx -y skills add tt-a1i/archify -g --yes`
- **OMP の plannotator extension を揃える**: `scripts/omp-plugins`
- **dotfiles の宣言を再配置する**: `scripts/link`

新しいマシンでは `scripts/setup` のあと、このガイドと `docs/new-machine.md` の検証表を順に見れば戻れます。

## トラブル時の見方

### Claude Artifact にしたら見た目が変わった

Artifact は共有面です。
正本は JSON IR なので、Artifact 側を手で直さず IR を直して再生成します。

### 図は正しいが、まだ少し機械っぽい

Plannotator でラベルと境界名を見ます。
構造ではなく言葉の問題であることが多いです。

### Codex だけ自動で plan review が開かない

`codex/hooks.json` の変更を trust していない可能性が高いです。
対話セッションで `/hooks` を開き、更新済み定義を trust してください。

### claude.ai で archify skill が動かない

Skill 実行環境の制約です。
ローカルで生成した HTML か PNG を共有し、正本は repo の IR に残します。

---

導入の経緯とこのマシンでの検証記録は `docs/ops/2026-08-28-session.md` にあります。
このガイドと実際の挙動が食い違う場合は、挙動を正とし、この文書も同じ変更で更新してください。
