---
name: browser-verify
description: 「ブラウザで確認して」「画面を検証して」「スクショを撮って」「ログインした状態で操作して」と言われたときや Web UI の変更を検証するとき、最初のブラウザ操作の前に読む。経路選択（headless / 別窓 Chrome / relay / terminal-browser）と CLI 別の手順。
---

# browser-verify

人が実行を見る必要があるかで経路を選ぶ。癖で選ばない。

| 状況 | 経路 | OMP | Claude Code | Codex |
|---|---|---|---|---|
| エージェントだけが見る（検証・調査・スクショ証拠） | headless | `browser` ツール既定 | claude-in-chrome（下記注） | browser plugin（下記注） |
| 人が動きを見たい | 別窓の実 Chrome、使い捨てプロファイル | `browser` + `app.path` | claude-in-chrome | browser plugin |
| ログイン済みセッションが必要 | 自分の Chrome | `browser` + `app.relay` | claude-in-chrome | Chrome plugin |
| ターミナルペインの横に並べて見せて、と明示 | terminal-browser | `terminal-browser` CLI | 同左 | 同左 |

terminal-browser は実ブラウザのフレームをターミナルセルへ再描画するので構造的に一番遅い
（30fps / scale 1 に制限済み）。明示された時以外は使わない。

headless は OMP だけが持つ。Claude Code / Codex は自前の headless を持たないので、
エージェントだけの検証でも claude-in-chrome / Codex browser plugin に落とす
（ユーザーの Chrome に見える・ログイン状態を引き継ぐ点は relay と同じ同意ルール）。
これは 2026-09-02 の決定で、agent-browser などの追加導入はしない。

## 共通ルール

- スクショは `<git toplevel>/.agent-msgs/screenshots/` へ。OMP は `browser.screenshotDir` で固定済み。
- 証拠は accessibility スナップショットや抽出結果を優先し、見た目の確認だけスクショにする。
- 別窓・relay・claude-in-chrome はユーザーのアカウントに帰属する。指示されていない
  副作用のある操作（投稿、購入、設定変更）はしない。
- 終わったら閉じる。別窓は `kill: true`、terminal-browser は `shutdown`。

## OMP

`xd://browser` へ JSON を書く。`open` → `run` → `close`。

### headless（既定）

```json
{"action":"open","url":"https://example.com"}
{"action":"run","code":"display(await tab.observe())"}
{"action":"close"}
```

### 人が見る

別窓の Chrome を使い捨て `--user-data-dir` で起動する。リテラル `--guest` は自動化に
制約があるので使わない。

```json
{"action":"open","name":"watch","url":"https://example.com",
 "app":{"path":"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "args":["--user-data-dir=/tmp/omp-chrome-watch","--no-first-run",
                "--no-default-browser-check","--window-size=1280,900"]},
 "viewport":{"width":1280,"height":800}}
{"action":"close","name":"watch","kill":true}
```

### ログイン済み

relay で自分の Chrome に入る。`app.target` でタブを選ぶ。無指定だと見えているタブを
乗っ取り、`url` 付き `open` はそのタブを遷移させる。

```json
{"action":"open","app":{"relay":true,"target":"github.com"}}
```

## Claude Code

claude-in-chrome MCP（`mcp__claude-in-chrome__*`、ペア済みの自分の Chrome）を使う。
ユーザーの Chrome に新しいタブとして見えるので、「人が見る」と「ログイン済み」は同じ経路。
headless 相当も同じ経路で、結果だけ報告する。

## Codex

bundled browser plugin（`node_repl` の browser サービス）を使う。アプリ内ブラウザが
「人が見る」、Chrome plugin が「ログイン済み」。

## terminal-browser（明示時のみ）

```sh
terminal-browser open <url> --split right --size 0.4
terminal-browser action -- snapshot
terminal-browser action -- click @e14
terminal-browser shutdown
```

コマンド全体は terminal-browser skill を参照。
