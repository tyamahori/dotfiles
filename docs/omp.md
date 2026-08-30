# OMP 利用ガイド

この文書は、数週間後に OMP（Oh My Pi）の操作を忘れていても、ここだけ読めば再開できるようにするための手引きです。

このリポジトリ固有の設定と運用を対象にしています。
一般的な CLI オプションは `omp --help`、セッション内の全コマンドは `/help` で確認してください。

## まず使う

作業対象の Git リポジトリへ移動し、OMP を起動します。

```bash
cd ~/project/example
omp
```

場所を間違えたくない場合は、どこからでも `omp-repo` を使います。
引数がリポジトリ内のサブディレクトリでも、Git のルートへ移動してから起動します。

```bash
omp-repo ~/project/example
```

非 trivial な実装では `omp-build` を使います。
メインモデルが要求整理と計画を担当し、計画後の最初の編集時に `@task` モデルへ切り替わります。

```bash
cd ~/project/example
omp-build
```

同じ日の短い中断後に、直前のセッションをそのまま続ける場合は次を使います。
日をまたいだセッションや、一時間以上放置した大きなセッションは継続せず、後述の手順で引き継ぎメモから新しく始めてください。

```bash
omp --continue
```

過去のセッションを選ぶ場合は次を使います。

```bash
omp --resume
```

一度だけ質問して終了し、セッションを保存しない場合は次を使います。

```bash
omp -p --no-session "このリポジトリのテストコマンドを調べて"
```

ファイルを最初の依頼へ添える場合は、パスの先頭に `@` を付けます。

```bash
omp @README.md "セットアップ手順の不足を指摘して"
```

## どの起動方法を選ぶか

| やりたいこと | コマンド | セッション |
| --- | --- | --- |
| 普通に相談・実装する | `omp` | 新規 |
| リポジトリのルートを確実に使う | `omp-repo PATH` | 新規 |
| 計画と実装のモデルを分担する | `omp-build` | 新規 |
| 直前の作業を続ける | `omp --continue` | 継続 |
| 保存済みセッションを選ぶ | `omp --resume` | 選択 |
| 一度だけ質問する | `omp -p --no-session "依頼"` | 保存しない |
| 学習候補を整理する | `omp-learning-review` | レビュー専用の新規 |
| 利用量と実行効率を見直す | `omp-review --days 7` | レビュー専用の新規 |

`omp`、`omp-repo`、`omp-build` は `.zshrc` で定義した関数です。
新しいターミナルで見つからない場合は `source ~/.zshrc` を実行してください。

Python と Go の language server は `omp/lsp.json` で user-wide に設定しています。
Git リポジトリのルートから起動すれば、設定ファイルのないリポジトリでも Pyright と gopls を利用できます。
Go module では `go.work` または `go.mod` もプロジェクトルートの検出に使います。

## `omp-build` を選ぶ基準

実装前にコードを調べて方針を決める作業は `omp-build` で始めます。
現在の設定では、要求整理と計画を default model の Fable が担当し、最初の `edit` または `write` で `@task` の Terra へ切り替わります。

次の作業が対象です。

- 複数ファイルを変更する
- バグの根本原因や呼び出し元を調べてから直す
- 新機能、API、設定、データ構造を変更する
- 実装方法に複数の選択肢がある
- テストや利用ガイドの更新まで含む

編集しない調査、変更箇所が決まっている一行修正、文言修正には通常の `omp` を使います。
迷った場合は、実装前にコードを読んで判断する必要があるかで選びます。

### リポジトリのルートから起動する

```bash
cd ~/project/example
omp-build
```

ホームディレクトリから起動すると LSP と jbcontext がリポジトリを認識できないことがあるため、先に作業対象へ移動します。

`omp-build` は Plan Mode や Plannotatorを自動では有効にしません。
計画の承認を挟む場合は、依頼に次の一文を含めます。

```text
まず関連コードを調査して計画を提示してください。承認後に実装と確認まで進めてください。
```

