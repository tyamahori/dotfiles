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
Bash と YAML は built-in 定義（root marker は `.git`）のまま、`scripts/devbox` が入れる `bash-language-server` と `yaml-language-server` で自動検出されます。

`debug` ツールのアダプタは Go が `delve`（`scripts/devbox`）、Python が `debugpy`（`scripts/python` の `uv tool install`）です。
built-in の debugpy 定義は `python -m debugpy.adapter` を起動しますが、uv tool は隔離 venv なので `omp/dap.json` で `debugpy-adapter` 実行ファイルへ差し替えています。
delve は built-in 定義のまま動きますが、`program` にディレクトリを渡すとき `/tmp` 配下は `/private/tmp` の symlink を `go build` が別パスと見なして「outside main module」で落ちます。`.go` ファイルを渡すか実パスを使ってください。

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
ただし両プールが 98% 以上に枯渇した場合は例外で、ローカル ollama への退避がもう一度だけ走ります。

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
| 新しいセッションへ作業を渡す | 引き継ぎメモを書く → `handoff_switch`（自動） | 空セッションへ切り替わり、メモを要約して指示を待つ |
| 日をまたぐ、長時間放置する | 引き継ぎメモを書く → `/quit` | 次回は通常の `omp` からメモを読んで始める |

引き継ぎメモの置き場は、リポジトリが明示的に定義していればそこに従います。
このdotfilesでは `.agent-msgs/handoff/YYYY-MM-DD-<題名>.md` に保存します。
`docs/ops/` はユーザーの作業日誌なので、エージェントは編集・commitしません。
置き場の定義がないリポジトリでも `.agent-msgs/handoff/` を使います。
`.agent-msgs/` はマシン共通のglobal gitignoreで除外済みです。
現在のエージェントには次のように依頼します。

```text
この作業を新しいセッションへ引き継ぐメモを書いて。置き場はリポジトリの定義に従い、
定義がなければ .agent-msgs/handoff/ に。
未完了タスク、決定事項、変更済みファイル、未実行の確認に絞って。
```

すぐに新しいセッションへ移る場合は、エージェントがメモを保存し、未完todoをメモに記録してから `block(reason: handoff)` にします。その後、`handoff_switch` ツール（`omp/extensions/handoff-switch.ts`）を呼びます。応答が終わると拡張が `/handoff-switch <path>` を実行して空セッションへ切り替え、メモを読んで要約するよう最初の入力を投入します。新セッションは指示を待ち、作業を自動では再開しません。手動で切り替える場合は `/handoff-switch <path>` を直接実行します。
作業を終える場合は `/quit` を実行します。次回は `omp --continue` ではなく通常の `omp` を対象リポジトリから起動し、メモのパスを渡します。

`/fork` は現在の文脈を複製するため、別案を試す分岐には向きますが、日跨ぎやコンテキスト肥大への対策には使いません。
`/handoff` 後に `/quit` し、同日中に `omp --continue` する方法は、圧縮した同じセッションを続けたい場合に限って使います。

## この dotfiles でのモデル運用

モデル運用の正本は `omp/config.yml` です。通常の割り当てを決める `modelRoles` と、障害・使用量制限時の退避先を決める `retry` を隣にまとめています。
具体的なモデル名はこの文書へ重複して固定しません。

