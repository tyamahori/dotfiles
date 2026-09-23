# Jev の補助機能と効果測定

TypeSafe（Jev）の systemone API を使う machine-global な補助機能をまとめています。
日常操作は [docs/omp.md](omp.md) を参照してください。

| 機能 | 種類 | 実装 |
| --- | --- | --- |
| Jev skill hint | 非拘束のヒント注入 | `omp/extensions/jev-skill-hint.ts` |
| Jev plan gate | 非拘束のヒント注入 | `omp/extensions/jev-plan-gate.ts` |
| Jev agent hint | shadow-only（ログのみ、委任には影響しない） | `omp/extensions/jev-agent-hint.ts` |
| Jev model hint | shadow-only（ログのみ、モデル切替には影響しない） | `omp/extensions/jev-model-hint.ts` |
| Jev PR-review lens shadow | 任意で呼ぶ CLI（`github-pr-review` Skill から利用） | `scripts/jev-pr-lens-shadow.ts` |

## API キーと適用範囲

すべての機能は `scripts/jev-client.ts` の `loadJevApiKey` を共有します。
読み取り順は次のとおりです。

1. プロセスの環境変数 `JEV_API_KEY`（設定されていれば最優先）。
2. 環境変数が無ければ、このマシンの `~/dotfiles/.env`（gitignore 済み）の `JEV_API_KEY` 行。

「常に `.env` だけを読む」という説明は誤りです。環境変数が設定されていれば
そちらが優先されるため、完全に無効化するには `.env` を削除・コメントアウトするだけでなく、
シェルやセッションに `JEV_API_KEY` 環境変数が設定されていないことも確認してください。

`skill hint`・`plan gate`・`agent hint`・`model hint` はいずれも machine-global extension で、
cwd に関係なく上記の読み取り順で解決します（呼び出し元リポジトリごとに個別の鍵を置く必要はありません）。
`PR-review lens shadow` は `.omp/extensions/` の project-local pilot extension とは別物で、
`import.meta.dir` 基準でリポジトリ root を解決するため、dotfiles リポジトリ外からの呼び出しでも動きます。
`actual` サブコマンドの記録には Jev（API キー）は不要です。

有効化・無効化の共通手順は次のとおりです。

1. https://console.typesafe.ai で API キーを発行します。
2. dotfiles リポジトリ root の `.env`（gitignore 済み、既存）に追記します。

   ```bash
   echo 'JEV_API_KEY=sk-...' >> .env
   ```

3. `./scripts/link` を実行して対象の `omp/extensions/*.ts` が `~/.omp/agent/extensions/` に
   リンクされていることを確認し、新しい OMP セッションを起動します（どのリポジトリの root から
   起動しても構いません）。

特定のリポジトリだけで無効化したい場合は、そのリポジトリの root に `.omp/config.yml`
（project-local、未作成なら新規作成）を置き、`disabledExtensions` に対象の extension module 名
（例: `extension-module:jev-skill-hint`）を追記します。

## Jev skill hint（machine-global extension）

`omp/extensions/jev-skill-hint.ts`（`~/.omp/agent/extensions` へ配置される machine-global な
仕組み）とは別物です — 前述のとおり、`JEV_API_KEY` は環境変数優先・未設定時のみ cwd に関係なく
このマシンの `~/dotfiles/.env` を固定で見ます。他リポジトリで使う場合も個別に鍵を置く必要はありません。
project-local な `.omp/extensions/`（このリポジトリの root で開いたセッションだけに効く仕組み）とは
別物です。

ターン開始のたびに TypeSafe（Jev）の systemone API へ依頼文と Skill 一覧（名前+説明。
システムプロンプトの `<skills>` から都度抽出するのでハードコードしない）を渡し、合いそうな
候補があれば `<skill_relevance>` ヒントを非拘束の参考情報として注入します。最終的にどの
Skill を読むかはこれまで通りエージェントの判断に委ねます。設計・検証の仕様は
`omp/extensions/jev-skill-hint.ts` のコメントと `omp/tests/jev-skill-hint.test.ts` を
参照してください。

### Jev が使えないとき・無効化する

`JEV_API_KEY` が未設定のときと、API 呼び出しが失敗した（ネットワーク断、認証エラー、
タイムアウトなど）ときは、Claude/Codex の下位モデルが代わりに候補を選びます。
Jev が失敗した場合、そのセッションでは以後 Jev を呼びません。

代替モデルは `anthropic/claude-haiku-4-5`、`@smol`（`omp/config.yml` の `modelRoles.smol`、
現在は `openai-codex/gpt-5.6-luna`）の順に試します。どちらも OMP 本体の認証をそのまま
使うため、追加の鍵は要りません。失敗したモデルはそのセッションの候補から外します。
すべて使えなければヒントを出さず、エラーも表示しません。既存の Skill 選択の動きは
妨げません。

