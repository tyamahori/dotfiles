# ponytail 利用ガイド

[ponytail](https://github.com/DietrichGebert/ponytail) は、エージェントに「最小の実装で済ませる」判断規範を毎ターン注入するプラグインです。
このマシンでは OMP、Claude Code、Codex の3ホストすべてに plugin-tier（常時注入 + モード切替 + 6スキル）で導入済みで、デフォルトは full モードです。

普段の操作は「日常操作」の節だけ覚えれば足ります。「各ホストでの動き方」以降は、挙動を確かめたいときや新しいマシンで入れ直すときに引く参照部です。

## 何をしてくれるか

コードを書く前に、次のラダーを上から当てて最初に成立した段で止まります。

```
1. そもそも要るか？        → 不要なら書かない (YAGNI)
2. このコードベースに既にあるか？ → 再利用
3. 標準ライブラリで済むか？   → 使う
4. プラットフォーム標準機能か？ → 使う
5. 導入済みの依存で済むか？   → 使う
6. 1行で書けるか？          → 1行
7. ここまで来たら、動く最小限を書く
```

検証・エラー処理・セキュリティ・アクセシビリティは削減対象外という前提つきです。
`agents/global-instructions.md` の Scope discipline と方向は同じですが、ルール文の正本はプラグイン側にあり、共有指示ファイルへは転記しません（毎ターン注入と二重になるため）。

## 日常操作

### 出力が過剰・過小だと感じた → 強度を切り替える

```
/ponytail            # 現在のモードを表示
/ponytail lite       # 弱める
/ponytail ultra      # 最強にする
/ponytail off        # このセッションでは切る
```

切替はセッション単位です。恒久的に変えたい場合だけ `PONYTAIL_DEFAULT_MODE` 環境変数（`lite`/`full`/`ultra`/`off`）を設定します。現在は未設定 = full です。

### diff やリポジトリの過剰実装を洗いたい → レビュー系コマンド

| やりたいこと | コマンド |
| --- | --- |
| 現在の diff の過剰実装を削除リストにする | `/ponytail-review` |
| リポジトリ全体を監査する | `/ponytail-audit` |
| `ponytail:` ショートカットコメントを台帳化する | `/ponytail-debt` |
| コマンド一覧を思い出す | `/ponytail-help` |

Codex ではスキル呼び出しになるため `@ponytail-review` のように `@` で呼びます。OMP では `/skill:` 経由でも呼べます。

## 各ホストでの動き方

3ホストとも同じ marketplace（`DietrichGebert/ponytail`）から導入した同じプラグインですが、cache と読み込み経路はホストごとに別です。

| ホスト | 注入経路 | 状態の置き場 |
| --- | --- | --- |
| OMP | `package.json` の `pi.extensions`（pi-extension が毎ターン注入） | `~/.omp/plugins/`（機械ローカル） |
| Claude Code | SessionStart / UserPromptSubmit フック | `~/.claude/plugins/`。有効化の正本は `claude/settings.json` の `extraKnownMarketplaces` + `enabledPlugins` |
| Codex | 同上のライフサイクルフック（要 trust） | `~/.codex/plugins/`（機械ローカル） |

動作確認はどのホストでも「ponytail のルールは注入されているか」と聞けば、full 稼働時は先頭行 `PONYTAIL MODE ACTIVE — level: full` を引用して答えます。

サブエージェントにも同じルールが注入されます（`PONYTAIL_SUBAGENT_MATCHER` 未設定 = 全 subagent 対象）。

## 新しいマシンでの導入は自動

3ホストとも dotfiles の適用で入ります。手動のインストールコマンドは不要です。

- **OMP**: `scripts/omp-plugins`（`./scripts/setup` と `omp-apply` が呼ぶ）が marketplace 登録とインストールを再現します。
- **Codex**: `scripts/link` が未インストールのときだけ marketplace 登録とインストールを実行します。
- **Claude Code**: `claude/settings.json` の宣言で、初回起動時の marketplace trust プロンプトに同意すれば自動で入ります。

手動操作が残るのは2点だけです。

1. **Codex のフック trust**: 対話セッションの `/hooks` からライフサイクルフックを review して trust し、新スレッドを開くまで常時注入が始まりません（スキルだけは trust 前でも使えます）。`scripts/link` が新規インストール時にリマインダーを表示します。
2. **Claude Code の statusLine nudge**: 初回起動時に statusLine セットアップの提案が出たら**拒否**してください。`~/.claude/settings.json` は dotfiles の symlink で、既に ccusage の statusLine を設定済みです。

フックの実体はプラグイン同梱の node スクリプト2本（モード注入とモード追跡）で、2026-08-28 時点のレビューでは安全でした。

ホストを増やす・別の marketplace プラグインを足す場合は、OMP は `scripts/omp-plugins` の `marketplace_plugins` 配列、Codex は `scripts/link` の該当ブロックに追記します。

## アンインストール

各ホストの remove コマンドの**前に**、プラグインの掃除スクリプトを実行します。remove を先にするとスクリプト自体が消えます。

```bash
node ~/.omp/plugins/cache/plugins/ponytail___ponytail___*/scripts/uninstall.js
omp plugin uninstall ponytail@ponytail
codex plugin remove ponytail
claude plugin uninstall ponytail@ponytail   # claude/settings.json のエントリも削除する
```

掃除スクリプトは `~/.config/ponytail/config.json` などプラグイン外に残る状態を消します。
恒久的にやめる場合は、`scripts/omp-plugins` の `marketplace_plugins` エントリと `scripts/link` の ponytail ブロックも削除します。残すと次回の setup / `omp-apply` / link で再インストールされます。

---

導入の経緯と検証記録は `docs/ops/2026-08-28-session.md` にあります。このガイドと実際の挙動が食い違う場合は挙動を正とし、この文書も同じ変更で更新してください。