計画が固まる前に編集を許可すると、その時点で Terra へ切り替わります。
切り替え後は、status line または model badge で `@task` を確認できます。

## セッション内でよく使うコマンド

入力欄で `/` を打つとコマンド候補が出ます。
コマンド名を忘れた場合は、推測せず `/help` を開いてください。

| コマンド | 用途 |
| --- | --- |
| `/help` | 利用可能なコマンドを一覧する |
| `/hotkeys` | キーボード操作を確認する |
| `/context` | システム指示、履歴、ツールなどのコンテキスト使用量を見る |
| `/model` | 現在のセッションで使うモデルを選ぶ |
| `/settings` | マージ後の有効設定を確認・変更する |
| `/memory view` | 現在のプロジェクトで注入される local memory を見る |
| `/memory stats` | local memory の件数や処理状態を見る |
| `/memory enqueue` | 現在のセッションを明示的に学習キューへ送り、処理を促す |
| `/handoff [焦点]` | 過去の文脈を要約し、現在のセッションをその場で圧縮する |
| `/resume` | 保存済みセッションへ切り替える |
| `/new` | 現在のセッションを保存し、引き継ぎなしの空セッションを開始する |
| `/fork` | 現在の文脈と成果物を複製した別セッションへ分岐する |
| `/clear` | セッション ID を維持したまま、現在の会話コンテキストを空にする |
| `/quit`（`/q`、`/exit`） | 現在のセッションと入力途中の文を保存して OMP を終了する |
| `/skill:名前` | 指定した Skill の手順を読み込んで実行する |

OMP 17.4.2 の `/handoff` は新しいセッションを作らず、引き継ぎ Markdown も保存しません。要約は現在のセッション内にだけ残るため、`/handoff` の直後に `/new` を実行しても新しいセッションへは渡りません。
セッションをまたいで判断、未完了作業、失敗した試行を渡す場合は、エージェントにリポジトリ内の引き継ぎメモを書かせてから `/new` または `/quit` を使います。

モデルを永続的に変更する場合は、`omp/config.yml` の `modelRoles` を更新してください。
セッション内での選択だけでは永続化されません。
quota guard の自動切り替えは、利用枠のしきい値到達時に一度だけ走ります。
その後に手動で選び直したモデルは、同じ枠が続く間は guard に再上書きされません。

## 依頼の出し方

伝える要点は、問題、完了条件、成果物です。
たとえば、次のように依頼します。

```text
ログイン後に設定画面が 500 になる。
再現して原因を直し、該当経路を実際に操作して確認して。
既存の認証方式は変えないで。
```

複数の独立した作業は、並列実行を明示します。
依頼例は「この 3 項目を並列で実行して」です。
この環境では、メインセッションが要求整理、設計、統合、最終確認を担当します。
独立した実装は `task`、探索は `scout` へ委譲する設定です。

Git の commit、push、PR 作成など外部へ影響する操作が必要なら、依頼に含めます。
含めていない場合は、コード変更の完了と外部公開の完了を同一視しないでください。

## セッションとプロジェクトの扱い

OMP は起動時の作業ディレクトリを、セッション、project-local 設定、local memory のスコープ判定に使います。
別プロジェクトのディレクトリから起動すると、必要な記憶や指示を読み込めません。

普段はリポジトリのルートで `omp` を実行してください。
場所に自信がなければ `omp-repo PATH` を使ってください。

この環境の `omp` 関数は常に `--allow-home` を付けます。
ホームディレクトリから起動しても、一時ディレクトリへ退避しません。
ただし、ホーム全体を一つのプロジェクトとして扱う用途以外では、対象リポジトリから起動する方が安全です。

### 迷ったら「同じ文脈を残すか」で決める

