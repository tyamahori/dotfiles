# model migration journal

新しいサイクルを上に追記。書式は SKILL.md「記録」を参照。

## 2026-10-06 OMP の task / vision / smol / commit を Claude へ

- 契機: 週次 usage review で Codex 週次枠が逼迫し Anthropic 側に余裕があったため、
  ユーザーが「Claude に移せるものは移す、クロスレビューは維持」と判断した。判定: 判断。
- 変更: `omp/config.yml` の `task` / `vision` を `openai-codex/gpt-5.6-terra` →
  `anthropic/claude-sonnet-5-5`、`smol` / `commit` を `openai-codex/gpt-6-luna` →
  `anthropic/claude-haiku-4-5`。`slow`(reviewer / security-reviewer の override)と
  `advisor` は Claude 作業への別系統レビュー・助言として Codex に据え置き。
  付随して `omp/extensions/jev-skill-hint.ts` の代替モデル `@smol` を
  `openai-codex/gpt-6-luna` 固定に変更(`@smol` が haiku と重複し、Anthropic 障害時の
  別系統退避が消えるため)。`docs/jev.md` とテストを同期。
  公式資料(取得日 2026-10-06): https://www.anthropic.com/claude-sonnet-5-5
  (ID `claude-sonnet-5-5`、Sonnet 5 より高速・低価格)。
- 副次効果: Claude 担当とされた実装の一部を terra subagent が書き、Codex reviewer が
  それをレビューする同系統レビューが解消する。
- 追加(同日、クロスレビュー指摘を受けたユーザー判断): `retry.fallbackChains` の
  `openai-codex/gpt-6-astra` の退避先を `anthropic/claude-fable-5-1` →
  `openai-codex/gpt-6.1-sol`。Codex 枠枯渇時に Claude が Claude 作業をレビューする
  経路を断つ。代償として枯渇中はレビューが止まる。判定: 判断。
- 検証: `omp config get modelRoles` が新値。新規プロセスの `omp -p --no-session`
  で `@task` / `@vision` が `claude-sonnet-5-5`、`@smol` / `@commit` が
  `claude-haiku-4-5`、`@slow` が `gpt-6-astra` で応答。jev テスト 5 pass。
  その後 `scripts/model-pins ack`。稼働中の OMP セッションは再起動が必要。
- 1週間後: Anthropic 5h / 7d 枠の退避発生有無、Codex 週次枠の推移、subagent の
  失敗・再試行の増減を `agent-usage-weekly` で確認する。プロジェクト側の役割既定値を
  Claude へ寄せるかはこの結果を見てから判断する。

## 2026-10-05 codex/config.toml を gpt-6.1-sol へ

- 契機: 週次 usage review で、user 層 `~/.codex/config.toml` の
  `gpt-6.1-sol` / `low` が system 層の `gpt-6-astra` を 10-02 から上書きして
  いたと判明。ユーザーが canonical を実効値へ揃える判断をした。判定: 判断。
- 変更: `codex/config.toml` の `model` を `gpt-6-astra` → `gpt-6.1-sol`。
  `model_reasoning_effort` は `low` 据え置き(公式既定は medium)。
  公式資料(取得日 2026-10-05):
  https://developers.openai.com/api/docs/models/gpt-6.1-sol.md
  (「near-Astra performance at a lower cost」、自分のタスクで Astra と比較せよ、
  effort は low〜max)。同種タスクでの品質比較はまだない。
- 検証: `/etc/codex/config.toml` が canonical への symlink。新規
  `codex exec` が `model: gpt-6.1-sol` / `reasoning effort: low` で応答。
  その後 `scripts/model-pins ack`、`check` は差分なし。
- 1週間後: レビュー round 数と見落とし(後段の Copilot / CI で見つかった指摘)
  を Astra 期間と比べる。悪化なら `gpt-6-astra` へ戻す提案を出す。

## 2026-10-02 plan ロールを Fable 5.1 へ、OpenAI 系を GPT-6 後継へ

- 契機: ユーザーが Fable の使いどころを模索したいとして、`omp.modelRoles.plan`
  を `openai-codex/gpt-6-astra` → `anthropic/claude-fable-5-1` に変更する判断をした。
- 照合: plan/slow 両方を Fable にする案は保留。`task.agentModelOverrides` の
  reviewer / security-reviewer が `@slow` を参照しており、slow まで Claude にすると
  Opus 5.5 の成果物を Claude 系がレビューする形になり、Codex 系クロスレビューの
  規範に反するため。plan だけなら reviewer 経路は変わらない。
  `omp models anthropic` に `claude-fable-5-1`(low〜max)があることを確認。
