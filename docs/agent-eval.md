# Codexの固定タスク評価（agent-eval）

このガイドは、同じ課題をCodexに解かせて結果と所要時間を記録し、既定の設定と`light`プロファイルを比べる手順を扱う。

## まず覚えること

1. 評価は`agent-eval run <課題> --variant <baseline|light>`で1回ずつ実行する。実際にモデルを呼ぶので、利用枠を消費する
2. 結果は`agent-eval summary`で見る。週次の利用量レビューのsnapshotにも同じ表が出る
3. 時間を比べてよいのは、`comparison`列が`comparable`の組だけ
4. 少数の試行なので、本番の作業が速くなる根拠にはしない

初回は「評価を実行する」と「結果を読む」を読む。ほかの節は必要なときに開く。

## 評価を実行する

1. `scripts/link`を実行する（`~/.local/bin/agent-eval`と`~/.codex/light.config.toml`を置くため）
2. 5つの課題を両方の設定で実行する

```bash
for variant in baseline light; do
  for case_id in investigation bug-fix cross-file review continuation; do
    agent-eval run "$case_id" --variant "$variant"
  done
done
```

- `baseline`はプロファイルを指定しない実行、`light`は全ターンに`--profile light`を付ける実行
- `--timeout-seconds N`で全ターン合計の上限を変えられる（1〜7200、既定は1200）
- 1回の実行で記録を1つ書き、標準出力に結果を1行のJSONで出す

| 終了コード | 意味 |
| --- | --- |
| 0 | pass |
| 1 | fail、またはCLIやプロファイルがなくて評価を始めなかった（始めなかったときは記録を書かない） |
| 2 | 引数が不正（CLIを起動しない） |
| 3 | incomplete |

## 5つの課題

エージェントの「完了した」という申告や文面は判定に使わない。各課題は専用のGitリポジトリを新しく作って実行する。

| 課題 | 確かめること | passの条件 |
| --- | --- | --- |
| `investigation` | 読むだけの調査ができるか | 再exportをたどった先の定義ファイルと上限値が正しい。古いドキュメントと未使用のファイルは別の値を持つ。ファイルを変更していない |
| `bug-fix` | 狭い範囲のバグを直せるか | `pageCount`が境界値で正しい値を返し、呼び出し元も正しく動く。変更したのは`src/paginate.ts`だけ |
| `cross-file` | 複数ファイルのAPI変更をやり切れるか | 新しい引数の`formatPrice`と3つの呼び出し元がすべて正しく動く。ほかのファイルを変更していない |
| `review` | 仕込んだ欠陥を見つけ、誤検知しないか | 3つの欠陥をすべて指摘し、誤検知が0件。指摘は内容でなくファイルと行（±2行）で照合する。正しい書き換えも1つ混ぜてあり、そこへの指摘は誤検知に数える |
| `continuation` | 保存済みの会話を再開して、途中の訂正に従えるか | 2ターン目が同じスレッドで続く。訂正後の区切り文字で動き、元に戻すよう指示した`CHANGELOG.md`が変更されていない。1ターン目のほかの要件も残っている |

## 結果を読む

```bash
agent-eval summary
agent-eval summary --since-ms 1767225600000
```

`--since-ms`を付けると、その時刻以降に始めた実行だけを数える。課題、variant、課題の版、実測のCLIとmodelとeffortと設定の組ごとに1行を出す。

| 列 | 内容 |
| --- | --- |
| `pass` `fail` `incomplete` | 実行の結果ごとの件数 |
| `median_pass_ms` | passした実行の所要時間の中央値 |
| `ms_per_pass` | passとfailの所要時間の合計をpass数で割った値。失敗してやり直す時間を含む |
| `comparison` | 反対のvariantと比べてよいか |

時間はエージェントの全ターンの実時間で、ワークスペースの準備と動作確認の時間は含めない。incompleteの実行は時間に入れない。`model`と`effort`は、エージェントの発言でなくCLIのセッション記録（`~/.codex/sessions`）から読む。読めなければ`unknown`、ターンによって違えば`mixed`と記録する。

`summary`が出すのは上の値だけで、速度の差は計算しない。

| `comparison`の値 | 意味 |
| --- | --- |
| `comparable` | 同じ課題の版、CLI、model、設定で、effortだけが違う組がある |
| `no-counterpart` | 反対のvariantの記録がない |
| `incomparable:case-revision` | `scripts/agent-eval-cases.ts`が実行の間に変わった |
| `incomparable:cli-version` | CLIのバージョンが違う |
| `incomparable:model` | modelが違う |
| `incomparable:settings` | provider、承認、レビュー担当、sandbox、service tierのどれかが違う |
| `incomparable:unknown-identity` | 実測値に`unknown`か`mixed`が含まれる |
| `incomparable:same-effort` | effortが同じで、比べる意味がない |

理由は`+`でつないで複数出ることがある。`malformed_records`は壊れた記録の数で、passには数えない。

## lightプロファイル

- 通常の実行で使う: `codex --profile light`、`codex exec --profile light "..."`
- 会話を続けるときも毎回指定する: `codex exec --profile light resume <thread-id> "..."`（付けないと、設定のeffortに戻る）
- 中身は`model_reasoning_effort = "medium"`だけ。既定の`xhigh`は変わらない
- ほかの設定を追加すると、`agent-eval run --variant light`は実行を拒否する（effort以外の違いが比較に混ざるため）
- `~/.codex/light.config.toml`に内容の違う通常ファイルがあると、`scripts/link`は上書きせず、報告だけする

