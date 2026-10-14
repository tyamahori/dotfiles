# Jev の補助機能と効果測定

TypeSafe（Jev）の systemone API を使う machine-global な補助機能をまとめています。
日常操作は [docs/omp.md](omp.md) を参照してください。

| 機能 | 種類 | 実装 |
| --- | --- | --- |
| Jev PR-review lens shadow | 任意で呼ぶ CLI（`github-pr-review` Skill から利用） | `scripts/jev-pr-lens-shadow.ts` |

## API キーと適用範囲

すべての機能は `scripts/jev-client.ts` の `loadJevApiKey` を共有します。
読み取り順は次のとおりです。

1. プロセスの環境変数 `JEV_API_KEY`（設定されていれば最優先）。
2. 環境変数が無ければ、このマシンの `~/dotfiles/.env`（gitignore 済み）の `JEV_API_KEY` 行。

「常に `.env` だけを読む」という説明は誤りです。環境変数が設定されていれば
そちらが優先されるため、完全に無効化するには `.env` を削除・コメントアウトするだけでなく、
シェルやセッションに `JEV_API_KEY` 環境変数が設定されていないことも確認してください。

`PR-review lens shadow` は `.omp/extensions/` の project-local pilot extension とは別物で、
`import.meta.dir` 基準でリポジトリ root を解決するため、dotfiles リポジトリ外からの呼び出しでも動きます。
`actual` サブコマンドの記録には Jev（API キー）は不要です。

有効化の手順は次のとおりです。

1. https://console.typesafe.ai で API キーを発行します。
2. dotfiles リポジトリ root の `.env`（gitignore 済み、既存）に追記します。

   ```bash
   echo 'JEV_API_KEY=sk-...' >> .env
   ```

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

前述のキー読み取り順を使います（cwd に依存しない
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

- `scripts/jev-pr-lens-shadow.test.ts`