- 追加(同日、ユーザー承認): OpenAI 系で同じ格の後継があるものを置換。判定: 機械的。
  - `smol` / `commit` と web 退避の `gpt-5.6-luna` → `gpt-6-luna`
  - `anthropic/*` 退避の2番目 `gpt-5.6-sol` と、web 退避の `gpt-5.6`(公式に
    `gpt-5.6-sol` の alias と明記)→ `gpt-6.1-sol`
  - 据え置き: `gpt-5.6-terra`(task/vision/advisor。GPT-6 に Terra 枠がなく、Sol は格上)、
    web 退避の `gpt-5.5`(後継の格が資料で未確認)、`codex/config.toml` の
    `gpt-6-astra`(最新の Astra)。`docs/jev.md` の smol 記述を同期。
  公式資料(取得日 2026-10-02):
  https://developers.openai.com/api/docs/models/gpt-6.1-sol.md 、
  https://developers.openai.com/api/docs/models/gpt-6-luna.md
- 退避: plan は `anthropic/*` wildcard(→ gpt-6-astra → gpt-6.1-sol)に乗る。
  `openai-codex/gpt-6-astra: [claude-fable-5-1]` は slow 用に引き続き有効。
- 検証: `omp config get modelRoles` の plan が新値。新規プロセスの
  `omp -p --no-session --mode json` で `--model @plan` が `claude-fable-5-1`、
  `@smol` が `gpt-6-luna`、`openai-codex/gpt-6.1-sol` が `gpt-6.1-sol` で応答。
  退避チェーンの解決値も新 ID。その後 `scripts/model-pins ack`。
  稼働中の OMP セッションは再起動が必要。
- 1週間後: plan ロール経由の Fable 呼出回数と費用、Anthropic 枠の退避発生有無を
  `agent-usage-weekly` で確認し、slow まで広げるか判断する。smol/commit の
  Luna 置換後に失敗・再試行が増えていないかも見る。

## 2026-09-29 未 ack 差分の再照合と Opus 5.5 の 1 週間後確認

- 契機: commit 時の post-commit hook が5件の差分を報告
  (`claude.model` / `omp.modelRoles.default` を sonnet-5 → opus-5-5、
  `omp.modelRoles.plan` の `:low` が外れる、`omp.modelRoles.web` と
  `omp.modelRoles.tiny` が (none) → 値あり)。