| 状況 | 使う操作 | 結果 |
| --- | --- | --- |
| 同じ作業をこのまま続ける | 何もしない | 現在のセッションを継続する |
| 同じ作業だがコンテキストが重い | `/handoff [残す焦点]` | 同じセッション内で過去を要約して圧縮する |
| 関係のない作業を今すぐ始める | `/new` | 古いセッションを保存し、空セッションへ切り替える |
| 同日中の短い中断をする | `/quit` → 後で `omp --continue` | 保存した同じセッションを再開する |
| 新しいセッションへ作業を渡す | 引き継ぎメモを書く → `/new` | 空セッションでメモを読んで続ける |
| 日をまたぐ、長時間放置する | 引き継ぎメモを書く → `/quit` | 次回は通常の `omp` からメモを読んで始める |

引き継ぎメモの置き場は、リポジトリが明示的に定義していればそこ
（この dotfiles では `docs/ops/` のセッション日誌）、定義がなければ
`.agent-msgs/handoff/YYYY-MM-DD-<題名>.md` です。`.agent-msgs/` は
マシン共通の global gitignore で除外済みなので、どのリポジトリでも履歴を汚しません。
現在のエージェントには次のように依頼します。

```text
この作業を新しいセッションへ引き継ぐメモを書いて。置き場はリポジトリの定義に従い、
定義がなければ .agent-msgs/handoff/ に。
未完了タスク、決定事項、変更済みファイル、未実行の確認に絞って。
```

すぐに新しいセッションへ移る場合は、メモの保存後に `/new` を実行し、新しい入力でメモのパスを渡します。
作業を終える場合は `/quit` を実行します。次回は `omp --continue` ではなく通常の `omp` を対象リポジトリから起動し、メモのパスを渡します。

`/fork` は現在の文脈を複製するため、別案を試す分岐には向きますが、日跨ぎやコンテキスト肥大への対策には使いません。
`/handoff` 後に `/quit` し、同日中に `omp --continue` する方法は、圧縮した同じセッションを続けたい場合に限って使います。

## この dotfiles でのモデル運用

`omp/config.yml` の `modelRoles` が用途別のモデルを決めます。
具体的なモデル名は更新されるため、この文書へ重複して固定せず、設定ファイルを正本とします。

```bash
omp config get modelRoles --json
```

主な役割は次のとおりです。

| Role | 用途 |
| --- | --- |
| `default` | メインセッション |
| `plan` | 計画 |
| `task` | 実装 subagent と `omp-build` の実装段階 |
| `smol` | 軽量な探索や補助処理 |
| `slow` | 重い推論 |
| `vision` | 画像確認 |
| `commit` | commit 文面 |
| `advisor` | メインセッションの補助レビュー |

Anthropic と OpenAI Codex は別の subscription pool として使い分けます。
メインセッションは判断を担当し、実装、探索、機械的処理は OpenAI 側の subagent へ寄せる構成です。

利用枠の退避は双方向です。
Anthropic の残りが 20% に達すると `retry.fallbackChains` に従って OpenAI Codex へ、Codex 週次枠の残りが 20% に達すると Anthropic へ退避します。
`anthropic-usage-guard` extension は、omp 本体が判定しないモデル別枠（`anthropic:7d:fable` など）の切替と、Codex 週次枠 80% 到達の通知を担当します。
同 extension は両 pool の使用率（Claude 5h / 7d / モデル別 7d、Codex 週次枠）を editor 下の widget に常時表示します。
表示は Claude Code / Codex の GUI にある Usage 表示と同じ窓で、session_start と5分毎のチェックのたびに更新されます。
両方の pool が実質枯渇（98% 以上）した場合は、ローカル ollama を probe して応答があるときだけ qwen へ退避します。
ollama が起動していなければ何もせず、枠のリセットを待ちます（ollama は動いている前提にしない）。
現在の認証状態と quota はシェルで確認できます。

```bash
omp usage
```

利用可能なモデルを確認する場合は次を使います。

```bash
omp models
```

## local memory と自動学習

この環境では `memory.backend: local` と `autolearn.enabled: true` を有効にしています。
保存済みセッションから、プロジェクト単位の要約と再利用可能な lesson を作ります。
必要に応じて managed skill の候補も生成できます。

`autolearn.autoContinue: false` のため、セッション終了後に非表示の自動ターンを勝手に継続しません。
学習内容が authored skill や dotfiles へ自動昇格することもありません。