```bash
omp config get modelRoles --json
omp config get retry.fallbackChains --json
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

### モデルや退避先を見直す

通常のモデルを変えるときは `modelRoles`、退避先を変えるときは `retry.fallbackChains` を編集します。
モデル別のキー `provider/model-id` は、共通の `provider/*` より優先されます。
共通設定を残したまま、特定のモデルだけ退避先を変更できます。

この dotfiles では、使用量監視と同じ経路を使うため、退避元のキーは思考強度を付けない `provider/model-id` または `provider/*` に揃えます。
退避先は `provider/model-id` の配列で、上から順に試します。空配列は、そのモデルの退避候補をなくす指定です。
通常モデルの ID を変えた場合は、対応する退避元のキーも変更してください。`@role` は退避先には使えません。

`anthropic-usage-guard` は OMP の実効設定から同じ配列を読み、Codex の候補を使います。モデル名を拡張のコードへ追加する必要はありません。
プロジェクト設定や `--config` による上書きも反映されます。ロール別・思考強度別など、別の形式を導入する場合は、拡張側も OMP 本体の resolver に合わせて変更します。
変更後は `scripts/link` を実行し、OMP を再起動してください。稼働中のセッションへは設定ファイルの変更が自動反映されません。

### 使用量の監視

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
月曜 9:30 の `agent-usage-weekly` は `omp-review` と同じ計測スクリプト
(`agent-usage-review/scripts/snapshot.sh`)を過去 7 日で走らせ、レポートを
`~/.local/state/agent-usage/weekly-YYYY-MM-DD.md` に保存し、OMP の費用・
compaction 回数・churn 率を macOS 通知で知らせます。気になる週は
`omp-review --days 7` を実行します。

### モデルピンを見直す

`claude/settings.json`、`codex/config.toml`、`omp/config.yml` のモデルピンは
`scripts/model-pins` で確認します。
`check` は前回レビュー済みの値との差分を示し、レビュー完了後の `ack` が現在値を記録します。

これらのファイルを変えた commit の post-commit hook と、月曜の
`omp-learning-weekly` 通知は、未レビューの差分を別々に知らせます。
通知を受けたら `model-migration-review` または
`/skill:model-migration-review` を実行します。
公式資料と照合して項目ごとの承認後にだけ変更し、結果を
`agents/skills/model-migration-review/journal.md` に残します。

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
ただし **archify**、**frontend-design**（anthropics/skills）、**prototype**（emilkowalski/skills）、**plannotator の core skills**、**sureforge**（Da7-Tech/SureForge）は例外で、図表生成・HTML の見た目設計・構成案の比較・レビュー・Artifact共有・複雑タスクのゲート付き作業手順という機械共通ワークフローとして global に維持します。
sureforge は「Use SureForge for this task」（高リスクなら「in full mode」）と指示したときだけ使うもので、更新は `npx -y skills add Da7-Tech/SureForge -g --yes` です。
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

## Jev skill hint（machine-global extension）

`omp/extensions/jev-skill-hint.ts`（`~/.omp/agent/extensions` へ配置される machine-global な
extension）は、起動 cwd に関わらずすべてのリポジトリのメインセッションで効きます。
project-local な `.omp/extensions/`（このリポジトリの root で開いたセッションだけに効く
仕組み）とは別物です。`JEV_API_KEY` の読み取り先は cwd に関係なく常にこのマシンの
`~/dotfiles/.env` 固定なので、他リポジトリで使う場合も個別に鍵を置く必要はありません。

ターン開始のたびに TypeSafe（Jev）の systemone API へ依頼文と Skill 一覧（名前+説明。
システムプロンプトの `<skills>` から都度抽出するのでハードコードしない）を渡し、合いそうな
候補があれば `<skill_relevance>` ヒントを非拘束の参考情報として注入します。最終的にどの
Skill を読むかはこれまで通りエージェントの判断に委ねます。設計と検証結果は
`.agent-msgs/handoff/2026-09-18-jev-skill-recommendation-eval.md` を参照してください。

### 有効化する

1. https://console.typesafe.ai で API キーを発行します。
2. dotfiles リポジトリ root の `.env`（gitignore 済み、既存）に追記します。

   ```bash
   echo 'JEV_API_KEY=sk-...' >> .env
   ```

3. `./scripts/link` を実行して `omp/extensions/jev-skill-hint.ts` が
   `~/.omp/agent/extensions/` にリンクされていることを確認し、新しい OMP セッションを
   起動します（どのリポジトリの root から起動しても構いません）。

### Jev が使えないとき・無効化する

`JEV_API_KEY` が未設定の場合、この extension はヒント登録そのものを行わない完全な
no-op になります。設定済みでも API 呼び出しが失敗（ネットワーク断、認証エラー、
タイムアウトなど）した場合は、そのセッション内では以降 Jev を呼ばずヒント無しの
挙動へフォールバックします。どちらの場合もエラーは表示されず、既存の Skill 選択の
動きを妨げません。明示的に無効化する場合は次のいずれかです。

- `.env` から `JEV_API_KEY` を削除する、またはコメントアウトする（全リポジトリで無効化）。
- 特定のリポジトリだけで無効化したい場合は、そのリポジトリの root に `.omp/config.yml`
  （project-local、未作成なら新規作成）を置き、次を追記します。

  ```yaml
  disabledExtensions:
    - extension-module:jev-skill-hint
  ```

### 動作を確認する

複数の Skill が絡む依頼を投げ、応答の直前に
`Jev候補(参考、必須ではない): ...` が挿入されるかを見ます。`JEV_API_KEY` を
一時的に外した新しいセッションでは、ヒントが出ず、エラーも出ないことを確認します。

### 実測ログで効果を測る

`before_agent_start` でのヒント生成結果と、そのターン中に実際に読まれた
`skill://` を突き合わせ、1ターン1行の JSONL として、使われたリポジトリの
`.agent-msgs/scratch/jev-skill-hint-metrics.jsonl`（gitignore 対象、cwd 相対）に
追記します。

| フィールド | 意味 |
|---|---|
| `promptChars` / `rosterSize` | 依頼文の長さ・Skill 一覧の件数 |
| `hintLatencyMs` | Jev 呼び出し(Call1+Call2)のレイテンシ。`circuitOpen`/`jevError` 時は `null` |
| `accepted` | Jev が採用した候補 Skill 名 |
| `circuitOpen` | セッション内で既に失敗済みで、今回は呼び出し自体をスキップした |
| `jevError` | 今回の呼び出しが失敗し、以後 `circuitOpen` になった |
| `actualSkillReads` | そのターン中に実際に `read skill://...` された Skill 名(重複除去) |
| `hits` | `accepted` と `actualSkillReads` の重なり件数(ヒントが実際に使われた数) |
| `extraReads` | ヒント候補になかったが読まれた Skill 数(見落とし方向の指標) |
| `missedAccepted` | ヒント候補になったが読まれなかった Skill 数(過剰提案の指標) |

`hits` の合計と `accepted` の合計から採用率を、`hintLatencyMs` の平均から
レイテンシ負担を、次のコマンドで集計できます（対象リポジトリの root で実行）。

```bash
jaq -s 'def sum(f): reduce .[] as $x (0; . + ($x|f));
  (sum(.accepted|length)) as $accepted |
  {turns: length,
   avgLatencyMs: (sum(.hintLatencyMs // 0) / length),
   hitRate: (sum(.hits) / (if $accepted == 0 then 1 else $accepted end)),
   avgExtraReads: (sum(.extraReads) / length)}' \
  .agent-msgs/scratch/jev-skill-hint-metrics.jsonl
```

## Jev agent hint（machine-global extension）

`omp/extensions/jev-agent-hint.ts` は `jev-skill-hint.ts` の姉妹 extension です。
machine-global（起動 cwd に関わらず全リポジトリのメインセッションで効く）で、
`JEV_API_KEY` の読み取りは常にこのマシンの `~/dotfiles/.env` を固定パスで見ます
（cwd は呼び出し元リポジトリごとに変わるため）。ヒント注入はまだ行わず、shadow
ログ収集のみです。ログは呼び出し元リポジトリの `.agent-msgs/scratch/` に書きます
（cwd 相対のまま — 効果測定は使われたプロジェクトごとに見ます）。

`task` ツール呼び出しのたびに、依頼文と agent roster（`task` ツール自身の description
から都度抽出。ハードコードしない）を Jev の Choice 質問へ渡し、どの agent 種別
（`scout`/`reviewer`/`security-reviewer`/`task`/`sonic` 等）が最適かを予測してログするだけの
**shadow mode** です。実際の委任先には一切影響しません — `tool_call` の `input` は
書き換えず、予測値を stdout・会話に出すこともありません。実データが溜まってから、
`jev-skill-hint` と同じ手順（合成評価→閾値較正→Go/No-Go）でヒント注入に進むかどうかを
判断します。

### Jev が使えないとき

`JEV_API_KEY` 未設定なら extension は何も登録しません（完全な no-op）。設定済みでも
呼び出しが失敗した場合は、そのセッション内では以降呼び出さず静かに no-op へ切り替えます
（circuit breaker）。Jev 呼び出しは `ctx.setTimeout(..., 0)` で本処理から切り離して実行する
ため、`tool_call` ハンドラ自体は同期的に即 return し、実タスク発行にレイテンシを一切
追加しません。ハンドラの同期部分も全体を try/catch で囲んでおり、roster 抽出などで
何が起きても実タスク発行をブロックしません。

### 動作を確認する

`.agent-msgs/scratch/jev-agent-hint-metrics.jsonl`（gitignore 対象）に `task` ツール呼び出しの
item ごと1行で追記されます。`JEV_API_KEY` を一時的に外した新しいセッションでは、このファイルが
増えないことを確認します。

| フィールド | 意味 |
|---|---|
| `taskTextChars` / `rosterSize` | 依頼文の長さ・agent roster の件数 |
| `explicitAgent` | `tasks[]` の `agent` に明示指定された値。省略時は `null`（default agent を推測しない） |
| `predictedAgent` / `predictedProb` | Jev が最も確率が高いと予測した agent とその確率 |
| `probabilities` | 全 agent 候補の確率分布 |
| `latencyMs` | Jev 呼び出しのレイテンシ。`circuitOpen`/`jevError` 時は失敗までの経過時間 |
| `circuitOpen` | 今回の呼び出しが失敗し、以後セッション内で no-op になった |
| `jevError` | 今回の呼び出しが失敗した |

`explicitAgent` と `predictedAgent` の一致率は次で集計できます。

```bash
jaq -s 'def sum(f): reduce .[] as $x (0; . + ($x|f));
  map(select(.explicitAgent != null and .jevError == false)) as $labeled |
  {items: length,
   labeled: ($labeled | length),
   avgLatencyMs: (sum(.latencyMs) / length),
   agreementRate: (($labeled | map(select(.explicitAgent == .predictedAgent)) | length) /
     (if ($labeled | length) == 0 then 1 else ($labeled | length) end))}' \
  .agent-msgs/scratch/jev-agent-hint-metrics.jsonl
```

## Jev model hint（machine-global extension）

`omp/extensions/jev-model-hint.ts` は `jev-agent-hint.ts` の姉妹 extension です。同じく
machine-global で、`JEV_API_KEY` の読み取りも常に `~/dotfiles/.env` を固定パスで見ます。
ヒント注入・実際のモデル切替はまだ行わず、shadow ログ収集のみです。ログは呼び出し元
リポジトリの `.agent-msgs/scratch/` に書きます（cwd 相対のまま）。

ユーザー入力（ターン開始）のたびに、依頼文だけを Jev の Choice 質問へ渡し、`smol`/`default`/`slow`
の3階層のうちどれが最適かを予測して、そのターンで実際に使われているモデル
（`ctx.models.current()`）と突き合わせてログするだけの **shadow mode** です。`setModel` は
一切呼びません。対象を3階層に絞るのは、`omp/config.yml` の `modelRoles` にある
`vision`/`commit`/`plan`/`advisor` が用途固定のロールで「この依頼はどれくらい重いか」という
一般判断の対象ではないためです。`anthropic-usage-guard.ts`（使用量枠ベースの決定的な切替）とは
独立に動きます。実データが溜まってから、`jev-skill-hint` と同じ手順（合成評価→閾値較正→
Go/No-Go）でヒント注入/自動切替に進むかどうかを判断します。

### Jev が使えないとき

`JEV_API_KEY` 未設定なら extension は何も登録しません（完全な no-op）。設定済みでも
呼び出しが失敗した場合は、そのセッション内では以降呼び出さず静かに no-op へ切り替えます
（circuit breaker）。Jev 呼び出しは `ctx.setTimeout(..., 0)` で本処理から切り離して実行する
ため、`input` ハンドラ自体は同期的に即 return し、実際のターン処理にレイテンシを一切
追加しません。ハンドラの同期部分も全体を try/catch で囲んでおり、何が起きてもターン処理を
ブロックしません。

### 動作を確認する

`.agent-msgs/scratch/jev-model-hint-metrics.jsonl`（gitignore 対象）にユーザー入力ごと1行で
追記されます。`JEV_API_KEY` を一時的に外した新しいセッションでは、このファイルが増えないことを
確認します。

| フィールド | 意味 |
|---|---|
| `requestChars` | 依頼文の長さ |
| `explicitModel` | そのターンで実際に使われているモデル（`provider/id`）。取得できなければ `null` |
| `predictedTier` / `predictedProb` | Jev が最も確率が高いと予測した階層（`smol`/`default`/`slow`）とその確率 |
| `probabilities` | 全階層の確率分布 |
| `latencyMs` | Jev 呼び出しのレイテンシ。`circuitOpen`/`jevError` 時は失敗までの経過時間 |
| `circuitOpen` | 今回の呼び出しが失敗し、以後セッション内で no-op になった |
| `jevError` | 今回の呼び出しが失敗した |

`explicitModel` は具体的なモデル ID なので、`predictedTier` と直接は一致比較できません。
`omp/config.yml` の `modelRoles` で `explicitModel` がどの階層に対応するかを引いてから、
`jev-agent-hint` と同じ形の集計を行ってください。

## Jev plan gate（machine-global extension）

`omp/extensions/jev-plan-gate.ts` は Plan Mode の `<proposed_plan>` を機械的に検査する
extension です。以前は `agents/skills/jev-plan-gate`（agent-internal skill、エージェントが
計画提示の直前に自分で気づいて使う設計）として試作しましたが、確実性がなく
「忘れる」問題を解決できなかったため、この turn_end 駆動の extension に置き換えました
（旧 skill は削除済み）。

`turn_end` イベントで直前のアシスタントメッセージを見て、`<proposed_plan>...
</proposed_plan>` を含む場合だけ動きます。ブロック内の箇条書き/番号付き行を候補として
正規表現抽出し、件数が2〜8件の範囲内なら、候補ごとに独立した Noul 質問
（「この項目は目標達成に必要か」）を1回の Jev 呼び出しにまとめて投げます。必要性確率が
0.5未満の候補を「不要かもしれない」候補として集め、1件以上あれば `<plan_relevance>`
ヒントを非拘束の参考情報として注入します。深いトレードオフ・リスクレビューはこの
仕組みの対象外で、それは `adversarial-verification` skill が担います。

計画はすでに表示済み（ターンが終わっている）ため、`jev-skill-hint` のように
`before_agent_start` の戻り値でヒントを差し込むことはできません。代わりに
`pi.sendMessage` を `deliverAs: "nextTurn"`（`triggerTurn` なし）で呼び、ユーザーが計画に
対して次に発言するタイミングでその発言と一緒に配信・表示します。新規ターンを強制
起動しないため、計画提示のたびに追加の推論コストは発生しません。

有効化・無効化の手順とキーの読み取り先（`~/dotfiles/.env` 固定）は
`jev-skill-hint` と同じです。実行時に失敗した場合はそのセッション内で以後 no-op に
切り替わり、失敗ログを `.agent-msgs/scratch/jev-plan-gate-metrics.jsonl`
（呼び出し元リポジトリの cwd 相対、gitignore 対象）に1計画1行の JSONL で残します。

## Jev PR-review lens shadow

`scripts/jev-pr-lens-shadow.ts` は `github-pr-review` Skill から任意で呼ばれる CLI で、
`.omp/extensions/` の pilot extension とは別物です（machine-global に
`bun "$HOME/dotfiles/scripts/jev-pr-lens-shadow.ts" ...` として呼ぶため、他リポジトリの
PR レビューでも動きます）。SKILL.md の「観点」表にある変更種別のうち、diff から
Jev がどの行が該当すると予測するか（`predict`）と、レビュー担当が実際に確定した
該当行（`actual`）を、同じ `--ref` を鍵にして shadow ログするだけです。行カテゴリは
SKILL.md の表からその場で抽出します（ハードコードしない）。

**レビュー結果には一切影響しません。** Jev の予測は stdout はもちろんどこにも表示せず
（先にレビュー担当が読むと判断が引きずられるため）、JSONL ログにのみ書きます。どんな
失敗でも常に exit 0 で、レビューを絶対にブロックしません。

### 有効化する

`jev-skill-hint` と同じ `.env` の `JEV_API_KEY` を使います（cwd に依存しない
`import.meta.dir` 基準でリポジトリ root を解決するため、`.omp/extensions/` の pilot と
異なり dotfiles リポジトリ外からの呼び出しでも動きます）。`actual` の記録に Jev は
不要です。

```bash
bun "$HOME/dotfiles/scripts/jev-pr-lens-shadow.ts" predict --ref <base>..<head> --diff-file <diffファイルのパス>
bun "$HOME/dotfiles/scripts/jev-pr-lens-shadow.ts" actual --ref <base>..<head> --rows "バグ修正,データアクセス（クエリ・ファイル I/O・外部呼び出し）"
```

### Jev が使えないとき

`JEV_API_KEY` 未設定、diff ファイルが読めない、SKILL.md の表が見つからない、Jev
呼び出しが失敗（ネットワーク断・タイムアウト等）のいずれでも、`predict` は何も出力せず
静かに終了します（exit 0）。失敗時のみ `jevError:true` をログに残しますが、呼び出し元へは
一切伝播しません。`actual` は Jev を呼ばないため、この影響を受けません。

### 動作を確認する

`.agent-msgs/scratch/jev-pr-lens-shadow.jsonl`（gitignore 対象）に `predict`/`actual` それぞれ
1回の呼び出しにつき1行で追記されます。

| フィールド | 意味 |
|---|---|
| `kind` | `predict` または `actual` |
| `ref` | `predict`/`actual` を突き合わせる鍵（呼び出し側が決める。base..head の SHA 範囲など） |
| `diffChars` / `rowCount`（`predict`のみ） | diff の長さ・行カテゴリの件数 |
| `probabilities`（`predict`のみ） | 変更種別ごとの該当確率。失敗時は `null` |
| `rows`（`actual`のみ） | レビュー担当が実際に確定した該当行 |
| `latencyMs` / `jevError`（`predict`のみ） | Jev 呼び出しのレイテンシと成否 |

`ref` で `predict` と `actual` を突き合わせ、閾値 0.5（暫定、較正前の目安）での
行の一致率を次で集計できます。

```bash
jaq -s '
  (map(select(.kind=="actual")) | map({(.ref): .rows}) | add) as $actual |
  map(select(.kind=="predict")) |
  map(. + {actualRows: ($actual[.ref] // [])}) |
  map(. + {predictedRows: (.probabilities // {} | to_entries | map(select(.value >= 0.5)) | map(.key))}) |
  {
    predictions: length,
    avgLatencyMs: (if length==0 then null else (map(.latencyMs) | add / length) end),
    jevErrorRate: (if length==0 then null else ((map(select(.jevError)) | length) / length) end),
    naiveThreshold: 0.5,
    rowRecall: (
      (map(.actualRows | length) | add) as $actualTotal |
      (map(((.actualRows) - ((.actualRows) - (.predictedRows))) | length) | add) as $matched |
      if $actualTotal == 0 then null else ($matched / $actualTotal) end
    )
  }' .agent-msgs/scratch/jev-pr-lens-shadow.jsonl
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
例外は両プール枯渇時(98% 以上)のローカル退避で、この場合はもう一度だけ上書きされます。
恒久的に変える場合は `omp/config.yml` の role と fallback を見直します。

### 「Shell read/search commands are blocked on this machine」と出る

`omp/extensions/deny-commands.ts` が、専用ツールで代替できる shell 呼び出しを拒否した表示です。
同じコマンドを再試行せず、拒否理由に示された `read`、`grep`、`glob` を使います。
パイプ途中の読み取りフィルタや、書き込み用の `cat`、heredoc は許可します。
正当な用途まで拒否された場合は、コマンドと拒否理由を確認してルールを修正します。

### 「`.env`-style credential files are blocked」と出る

`.env`・`.env.local`・`credentials.env` のような平文の資格情報ファイルを、agent に読み込ませない仕組みです。三 CLI で層が異なります。

- Claude Code: `claude/settings.json` の `permissions.deny` に `Read(//**/*.env)` と `Read(//**/.env.*)` を設定済みです。Claude 公式の deny 優先順位により、同じ設定内の `Read(~/.config/**)` などの allow より必ず優先されます。この deny は Read 本体に加えて Edit・Write、Grep・Glob、および Claude Code が認識する `cat`/`head`/`tail`/`sed`/`tee` の bash 呼び出しとリダイレクト先にも及びます。
- OMP: `omp/extensions/deny-env-reads.ts` が `read`/`grep` ツールを同じファイル名パターンで拒否します。`glob` はファイル名列挙のみなので対象外です。
- 三 CLI 共通: `agents/command-rules.json` の `env-file-read` ルールが `cat`/`head`/`tail`/`less`/`more`/`strings`/`od`/`xxd`/`base64`/`tee` の bash 呼び出しを拒否します。Codex には Claude Code のような native Read ツールがなく shell 経由の読み取りしか手段がないため、この bash ルールが Codex にとって唯一の防御層です。

`grep`/`rg`/`awk`/`sed` は検索パターン引数と誤検知するため `env-file-read` の対象から外しています。
これは shell 呼び出しの文字列照合とファイル名照合による防御であり、`docs/omp.md` の他ルールと同じくガイダンスです。
Python/Node の一行スクリプトがファイルを直接開く、絶対パス経由で呼ぶなど、意図的な迂回までは防げません。

### 代替ツールのルールを追加する

三 CLI 共通のルール表は `agents/command-rules.json` です。
Claude Code と Codex は `scripts/deny-command-hook.ts`、OMP は `omp/extensions/deny-commands.ts` を通じて、同じ `scripts/command-policy.ts` の判定を使います。
Claude Code と Codex のフック実行には、`scripts/devbox` で導入する Bun が必要です。

| 対象 | 代替手段 | 適用する CLI |
| --- | --- | --- |
| 素の `python` / `python3` | `uv run` / `uvx` | 三 CLI |
| shell による閲覧・検索 | 専用の Read / Grep / Glob 系ツール | Claude Code、OMP |
| 単純な `curl` の Web 取得 | `ax`（最初に `ax agent-context`） | 三 CLI |
| `brew upgrade` | `scripts/brewUpdate` | 三 CLI |
| `.env` 系資格情報ファイルの shell 経由の閲覧 | 読ませない（代替なし） | 三 CLI |

uv、ax、brewUpdate への誘導は、代替コマンドが実行可能な場合だけ発動します。
専用の閲覧・検索ツールの有無は、適用する CLI で区別します。
`curl` は用途を誤判定しないよう、URL 一つと `-f` / `-s` / `-S` / `-L` などによる単純な取得に絞ります。
認証付きリクエスト、更新系 API、ファイル保存、診断、クエリ付き URL などは許可します。
既存スクリプト内のコマンドまでは検査せず、拒否したコマンドを自動で書き換えたり実行したりもしません。
新しいツールを入れただけではルールは増えません。代替できる用途を確認してから登録します。

追加するときは既存の `rules` 要素にならい、`id`、対象の `clients`、代替手段の `replacement`、CLI 別の `reasons` を設定します。
通常は `matcher: "command"` を使い、`commands` にコマンド名（`executables`）と必要ならサブコマンド（`subcommand`）を指定します。対象語が実行ファイル直後に来ない場合（`grep pattern file` のファイル名など）は、直後の一語だけを見る `nextArgPattern` ではなく、実行ファイル以降の全語を見る `anyArgPattern` を使います。
実行可能な代替コマンドは `replacement.type: "command"` と `value`、専用ツールは `type: "native-tool"` で指定します。
条件を満たす最初のルールで拒否するため、理由文には次に使うツールと呼び出し方を明記してください。
単純なコマンド置換は JSON の追加だけで済みますが、`curl` のような用途判定を増やす場合は判定コードの変更も必要です。

変更後は拒否・許可の境界を検証し、SonarQube 用のカバレッジを生成してから品質ゲートを実行します。

```bash
bun test scripts/command-policy.test.ts --coverage --coverage-reporter=lcov --coverage-dir=.agent-msgs/scratch/command-policy-coverage
scripts/sonar-quality-gate
scripts/link
```

OMP は新しいプロセスで起動し直してください。
Claude Code も新しいセッションで確認し、Codex は `/hooks` で変更済み定義を trust してから使います。

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
| debug adapter の差し替え | `omp/dap.json` |
| OMP にだけ追加する常設指示 | `omp/APPEND_SYSTEM.md` |
| OMP extension | `omp/extensions/` |
| machine-global の Jev skill hint | `omp/extensions/jev-skill-hint.ts` |
| machine-global の Jev plan gate | `omp/extensions/jev-plan-gate.ts` |
| machine-global の Jev agent hint | `omp/extensions/jev-agent-hint.ts` |
| machine-global の Jev model hint | `omp/extensions/jev-model-hint.ts` |
| 三 CLI の代替ツール誘導ルール | `agents/command-rules.json` |
| plugin と version | `scripts/omp-plugins` |
| authored skill | `agents/skills/<name>/SKILL.md` |
| 学習レビューの起動方法 | `scripts/omp-learning-review` |
| 学習レビューの週次通知 | `scripts/omp-learning-weekly` と `launchd/com.tyamahori.omp-learning-weekly.plist` |
| 利用効率レビューの起動方法 | `scripts/omp-review` |
| symlink と初期配置 | `scripts/link` |

このガイドと実装が食い違う場合は、上表の実装を正とし、この文書も同じ変更で更新してください。