Jev は確率付きの判定を返しますが、代替モデルには「必要な Skill を最大3件、JSON 配列で
挙げて」と頼むだけです。依頼文が「まず〜だけ答えて」のような進め方の指示だと、
Skill 不要と判断して候補を出さないことがあります。

ヒントを完全に止めたい場合は、「API キーと適用範囲」の `disabledExtensions` で
extension ごと無効化します（鍵を外すだけでは代替モデルが動きます）。

### 動作を確認する

複数の Skill が絡む依頼を投げ、応答の直前に `Jev候補(参考、必須ではない): ...` が
挿入されるかを見ます。代替モデルが選んだ場合は `claude-haiku-4-5候補` のように
モデル ID が入ります。Jev 不可の経路は、無効な鍵を渡した単発実行で確かめられます。

```bash
JEV_API_KEY=invalid omp -p --no-session --no-extensions \
  -e ~/dotfiles/omp/extensions/jev-skill-hint.ts "GitHub の PR をレビューしたい"
```

実行後、次節の実測ログに `jevError: true` と `selector: "anthropic/claude-haiku-4-5"` の
行が増えていれば、代替モデルでの選定が動いています。

### 実測ログで効果を測る

`before_agent_start` でのヒント生成結果と、そのターン中に実際に読まれた
`skill://` を突き合わせ、1ターン1行の JSONL として、使われたリポジトリの
`.agent-msgs/scratch/jev-skill-hint-metrics.jsonl`（gitignore 対象、cwd 相対）に
追記します。

| フィールド | 意味 |
|---|---|
| `promptChars` / `rosterSize` | 依頼文の長さ・Skill 一覧の件数 |
| `hintLatencyMs` | 選定（Jev の Call1+Call2 と代替モデル呼び出し）全体のレイテンシ。何も呼ばなかったターンは `null` |
| `accepted` | 採用された候補 Skill 名 |
| `selector` | 候補を選んだもの。`jev` または代替モデルの `provider/id`。すべて失敗したら `null` |
| `circuitOpen` | セッション内で Jev が既に失敗済みで、今回は Jev の呼び出しを省いた |
| `jevError` | 今回の Jev 呼び出しが失敗し、以後 `circuitOpen` になった |
| `fallbackError` | 今回、代替モデルのどれかが失敗した（そのモデルは以後そのセッションで使わない） |
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
`JEV_API_KEY` の読み取り順は上記「API キーと適用範囲」のとおりです。ヒント注入はまだ行わず、shadow
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
追加しません（バックグラウンド実行の一般的な仕組みは
[upstream extensions doc](https://github.com/can1357/oh-my-pi/blob/v18.2.6/docs/extensions.md)
の managed background work 節を参照）。ハンドラの同期部分も全体を try/catch で囲んでおり、
roster 抽出などで何が起きても実タスク発行をブロックしません。

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
machine-global で、`JEV_API_KEY` の読み取り順は上記「API キーと適用範囲」のとおりです。
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
仕組みの対象外で、それは `adversarial-verification` skill が担います。この説明は現在の
`<proposed_plan>` を対象とする実装の説明であり、Plan Mode の全経路で実証済みという意味では
ありません。

計画はすでに表示済み（ターンが終わっている）ため、`jev-skill-hint` のように
`before_agent_start` の戻り値でヒントを差し込むことはできません。代わりに
`pi.sendMessage` を `deliverAs: "nextTurn"`（`triggerTurn` なし）で呼び、ユーザーが計画に
対して次に発言するタイミングでその発言と一緒に配信・表示します。新規ターンを強制
起動しないため、計画提示のたびに追加の推論コストは発生しません。

有効化・無効化の手順とキーの読み取り順は上記「API キーと適用範囲」と同じです。実行時に失敗した
場合はそのセッション内で以後 no-op に切り替わり、失敗ログを
`.agent-msgs/scratch/jev-plan-gate-metrics.jsonl`（呼び出し元リポジトリの cwd 相対、gitignore
対象）に1計画1行の JSONL で残します。

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

`jev-skill-hint` と同じキー読み取り順を使います（cwd に依存しない
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

## 仕様・自動検証の参照先

各機能のふるまいの自動検証は次のテストにあります。実運用での効果測定（採用率・一致率など、
上記の集計コマンドが出す数値）とは別物です — テストは no-op/circuit breaker/ログ書式などの
契約を検証するだけで、実際のヒントの有用性は集計コマンドの実測値で判断します。

- `omp/tests/jev-skill-hint.test.ts`
- `omp/tests/jev-agent-hint.test.ts`
- `omp/tests/jev-model-hint.test.ts`
- `omp/tests/jev-plan-gate.test.ts`
- `scripts/jev-pr-lens-shadow.test.ts`