現在の記憶は次で確認します。

```text
/memory view
/memory stats
```

最新セッションの内容を確実に学習対象へ送ってから終了したい場合は、次を実行します。

```text
/memory enqueue
```

### 学習候補のレビュー

対象リポジトリのシェルから、次を実行します。

```bash
cd ~/project/example
omp-learning-review
```

これは対象プロジェクトの local memory、`learned.md`、生成 Skill、managed skill を整理するための新しい OMP セッションを起動します。
既存の OMP セッション内でシェルコマンドとして実行しないでください。

すでに OMP 内にいる場合は、代わりに次を入力します。

```text
/skill:omp-learning-loop
```

レビューでは候補を次のように分け、項目ごとの承認後にだけ反映します。

- 今後も再利用する内容は authored skill へ昇格する
- プロジェクト固有の事実は local memory に残す
- 既存 Skill と重複する内容は統合する
- 一時的、誤り、陳腐化した内容は保留または却下する

生成物が存在しない初回は、「昇格対象なし」で正常です。
再利用時に正しい内容だけを残し、候補数の多さは評価基準にしません。

## 定期レビュー

学習内容のレビューと、OMP の使い方自体のレビューは別です。

### 学習内容を整理する

```bash
cd ~/project/example
omp-learning-review
```

### 利用量と実行効率を見直す

```bash
cd ~/project/example
omp-review --days 7
```

`omp-review` は Claude Code と OMP の利用量、resume、cache hit、compaction、subagent、tool error などを計測します。
提案は項目別に承認してから適用され、結果は review journal へ記録されます。

月曜 10:00 に launchd(`com.tyamahori.omp-learning-weekly`)が
`~/.omp/agent/memories/` と managed skill を走査し、前回レビュー以降の
新しい学習候補があるプロジェクトだけを macOS 通知で知らせます。
通知が来たら該当プロジェクトで `omp-learning-review` を実行します。
利用効率のレポート(`agent-usage-weekly`、月曜 9:30 通知)を見て気になる週は
`omp-review --days 7` を実行します。

## 設定を変更する

このリポジトリでは、次のファイルだけを dotfiles で管理します。
認証情報、セッション、履歴、ログ、生成された managed skill は管理しません。

| 正本 | 配置先 | 内容 |
| --- | --- | --- |
| `omp/config.yml` | `~/.omp/agent/config.yml` | モデル、memory、retry、表示など |
| `omp/APPEND_SYSTEM.md` | `~/.omp/agent/APPEND_SYSTEM.md` | OMP 固有の常設指示 |
| `omp/extensions/` | `~/.omp/agent/extensions` | quota guard、通知、表示などの extension |
| `omp/mcp.json` | `~/.omp/agent/mcp.json` | MCP server 設定 |
| `agents/skills/` | 各 CLI の Skill directory | Claude、Codex、Copilot、OMP で共有する authored skill |

authored skill 以外のサードパーティ skill は原則として dotfiles 管理外です。
ただし **archify** と **plannotator の core skills** は例外で、図表生成・レビュー・Artifact共有の機械共通ワークフローとして global に維持します。
それ以外のサードパーティ skill は、対象プロジェクトのルートで `npx skills add <owner/repo>` を実行し、project scope に必要な skill だけ導入します。
図表まわりの使い分けと更新手順は `docs/diagram-workflow.md` を参照してください。

永続的な共通設定は、このリポジトリの正本を編集します。
`~/.omp/agent/` は配置先です。
既存の symlink が正常なら、正本の変更が即座に見えます。
設定、extension、Skill の多くは起動時に読み込まれるため、変更後は新しい OMP プロセスで確認してください。

新しいマシン、または symlink が壊れた場合は次を実行します。
`scripts/link` は OMP 以外の dotfiles と launchd 設定も再配置します。

```bash
cd ~/dotfiles
./scripts/link
```

マシン固有のモデル設定が必要な場合は、Git 管理外の `~/.omp/agent/config.local.yml` を作ります。
`.zshrc` はファイルが存在する場合だけ `PI_CONFIG_FILES` に追加し、共有 `config.yml` へ deep merge します。

```yaml
modelRoles:
  commit: ollama/qwen3-coder
```

マシン固有設定を作成または変更した後は、新しいシェルと新しい OMP プロセスを起動してください。

有効値の確認には `omp config get` を使います。

```bash
omp config get memory.backend --json
omp config get autolearn.enabled --json
omp config get retry.usageReservePct --json
```

## OMP 本体を更新する

`omp update` で本体を更新した後は、プラグインと dotfiles のリンクを再適用します。

```bash
omp-apply
```

`omp-apply` は `scripts/omp-plugins`、`scripts/link` の順に実行します。
リポジトリへ移動する必要はありません。

## plugin の管理

本体にない plugin は `scripts/omp-plugins` で宣言しています。
現在導入しているのは Plannotator と ponytail（`docs/ponytail.md`）です。
`/context` や外部 directory の追加など、本体に同等機能があるものは重複して導入しません。

OMP 更新後の通常運用では、前節の `omp-apply` を使います。
plugin だけを再適用する場合は次を実行します。

```bash
cd ~/dotfiles
./scripts/omp-plugins
```

導入状態は次で確認します。

```bash
omp plugin list
```

本体が同等機能を内蔵した plugin は、重複を避けるため意図的に導入していません。
判断理由は `scripts/omp-plugins` のコメントを正本とします。

## 困ったとき

### 別プロジェクトの記憶が出る、または必要な記憶が出ない

現在の OMP を終了し、対象リポジトリを明示して起動し直します。

```bash
omp-repo ~/project/example
```

### 設定変更が反映されない

有効値、symlink、ローカル上書きを順に確認します。

```bash
omp config get modelRoles --json
readlink ~/.omp/agent/config.yml
printenv PI_CONFIG_FILES
```

その後、新しい OMP プロセスを起動します。

### Skill が見つからない

Skill は起動時に discovery されます。
まず新しい OMP プロセスで試し、次に Skill の名前と配置を確認します。

```bash
omp read skill://omp-learning-loop
readlink ~/.agents/skills/omp-learning-loop
```

### `/context` などの plugin command がない

plugin の導入状態を確認し、宣言済み plugin と patch を再適用します。

```bash
omp plugin list
cd ~/dotfiles
./scripts/omp-plugins
```

### Anthropic のモデルから意図せず切り替わった

利用枠が 20% まで減ると quota guard が自動退避します。

```bash
omp usage
```

guard の切り替えは利用枠ごとに一度だけなので、`/model` で選び直せばその枠の間は再上書きされません。
恒久的に変える場合は `omp/config.yml` の role と fallback を見直します。

### コマンドの仕様を忘れた

シェルでは次を使います。

```bash
omp --help
omp config --help
omp models --help
omp plugin --help
omp-learning-review --help
omp-review --help
```

セッション内では `/help` と `/hotkeys` を使います。

## 更新箇所の早見表

| 変更したいもの | 編集する場所 |
| --- | --- |
| 起動関数 `omp`、`omp-repo`、`omp-build` | `dotfiles/.zshrc` |
| モデル、memory、retry、autolearn | `omp/config.yml` |
| language server の検出条件 | `omp/lsp.json` |
| OMP にだけ追加する常設指示 | `omp/APPEND_SYSTEM.md` |
| OMP extension | `omp/extensions/` |
| plugin と version | `scripts/omp-plugins` |
| authored skill | `agents/skills/<name>/SKILL.md` |
| 学習レビューの起動方法 | `scripts/omp-learning-review` |
| 学習レビューの週次通知 | `scripts/omp-learning-weekly` と `launchd/com.tyamahori.omp-learning-weekly.plist` |
| 利用効率レビューの起動方法 | `scripts/omp-review` |
| symlink と初期配置 | `scripts/link` |

このガイドと実装が食い違う場合は、上表の実装を正とし、この文書も同じ変更で更新してください。