- 照合: `~/.local/state/model-migration/last-reviewed.tsv` の mtime は
  2026-09-15 のままで、中身は 09-20 と 09-22 のエントリより前の値だった。
  両エントリには「ack 実行、直後の check は差分なし」とあるが、マーカーには
  反映されていない。09-18 の巻き戻りと同じ症状で、原因は今回も特定できず保留。
  - default/plan/claude.model: 09-20・09-22 のエントリで承認・適用済み。新規判断なし。
  - web/tiny: 9e02a1f(09-25)で廃止キー `providers.webSearchOrder` /
    `providers.tinyModel` を `modelRoles.web` / `modelRoles.tiny` へ移した
    設定移行(omp://settings.md の自動移行対象)。web の先頭は従来の `google`
    のまま。tiny は `lfm2-350m` → `lfm2.5-350m` で、`omp tiny-models list` の
    同梱キーは lfm2.5 系だけ。判定: 機械的。セッションタイトル生成専用で、
    指示文への影響なし。
  - 公式資料の新規収集: 対象外。モデル自体の新規切替がないため。
- 提案: 変更提案なし。
- 検証: 新規プロセスで実測。`claude -p` の `modelUsage` は `claude-opus-5-5`
  のみ。`omp -p --no-session` の default は `claude-opus-5-5`、`--model @plan`
  は `gpt-6-astra`。`omp config get modelRoles` の web/tiny は pin と一致。
  その後 `scripts/model-pins ack` を実行し、mtime の更新と check の exit 0 を確認した。
- 09-22 エントリの 1 週間後(OMP main、`agent-usage-weekly` の 09-15..21 と
  09-22..28 を比較):
  数値の実体は machine-local の週次レポートにあり、ここには比だけを残す。
  | 指標 | Opus 5.5 週 ÷ Sonnet 5 週 |
  | --- | --- |
  | calls | 0.42 |
  | sessions | 0.85 |
  | 費用合計 | 0.58 |
  | 費用 / call | 1.37 |
  | 費用 / session | 0.69 |
  | cache_read_share | 96.0% → 95.7% |
  | output / call | 0.82 |
  | cache_write / call | 0.96 |
  | cacheWrite >50k の比率(churn) | 52% → 37% |
  | compaction 回数 | 0.29 |
  判断: 1 回あたりの単価は単価表どおり約 1.4 倍に上がったが、セッションあたりの
  費用は下がった。ただし週の作業量(calls が 0.42 倍)と内容が違うため、効果の量は
  不明とする。cache hit は据え置き。thinking `medium` 固定(09-23)の後、
  churn は 52% → 37% に下がり、固定の狙いと矛盾しない。品質・再作業は計測がなく
  判定できない。悪化の根拠がないため、戻す提案はしない。Claude Code 本体の
  利用は当週ゼロで比較対象がない。
- 付随の発見: 09-28 のスナップショットの「local tiny model」節が「取得不能」に
  なっている。原因は `agents/skills/agent-usage-review/scripts/snapshot.sh:614`
  が廃止キー `tinyModel:` を grep していることで、`modelRoles.tiny` を読むよう
  直す必要がある。今回は修正しない(agent-usage-review 側の候補)。
  → 10-05 の 0077129 で修正済み。10-06 の snapshot で `configured tiny model:
  local/lfm2.5-350m` が出ることを確認した(10-05 09:30 のレポートは修正前の実行)。
- 2 週目追記(10-06、OMP main、`agent-usage-weekly` の 09-15..21 と 09-29..10-05):
  main の calls が Sonnet 週とほぼ同量になり、1 週目より比較条件が揃った。
  | 指標 | Opus 5.5 2週目 ÷ Sonnet 5 週 | (参考)1週目 |
  | --- | --- | --- |
  | calls | 0.97 | 0.42 |
  | sessions | 1.19 | 0.85 |
  | 費用合計 | 1.11 | 0.58 |
  | 費用 / call | 1.14 | 1.37 |
  | 費用 / session | 0.93 | 0.69 |
  | output / call | 0.86 | 0.82 |
  | cache_write / call | 0.66 | 0.96 |
  | cache_read_share | 96.0% → 96.8% | 95.7% |
  | cacheWrite >50k の比率(OMP 全体) | 52% → 17% | 37% |
  判断: 同量の作業で main 費用は約 1.1 倍に収まった。単価差より小さいのは、
  output / call と cache_write / call が下がったため。churn は 3 週連続で下がり、
  thinking `medium` 固定の狙いと矛盾しない。ただし当週は業務リポジトリの Issue 群を
  terra / sonnet subagent へ大量委譲していて(subagent calls が Sonnet 週の約 6 倍)、
  main の 1 call あたりの負荷が軽かった可能性がある。churn と compaction
  (約 1.4 倍)は subagent を含む OMP 全体の値。品質・再作業は今回も計測なし。
  悪化の根拠がないため、Opus 5.5 と `medium` を維持し、戻す提案はしない。

## 2026-09-22 デフォルトモデルを Opus 5.5 に変更

- 契機: ユーザーが「Opus5.5がリリースされた。デフォルトモデルをOpus5.5に変えて
  検証したい」と明示指示。
- 収集: `platform.claude.com/docs/en/models/overview`、
  `.../models/opus-5-5/migration-guide`、`.../models/opus-5-5/whats-new-opus-5-5`
  (以上いずれも2026-09-22取得)、Claude Code CHANGELOG 2.1.280(インストール済み
  バージョンと一致、「Added Claude Opus 5.5 (`claude-opus-5-5`), now the default
  Opus model」)、`code.claude.com/docs/en/settings-reference.md`(2026-09-22取得)、
  oh-my-pi リリースノート v18.2.9(インストール済みバージョンと一致、「Updated
  server-side fallback documentation and logic to target claude-opus-5-5」
  「Added support for claude-opus-5-5 to model priority registry」)。
  API ID: `claude-opus-5-5`。Pricing $4/$20 per Mtok(Sonnet5比 $2/$10 から上昇)。
  既定 effort は `medium`(Sonnet5の`high`と異なる)。Retirement not sooner than
  2027-09-22。
- 照合:
  1. `claude/settings.json:427` `.model` — `claude-sonnet-5` を使用中。判定:判断
     (ユーザー明示指示)。
  2. `omp/config.yml:36` `modelRoles.default` — 同上、Claude Code側と揃える運用
     慣行のため追随。判定:判断。
  3. `omp/config.yml:40-41` `retry.fallbackChains` の `anthropic/claude-sonnet-5`
     専用チェーン(`→ openai-codex/gpt-5.6-terra`)— default切替後どのロールにも
     マッチせず孤立する。判定:判断(要選択、機械的に自動移行できない)。
  4. `claude/settings.json` トップレベル `effortLevel` — settings-reference.md
     917行目「Opus 5.5 and models released after it ignore it and start at
     their own default until you save a level for them, which `/effort` writes
     under `modelSettings`」。dotfilesの`claude/settings.json`はユーザー設定
     ファイル扱いのため該当。現状 `medium` 指定はOpus5.5には効かず、Opus5.5自身の
     既定(medium)にたまたま一致しているだけ。判定:機械的な仕様上の事実、対応は
     判断。
  5. 旧モデル(Sonnet5)固有の回避策棚卸し: `agents/global-instructions.md`、
     `agents/measured-notes.md` を grep、Sonnet5/Fable5.1固有のワークアラウンド
     記述なし。唯一の近傍規範「mid-sessionの`/model`/`/effort`切替禁止」は
     キャッシュ衛生の一般則でOpus5.5にも引き続き有効、削除候補なし。
- 提案と承認: 上記3・4についてユーザーに選択肢を提示(`ask`)。
  - fallbackChains: 「キーごと削除しwildcard `anthropic/*`(astra→sol)に委ねる」
    を選択(Opus5.5は長時間エージェント作業向けの重量級モデルであり、既存の
    軽量退避(terra)より重量級wildcardの方が品質面で自然という判断)。
  - effortLevel: 「`modelSettings.claude-opus-5-5.effortLevel: medium` を明示
    追加」を選択(将来Opus既定effortが変わっても意図(medium)を維持するため)。
  - 1・2は指示自体が承認。
- 適用:
  - `claude/settings.json`: `.model` を `claude-opus-5-5` に変更、
    `modelSettings.claude-opus-5-5.effortLevel: "medium"` を新規追加。
  - `omp/config.yml`: `modelRoles.default` を `anthropic/claude-opus-5-5` に変更、
    `retry.fallbackChains` の `anthropic/claude-sonnet-5` キーを削除
    (`openai-codex/*` チェーン内の退避先としての `anthropic/claude-sonnet-5`
    は変更なし、無関係のため維持)。
- 検証: 新規プロセスで実測。`claude -p "reply with exactly OK" --output-format
  json` の `modelUsage` が `claude-opus-5-5`(contextWindow 1000000、
  maxOutputTokens 128000)を返した。`omp -p --no-session --mode json "reply
  with exactly OK"` の `message.model` が `claude-opus-5-5`
  (`provider: anthropic`)を返した。検証後 `scripts/model-pins ack` を実行、
  直後の `scripts/model-pins check` は差分なし(exit 0)。
- 1週間後: 2026-09-29 予定。`agent-usage-weekly` でコスト($4/$20への上昇分)・
  品質・応答速度の変化を確認し、`effortLevel: medium` の妥当性(Opus5.5の
  effort再スイープ、migration guide推奨)を再検討する。
- 09-23 追記(適用): OMP の `defaultThinkingLevel` を `auto` から `medium` に固定。
  契機は Claude blog「what a task costs on Opus 5.5」(effort 変更でキャッシュが
  消える)。session jsonl 557 件(08-18〜09-23、Anthropic 18,334 ターン)で、
  `auto` の解決 effort が変わった直後の 161 ターンは cache hit 中央値 29%
  (無変化 17,283 ターンは 99%)、104 回がほぼ全損(1 回約 87K トークン再書込)、
  全 cache write の 8.1%。09-09 の「cache hit は問題なし」は全体平均で見た判断
  だった。Opus 5.5 自体の変化サンプルは 1 件のみ。09-29 の再検討で固定前後の
  cache hit と出力トークンを比較する。

## 2026-09-20 plan ロールをフルエフォート Astra に統一

- 契機: ユーザーが会話中で「計画とレビューのときはフロンティアモデルを使いたい」と
  明示。照合したところ `modelRoles.reviewer` 系(`task.agentModelOverrides.reviewer`
  /`security-reviewer`)は既に `@slow`=フルエフォート `openai-codex/gpt-6-astra` を
  使用済みで対応不要だった。`modelRoles.plan` のみ `openai-codex/gpt-6-astra:low` と
  エフォート抑制がかかっており、計画品質がレビュー品質に対して劣っていた。
  モデル自体の切り替えではなく、既存ピン(Astra)のエフォート修飾子のみの変更のため、
  公式資料の新規収集は対象外(モデル一覧・移行ガイドの再照合は不要と判断)。
- 照合: `omp/config.yml:33`。判定は「判断」(運用意図の選択、公式資料の推奨とは無関係)。
- 提案と承認: ユーザーに `:low` を外すか現状維持か選択肢を提示し、「外す(フルエフォート)」
  を選択(本会話内で確認済み)。
- 適用: `omp/config.yml` の `modelRoles.plan` を `openai-codex/gpt-6-astra:low` から
  `openai-codex/gpt-6-astra` に変更し、意図をインラインコメントで記録
  (commit a3a3744)。
- 検証: 新規プロセスで実測。`omp -p --no-session --model @plan --mode json
  "reply with exactly the word: ok"` の `message.model` が `gpt-6-astra` を返した
  (旧来 `:low` 付きのロール名は解決済みモデルIDに現れないため、config側の修飾子除去
  そのものは設定ファイルの目視確認が根拠)。検証後 `scripts/model-pins ack` を実行、
  直後の `scripts/model-pins check` は差分なし(exit 0)。
- 1週間後: 2026-09-27 予定。`agent-usage-weekly` の plan/task ロールのコスト・
  トークン消費の変化を確認する。

## 2026-09-18 ack マーカー消失の復旧(新規レビューなし)

- 契機: `scripts/model-pins check` が `claude.model` と
  `omp.modelRoles.default` の2件を `claude-fable-5-1 -> claude-sonnet-5` と
  報告(exit 1)。実際の設定は既に09-15エントリで承認・適用済みの値
  (`claude-sonnet-5` / `anthropic/claude-sonnet-5`)で、モデルピンの
  新規変更ではない。
- 照合: `~/.local/state/model-migration/last-reviewed.tsv`
  (machine-local、git管理外)の mtime が Sep 12 07:12 で、内容も
  09-15エントリ適用前の値(`claude-fable-5-1`)のままだった。09-15
  エントリは「検証後`ack`実行、直後の`check`は差分なし」と記録して
  いるが、マーカーの実体はその適用を反映していない。ackコマンドが
  当時実行されなかったか、実行後に何らかの理由でファイルが古い内容
  へ巻き戻ったかは特定できず、未調査として保留する(09-11エントリの
  マーカー消失事例と同種だが、今回は消失ではなく内容が古い状態への
  巻き戻りで症状が異なる)。
- 適用: なし(指示文・設定への変更なし。09-15エントリの決定を変更しない)。
- 検証: 新規プロセスで実測。OMP `omp --mode rpc --no-session --model @default
  --no-title` の `get_state` が `model.id: claude-sonnet-5` を返した
  (推論要求なし)。Claude Code は実際に
  `claude -p "reply with exactly the word: ok" --output-format json` を
  実行し、`modelUsage` のキーが `claude-sonnet-5` と補助呼び出しの
  `claude-haiku-4-5-20251001` のみで、fable系の消費が無いことを確認した。
  検証後 `scripts/model-pins ack` を実行、直後の `scripts/model-pins check`
  は差分なし(exit 0)。
- 1週間後: 対象なし(ピン変更なしのため)。

## 2026-09-17 障害・使用量制限時の退避先を用途に合わせる

- 承認: 通常の Sonnet 5 は Terra へ、計画・難しい処理の Astra は Fable 5.1 へ退避する。他のモデルの退避先は維持し、今後の変更箇所をまとめる。
- 適用: `omp/config.yml` の `modelRoles` と `retry` を隣に配置し、Sonnet と Astra のモデル別 chain を追加した。既存の provider wildcard は維持。使用量監視の拡張も実効 `retry.fallbackChains` を参照し、クラウドの退避先の固定配列を削除した。
- 公式資料（取得日 2026-09-17）:
  - https://developers.openai.com/api/docs/models/gpt-5.6-terra.md — Terra のモデル ID と、旧 mini 相当の位置付けを確認。
  - https://platform.claude.com/docs/en/models/overview — Fable 5.1 のモデル ID を確認。
  - https://github.com/can1357/oh-my-pi/blob/v18.2.2/packages/coding-agent/src/session/retry-fallback-chains.ts — モデル別キーが provider wildcard より優先されること、思考強度なしのキーが同じモデルの各強度に適用されることを確認。
- 保持: 通常モデル、plan の `low`、他のロール、共通指示は変更しない。役割の割り当てを変えないため、`model-pins` の基準更新も行わない。
- 検証の制限: 全 Bun テストと変更した TypeScript の lint は成功。SonarQube Gate は Docker daemon のソケットへ接続できず未完了。Docker を起動した環境で全テストのカバレッジ生成から再実行するまで、Gate 通過とは扱わない。
- 検証: 新規 OMP プロセスで本体 resolver の6経路を確認。使用量の SQLite fixture を使い、Sonnet から Terra への切替を実際に実行した。推論要求や実際の障害・利用枠枯渇は発生させていない。
- 運用上の範囲: 使用量監視と共用する退避元は思考強度なしのモデルキーと provider wildcard に統一する。より細かいキー形式を使う場合は拡張の resolver も変更する。反映には OMP の再起動が必要。
- 1週間後: 次回の利用量レビューで退避後の失敗・再試行と利用枠を確認する。今回の変更だけによる品質・消費量の改善は未計測。

## 2026-09-15 既定モデルを Fable/Astra → Sonnet に降格し、難所だけ自動escalationへ

- 契機: Fable週次枠が100%消費、Codex週次枠も80%消費の状態でユーザーから相談。
  「既定をFable/Astraに保ったまま簡単な作業だけ自動降格」は不可能(セッション単位で
  固定されるモデルにはターン単位の難易度分類器がなく、判定した時点で既に重い方の
  単価がかかる非対称性がある)と説明し、「既定を軽くし、難所だけ自動で重い方へ」の
  方向で合意。ユーザー承認: 「やってみて。ダメだったら戻せばいい」。
- 読んだソース: `~/.claude/cache/model-catalog/*-cc.json`(取得日2026-09-15、Claude Code
  自身がfetchした一次情報)。Fable = "most capable...draws down usage much faster than
  Opus"、Sonnet = "most efficient for everyday tasks"。`~/.claude/cache/changelog.md`で
  auto mode classifierが権限承認専用でモデル階層切替とは無関係と確認(Web検索は
  今回サインアップ要求で失敗、changelogの直接読解で代替)。`~/.claude/agents/context-explorer.md`
  の`model: haiku`実例でsubagentごとのモデルpinが実装済み機能であることを確認。
- 提案:
  1. `claude/settings.json` `.model`: `claude-fable-5-1` → `claude-sonnet-5`(判断)
  2. 難所自動委譲用に`~/.claude/agents/deep-solver.md`を新設、`model: claude-fable-5-1`
     をpinし、root-cause診断/アーキ判断/セキュリティ・データ損失リスク/高リスクレビュー
     に限定したdescriptionでSonnetからの自動委譲を発火させる(判断)
  3. `omp/config.yml` `modelRoles.default`: `anthropic/claude-fable-5-1` →
     `anthropic/claude-sonnet-5`(判断)
  4. `omp/config.yml` `modelRoles.plan`/`slow`は現状維持(Plan Mode・reviewer/
     security-reviewerが既に`@slow`=Astraへ自動ルーティングする設計を活かす、
     変更なしの理由あり)
- 適用(承認済み): 1〜3を適用。4は変更なし。
- 却下・保留: なし。
- 検証: `scripts/model-pins check`で意図した2件の差分のみを確認(claude.model、
  omp.modelRoles.default)。OMP側は`omp --mode rpc --no-session --model @default
  --no-title`の`get_state`で`model.id: claude-sonnet-5`を確認(推論要求なし)。
  Claude Code側は`claude doctor`で設定ファイルの構文エラーなしを確認したうえで、
  実際に`claude -p "reply with exactly the word: ok" --output-format json`を実行し、
  `modelUsage`が`claude-sonnet-5`(補助呼び出しは`claude-haiku-4-5`)であることを
  実測確認。検証後`scripts/model-pins ack`実行、直後の`check`は差分なし(exit 0)。
  `deep-solver.md`は新規サブエージェント定義でmodel-pins追跡対象外のため、
  実際の自動委譲発火は今後の実利用で確認する。
- 1週間後: 9月22日以降、`agent-usage-weekly`でClaude Code・OMP双方の週次Fable/Astra
  消費比率、成功タスク当たりコスト、`deep-solver`委譲回数と的中率(委譲すべきでない
  簡単なタスクへの誤発火がないか)を変更前(〜09-15)と比較する。悪化または
  難所判断の質低下が確認できたら、既定を戻す前に悪化した値と復帰対象を提示し
  承認を得る。

## 2026-09-13 指示レビューの承認項目を適用

- 根拠: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra と既存の Codex・Claude 履歴。調査範囲と限界は `.agent-msgs/scratch/2026-09-13-instruction-audit.json`。
- 承認: 提案1〜4に対するユーザーの「すすめて」。任意案の PR 応答の承認境界は変更しない。
- 適用: AGENTS の引き継ぎ先を `.agent-msgs/handoff/` に統一。モデル移行レビューを差分中心にし、3 skill の詳細を references へ移動。PR レビューと Codex HTML レポートの発火条件を限定。
- 保持: docs/ops の保護、モデルピン、PR 応答の項目別承認、安全・品質条件。vendored natural-japanese の差分は local.patch に含めた。
- 検証: Bun 29 pass / 0 fail、SonarQube Gate passed。上流基準へ local.patch を適用し、入口と新規4参照の完全一致を確認。新規 OMP セッションで5 skill と詳細参照を読み、quick/full/score と依頼別の振り分けを確認した。
- 証跡: `.agent-msgs/scratch/2026-09-13-skill-verification.json`。lint の均質なリズム等の指摘は手順文と原文保持のため残し、追加した対比表現だけを修正した。
- 未計測: 実利用のトークン削減と品質同等性。入口のバイト数減少をその代用にはしない。次回利用量レビューで再読回数・誤発火・必要な手順の読込漏れを確認する。

## 2026-09-12 Astra plan の low を検証し、レビュー済み基準へ反映

- 対象: `omp.modelRoles.plan` の `openai-codex/gpt-6-astra:medium` → `:low`。
  9月10日の承認済み変更（`5e7d66e`）を確認した。他のピンは差分なし。
  開始時の基準ファイルは `medium` で、9月11日の記録とは一致していなかった。基準が変わった経緯は未調査。
- 公式資料（取得日はいずれも2026-09-12）:
  - https://developers.openai.com/api/docs/models/gpt-6-astra.md — `low` と `medium` は対応値。
  - https://developers.openai.com/api/docs/guides/reasoning.md — 低い effort は速度とトークン消費を優先し、高い effort は品質を優先する。ローカルでの品質同等性は示さない。
  - https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md — `none` / `minimal` 以外からは実効 effort の維持を推奨。`medium` → `low` は必須移行ではなく、消費を抑えて様子を見る運用判断。
  - https://developers.openai.com/codex/config-reference → https://learn.chatgpt.com/docs/config-file/config-reference — `model_reasoning_effort` の対応値に `low` と `medium` を掲載。
- 取得の制限: scout の `ax agent-context` はIDEの対象プロジェクト制限とタイムアウトで実行できず、専用 read で取得した。公式URLの取得失敗はなし。
- 提案・採否: 設定・指示・Skillの変更提案なし。承認済みの `low` を維持する。効果の確定は計測待ちとし、他ロールへ展開しない。
- 規範の棚卸し: 共通指示、OMP追記、管理下の22 Skillを規範群ごとに照合した。
  - マシンの事実、実測ルール、書き手の好みは維持。eval利用は `5e3f8e8`、セッション中のモデル・effort切替を避ける規範は `7a818bd` に独立した導入理由があり、今回の effort 変更だけでは削除しない。
  - `7b92c8d` の進捗・スコープ規範、`a33d261` の散文・停止原因・検証規模、`3916775` の着手判断は、現在も使うFable／Astraへの対応。旧モデルだけの回避策と判断できず、削除は保留。
  - 上流から取り込んだ文章規範の個別理由や、コミット本文のない `7d51b49`・`34ad63c` で説明できない規範は保留。全規範の追加理由を確認できたとは扱わない。
- 実動確認: 新規OMPプロセス（18.1.17）の `omp config get modelRoles --json` で plan が `:low`。
  続けて `omp --mode rpc --no-session --model @plan --no-title` を起動し、`get_state` が `openai-codex/gpt-6-astra` / `thinkingLevel: low` を返した。
  新規セッションのコマンド一覧に `skill:model-migration-review` があり、system promptにも掲載されていた。メッセージ数は0で、モデルへ推論要求は送っていない。
  短縮版 `# OMP delegation` の読込みも確認した。検証用プロセスは終了済み。
- 基準更新: 検証後に `scripts/model-pins ack` を実行。直後の `scripts/model-pins check` は差分なし（exit 0）。
- 1週間後: 9月17日以降、`agent-usage-weekly` の同種タスクについて、変更前（9月3〜9日）と変更後（9月10〜16日）の成功タスク当たり総トークン、再試行、再作業、利用枠の減少を比較する。
  9月12日の指示短縮も比較条件を変えるため、effort単独の効果とは断定しない。数値不足や品質悪化の判定不能は効果不明とし、悪化を確認した場合も復帰対象を提示して承認を得る。

## 2026-09-11 ack マーカー消失の復旧(新規レビューなし)

- 契機: post-commit hook が全ピンを `(none) -> 現在値` と報告(`scripts/model-pins check` exit 1)。原因は `~/.local/state/model-migration/last-reviewed.tsv`(machine-local、git 管理外)が消えていたこと。実際のモデルピン変更は無し。
- 照合: `scripts/model-pins show` の現在値を本 journal の 2026-09-05・2026-09-10 エントリの適用結果と1件ずつ突き合わせ、全項目が一致(claude=claude-fable-5-1、codex=gpt-6-astra/low、omp.modelRoles.default=anthropic/claude-fable-5-1、plan=...:low、他ロールは 09-05 基準のまま変更なし)。収集・提案・承認の新サイクルは不要と判断。
- 適用: なし(指示文・設定への変更なし)。
- 検証: `scripts/model-pins ack` でマーカーのみ再作成。直後の `scripts/model-pins check` は差分なし(exit 0)。
- 1週間後: 対象なし(ピン変更なしのため)。

## 2026-09-10 Astra plan の effort を low に変更

- 承認済み変更: `omp.modelRoles.plan` の `gpt-6-astra:medium` → `gpt-6-astra:low`。消費を抑えるためのユーザー指定。他ロールと指示文は変更しない。
- 公式資料（2026-09-10取得）: https://developers.openai.com/api/docs/guides/reasoning 。低い effort は速度とトークン節約を優先する。`medium` が `xhigh` より消費するという一般則は確認できない。
- 公開検索: Astra、medium、xhigh、usage と Reddit／X を検索したが、該当する比較投稿を特定できなかった。消費逆転の主張は計測待ちとする。
- 検証: 設定変更のみ。新しい OMP セッションでの解決済みロールと消費削減効果は未確認。再起動後に確認する。既存の未確認ピンを含むため `model-pins ack` は実行しない。
- 1週間後: 同条件のタスクで総トークン・再試行数・利用枠の減少を比較する。現時点では効果不明。

## 2026-09-05 claude-fable-5-1 / gpt-6-astra (初回・基準づくり)

- 契機: ループ新設。直前の切替は omp `default` → `claude-fable-5-1:high`、
  codex `model` → `gpt-6-astra`(`model_reasoning_effort = low`)、omp
  `plan`/`slow` → `gpt-6-astra`。`scripts/model-pins` の基準はまだ無く、
  `check` は全ピンを `(none) ->` で報告。
- 読んだソース(取得日 2026-09-05): Anthropic models overview、fable-5-1
  overview / migration-guide / whats-new、prompting-claude-fable-5-1、
  claude-prompting-best-practices、Claude Code CHANGELOG。OpenAI
  models/gpt-6-astra、guides/latest-model、guides/reasoning、API changelog、
  Codex CLI changelog、Codex config-reference。未取得: Codex config-reference
  に `model_reasoning_effort` の項・既定値なし。`ax` は使えず URL 直読みで代替。
- 提案:
  - 機械的(照合結果は全て変更なし): Fable 5.1 の `tool_choice` any/tool 拒否、
    adaptive thinking 固定(手動 budget は 400)は dotfiles に該当設定なし。omp は
    `defaultThinkingLevel: auto` / `autoThinkingMaxEffort: high` で整合。Astra の
    `none` effort 廃止・temperature/top_p 非対応は codex `low` で抵触なし。
  - 判断: (1) omp `modelRoles.plan: openai-codex/gpt-6-astra` に effort 指定
    なし。公式 reasoning ガイドは複雑な計画・判断に medium を推奨。`:medium`
    を付けるか。(2) Fable prompting は独立ツール呼出しの batch 化を推奨。omp の
    system prompt は既に指示済み、`agents/global-instructions.md` には無い。
    Claude Code / Codex 向けに1行足すか。(3) codex `model_reasoning_effort =
    low` は移行ガイド「現在の実効 effort を維持」を根拠に据え置き(config.toml
    のコメントに理由あり)。(4) Fable の「長いツール作業で進捗更新が少ない」は
    global-instructions「Say what you're doing, then recap」で既に対処済み。
  - 計測待ち: Astra の「指示ファイルへの感度上昇・詳細な整形・subagent 委譲の
    減少・テスト範囲の拡大」、Fable 5.1 の長時間 agentic 作業の改善。
    `agent-usage-weekly` の Codex tool call 数・テスト実行回数・subagent 起動
    数、常駐指示サイズの影響を次週に見る。
- 適用(承認済み): (1) omp `modelRoles.plan` を `openai-codex/gpt-6-astra:medium`
  に変更。(2) `agents/global-instructions.md` Working style に「Batch independent
  tool calls」を追加。(3)(4) は据え置き。
- 却下・保留: 25k token の reasoning/output 予約は API 利用者向けで CLI では
  対象外。Codex CLI 0.153.1-0.153.4 の Astra 修正は適用済み版で確認のみ。
  09-07 追記(保留): reviewer(`@slow` → astra、effort 未指定=medium)を
  reasoning guide の「code/security review は xhigh」に合わせ `slow: ...:xhigh`
  にするか。`task` の astra 化と同じ週次数値で判断する。役割分担そのものは
  公式特性と整合(default=fable は委譲・推測方針に合う、plan=medium 推奨どおり)。
- 検証: 別の新セッションで skill 発火を確認し、22:01 に `scripts/model-pins ack`
  実行。`check` は差分なし(exit 0)。基準値は `plan: ...:medium` を含む現在値。
  09-09 追記(適用): 上の「`defaultThinkingLevel: auto` で整合」は誤記。
  `default: ...:high` のサフィックスが auto を上書きし、直近セッションは
  configured=high 固定だった(session jsonl の `thinking_level_change`)。
  ClaudeDevs の cost 記事(effort をタスクに合わせる)を機に `:high` を外し、
  auto + `autoThinkingMaxEffort: high` を実際に効かせる。cache hit は既に
  cacheRead ≫ input で問題なし。Claude Code / Codex 側は変更なし
  (Fable 5.1 は effortLevel 未設定=high が公式既定、Astra は対象外)。
  09-10 追記(適用): Anthropic の cost 最適化 3 資料(cookbook cost-optimization、
  docs optimizing-for-cost-and-intelligence、blog reducing-cost)を dotfiles と
  照合。Fable 5.1 は DRB-II で low/medium/high の品質差がほぼ無く費用だけ
  約 1.5 倍に増える公表値があり、「自分のモデルで測れ」とある。Claude Code の既定 effort を
  `claude/settings.json` の `effortLevel: medium` に置き、settings.local.json の
  `high` を外した。cache 衛生の 1 行(mid-session の `/model` `/effort` 切替禁止)
  を global-instructions に追加。指示文の強調語監査・MCP tool 定義の遅延読込・
  安価モデルへの委譲は既存設定で充足、変更なし。
- 1週間後: agent-usage-review で Claude Code の成功タスク当たりコスト・turns・再作業を
  `high` 期(〜09-09)と比較し、悪化なら `effortLevel` を戻す。

## YYYY-MM-DD <from> → <to>

- 契機:
- 読んだソース(URL・取得日):
- 提案:
- 適用:
- 却下・保留:
- 検証:
- 1週間後:
