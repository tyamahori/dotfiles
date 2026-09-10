---
name: browser-verify
description: 「ブラウザで確認して」「画面を検証して」「スクショを撮って」「ログインした状態で操作して」と言われたときや Web UI の変更を検証するとき、最初のブラウザ操作の前に読む。経路選択（headless / 別窓 Chrome / relay / terminal-browser）と CLI 別の手順。
---

# browser-verify

人が実行を見る必要があるかで経路を選ぶ。通常のコーディング作業では、Claude Code と
Codex は公式 Playwright CLI の skill 経由で操作し、OMP は native `browser` を既定にする。
ページ構造を保った長い探索や、明示的に MCP を求められた仕事だけ Playwright MCP を使う。

| 状況 | OMP | Claude Code / Codex |
|---|---|---|
| エージェントだけが見る（検証・調査・スクショ証拠） | native `browser` の headless | `playwright-cli` の headless |
| 人が動きを見たい | 下記の CLI `--headed` で別窓 Chrome | 同左 |
| ログイン済みセッションが必要 | 明示同意後に `app.relay` | 明示同意後に既存 Chrome 連携 |
| 持続的なツールネイティブ探索 | 必要なら Playwright MCP | 必要なら Playwright MCP |
| ターミナルペインの横に並べて見せて、と明示 | terminal-browser | terminal-browser |

terminal-browser は実ブラウザのフレームをターミナルセルへ再描画するので構造的に一番遅い
（30fps / scale 1 に制限済み）。明示された時以外は使わない。

## 共通ルール

- コマンドは対象プロジェクトのルートで実行する。スクショと認証状態は
  `<git toplevel>/.agent-msgs/` 配下に置き、commit しない。
- 証拠は accessibility snapshot や抽出結果を優先し、見た目の確認だけスクショにする。
  MCP で `filename` を指定するときも `.agent-msgs/screenshots/` からのパスを渡す。
  相対ファイル名だけを渡すと、`--output-dir` の外に保存される場合がある。
- 既存のログイン済み Chrome、relay、Chrome 連携、Playwright Extension は明示的な同意が
  あるときだけ使う。Extension を自動導入・接続しない。通常の CLI は個人プロファイルを
  使わない。
- 終わったら、その作業のセッションやタブだけを閉じる。`close-all` や他の作業の
  セッションを閉じる操作は使わない。

## Playwright CLI を使う

公式の `playwright-cli` skill を読み、必要な操作の引数だけ
`playwright-cli <command> --help` で確認する。
コマンドがなければ `~/dotfiles/scripts/playwright-setup` で導入する。
実行時の `npx @latest` やグローバルインストールで代用しない。

CLI は既定で headless かつメモリ内プロファイルを使う。作業ごとに名前を付け、
すべてのコマンドで同じ `-s=<task>` を指定する。人が見る必要があるときだけ
`open --browser=chrome --headed` にして、同じく一時的な named session を使う。
`--persistent`、`--profile`、既存 Chrome への attach は、明示同意なしには使わない。

基本の流れは open → snapshot → 操作 → 必要なら screenshot → close。
出力先は各コマンドでプロジェクトのルート配下に固定する。
`e12` は例なので、直前の snapshot にある対象要素の参照へ置き換える。

```sh
PLAYWRIGHT_MCP_OUTPUT_DIR="$PWD/.agent-msgs/screenshots/playwright-cli" playwright-cli -s=checkout open http://localhost:3000
PLAYWRIGHT_MCP_OUTPUT_DIR="$PWD/.agent-msgs/screenshots/playwright-cli" playwright-cli -s=checkout snapshot
PLAYWRIGHT_MCP_OUTPUT_DIR="$PWD/.agent-msgs/screenshots/playwright-cli" playwright-cli -s=checkout click e12
PLAYWRIGHT_MCP_OUTPUT_DIR="$PWD/.agent-msgs/screenshots/playwright-cli" playwright-cli -s=checkout screenshot --filename=.agent-msgs/screenshots/playwright-cli/checkout.png
PLAYWRIGHT_MCP_OUTPUT_DIR="$PWD/.agent-msgs/screenshots/playwright-cli" playwright-cli -s=checkout close
```

人が見るときは open に `--headed` を加える。以後の操作にも同じセッション名を使う。

```sh
PLAYWRIGHT_MCP_OUTPUT_DIR="$PWD/.agent-msgs/screenshots/playwright-cli" playwright-cli -s=watch open https://example.com --browser=chrome --headed
```

MCP はページ構造を繰り返し調べる作業や、MCP での操作を指定されたときに使う。
CLI と MCP を同じ作業で併用しない。公式仕様は
[Playwright CLI](https://github.com/microsoft/playwright-cli) と
[Playwright MCP](https://github.com/microsoft/playwright-mcp) を参照する。

## OMP

OMP では native `browser` を優先する。JS Eval cell を書く前には
`efficient-ts-js` skill を読む。headless の基本操作は `browser.open` → `observe` → `close`。

```js
const tab = await browser.open({
  name: "verification",
  url: "https://example.com",
});
const snapshot = await tab.observe();
await tab.close();
```

### 人が見る

上記の CLI 手順を `--headed` で実行する。個人の Chrome プロファイルを使わず、
専用の別窓で操作を見せられる。

### ログイン済み

relay で自分の Chrome に入るのは明示同意後だけにする。`app.target` でタブを選ぶ。
無指定では見えているタブを乗っ取り、`url` 付き `open` はそのタブを遷移させる。

```js
const tab = await browser.open({
  name: "existing-chrome",
  app: { relay: true, target: "github.com" },
});
```

Claude Code のログイン済み操作は `claude-in-chrome`、Codex は既存の Chrome plugin を使う。
Playwright MCP の `--extension` も選択肢だが、拡張の導入と接続にはユーザーの同意が必要。
既定の headless・isolated 設定をログイン済みブラウザ向けに書き換えない。

## terminal-browser（明示時のみ）

```sh
terminal-browser open <url> --split right --size 0.4
terminal-browser action -- snapshot
terminal-browser action -- click @e14
terminal-browser shutdown
```

コマンド全体は terminal-browser skill を参照。