## 記録の場所

| 場所 | 中身 |
| --- | --- |
| `${XDG_STATE_HOME:-$HOME/.local/state}/agent-eval/runs/<runId>.json` | 1実行につき1つの記録。件数の集計に使う |
| `${XDG_STATE_HOME:-$HOME/.local/state}/agent-eval/evidence/<runId>/` | イベント、最終出力、標準エラー、実行後のワークスペース |

- ディレクトリは本人だけが開ける`0700`、記録とログは`0600`で作る
- evidenceにはコマンドや出力がそのまま残るので、公開リポジトリへ写さない
- 記録に残すのは判定の項目名、件数、実測のCLIとmodelなどで、プロンプトと出力の本文は入れない
- 不要になった実行は、`runs/<runId>.json`と`evidence/<runId>/`を消す
- Codex自身のセッション履歴にも通常の実行として残り、利用量の集計に入る

記録の項目は`schemaVersion`、`runId`、`caseId`、`caseRevision`、`variant`、`startedAt`、`elapsedMs`、`outcome`、`incompleteReason`、`exitCode`、`signal`、`identity`、`assertions`、`evidence`。

## 実行の権限と境界

- Codexには設定どおりのsandbox、承認、hook、rulesを適用する。`--dangerously-*`、`--skip-git-repo-check`、`--ignore-rules`、`--ignore-user-config`は付けない
- 子プロセスはshellを通さず引数の配列で起動する。stdoutが32MiBを超えるか時間切れになると、プロセスグループごと止める
- エージェントが書いたコードの動作確認は、`codex sandbox -P :read-only`の中で最小限の環境変数だけを渡して動かす。ファイルの書き込みとネットワーク接続はできないが、読み取りはできる。確認の標準出力は判定を取り出したあと消す
- エージェントの実行後はワークスペースでGitを実行せず、ファイルを直接比べる（`.git/config`を書き換えられていると、Gitが任意のコマンドを実行しかねないため）
- `summary`とsnapshotは記録を読んで数えるだけで、記録の中身をコマンドとして実行しない

## 動作を確かめる

モデルを呼ばない確認は次のテストで行う。

```bash
bun test scripts/agent-eval.test.ts
```

実際のCLIとモデルで確かめるときは、次の手順で`light`がeffortだけを変えることを見る。

1. `scripts/link`を実行する
2. `agent-eval run investigation --variant baseline`を実行する（Codexのモデル呼び出しを確かめる）
3. `agent-eval run investigation --variant light`を実行する
4. `agent-eval summary`を実行し、2行の`effort`が違い、`settings`が同じで、`comparison`が`comparable`であることを見る
5. `agent-eval run bug-fix --variant light`を実行する（`codex sandbox`の中で動作確認が動くことを確かめる）
6. `agent-eval run continuation --variant light`を実行し、`mixed`が出ないことを見る（resumeでもプロファイルのeffortが使われることを確かめる）
7. `agent-eval run bug-fix --variant baseline --timeout-seconds 1`を実行し、終了コード3で`incompleteReason`が`timeout`になることを見る

## 制約

- 試行は少なく、課題も小さい。本番の作業の速度を示す因果の証拠にはならない。継続して比べた結果だけを判断材料にする
- 実行順序やモデルの応答のばらつきは制御していない
- `effort`はCLIが記録した要求値で、APIの内部でどう処理されたかは確かめられない
- レビューの照合は位置だけを見るので、欠陥の近くの無関係な指摘もその欠陥の発見に数える
- 動作確認は敵対的なモデルへの防御ではない。エージェントのコードは確認プロセスの中で動くので、判定の行を偽造できる。防いでいるのは、書き込み、ネットワーク、呼び出し元の環境変数の持ち出しだけ
- `agent-eval`自身が`SIGKILL`で止まると、記録は残らず、Codexが動き続けることがある
- `codex sandbox`を実際に試したのはmacOSだけ。Linuxで起動できなければ`incomplete`になり、sandboxなしには切り替えない
- トークン量は記録に入れない。`evidence/<runId>/turn-*.events.jsonl`には残る

## 困ったとき

| 症状 | 直し方 |
| --- | --- |
| `light.config.toml を読めない`と出る | `scripts/link`を実行する |
| `model_reasoning_effort だけを設定していない`と出る | `~/.codex/light.config.toml`から、ほかの設定を外す |
| `incompleteReason`が`exit-nonzero` | `evidence/<runId>/turn-1.stderr.log`を見る。認証切れなら`codex login`を実行する |
| `incompleteReason`が`harness-error` | `evidence/<runId>/check.stderr.log`か`harness-error.log`を見る |
| `incomparable:cli-version`が出る | 同じバージョンのCLIで両方の設定を実行し直す |
| `malformed_records`が0でない | `runs/`の中で`<runId>.json`の形でないファイルや壊れたファイルを確かめ、不要なら消す |
| snapshotに`取得不能（bun がない）`と出る | `bun`のある`PATH`でsnapshotを実行する |

## 用語

| 用語 | 意味 |
| --- | --- |
| variant | 実行の設定。`baseline`は既定、`light`はプロファイルを指定した実行 |
| 課題の版（`revision`） | `scripts/agent-eval-cases.ts`のハッシュ。fixtureや判定を変えると変わり、変更前の記録とは比べられなくなる |
| incomplete | 判定まで進めなかった実行。時間切れ、中断、異常終了、最終出力なしなどが該当し、passにもfailにも数えない |
