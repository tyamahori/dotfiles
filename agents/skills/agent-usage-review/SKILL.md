---
name: agent-usage-review
description: Claude Code・Codex・OMP の利用量と実行経路を週次で計測し、context churn、日跨ぎ resume、低 cache hit、ルーティング、subagent、compaction、tool error、prewalk などの非効率を診断する。根拠付きの改善案を項目別承認後に適用し、実動確認と journal 記録まで閉じる正本。「トークン利用量をチェックして」「usage review」「トークン消費を改善して」「利用量レビュー」「omp-review」と言われたときに使う。
---

# agent-usage-review

Claude Code、Codex、OMP の利用を、原則週 1 回の「計測 → 診断 → 提案 → 承認 → 適用 → 検証 → 記録」で改善する。

OMP では人間が任意の cwd から `omp-review [--days N]` を実行する。

`omp-review` は新しい人間向け TUI を起動し、指定された過去 $N$ 日（正の整数、指定がなければ 7 日）の review をこの skill に渡す。

修正の着地先はこのマシンの規範ファイル（`~/dotfiles` の CLAUDE.md、config、hooks、OMP 設定、plugins）なので、適用には必ずユーザー承認を挟む。

自動適用はしない。

## 0. 前回の記録を読む

このサイクルは開始前に `~/dotfiles/agents/skills/agent-usage-review/journal.md` を読む。

同じ指摘を繰り返さず、前回適用した修正が今回の計測期間で効いたかを検証するためである。

journal がなければ、このマシンでの初回として空から始める。

journal はローカル専用である。

セッション ID、費用実測、プロジェクト名などを含みうるため、public な dotfiles リポジトリへ載せない。

## 1. 計測

`omp-review` から受け取った日数で snapshot を作る。

```bash
bash ~/dotfiles/agents/skills/agent-usage-review/scripts/snapshot.sh --days N
```

snapshot は Markdown 一枚を stdout に出す。

snapshot に会話本文や認証情報を混ぜない。
ローカル診断では session ID、費用、ローカルパスを扱い、必要なら journal に記録する。
これらの固有値は public なコミット、共有物、会話への貼り付けから除く。

出力は日次合計（モデル別）、コスト上位セッション、警告フラグ一覧を含む。

合計は [ccusage](https://github.com/ryoppippi/ccusage)（Claude、Codex、Grok、Qwen 対応）、警告フラグは raw JSONL の集計で得る。

データソース:

- Claude: `~/.claude/projects/**/*.jsonl` の assistant メッセージにある `.message.usage`。
  `cache_creation_input_tokens` はコンテキスト書き直し量であり、churn の代理指標となる。
- Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` の `token_count` イベントにある `last_token_usage`。
  `total_token_usage` はセッション内累積値なので、合計すると過大計上になる。
- OMP: OMP が起動・委譲・実行した経路と、設定、plugin、patch、モデル選択、tool error の記録。
  OMP 固有の数値がない項目は、実動経路と設定の照合で評価する。

Claude の assistant レコードは 1 つの API message が content block ごとに複数行へ分割されるため、usage は `.message.id` で重複排除してから集計する。

期間判定もファイルの mtime や task notification ではなく、期間内の実イベントに限定する。

## 2. 診断

まず snapshot、journal、設定、該当セッションを突き合わせる。

数値だけで設定を変えない。

警告フラグが出たセッションは JSONL を直接見て、どの作業、入力、ターン、再開、委譲が原因かを特定する。

OMP の提案では、該当 session、実際に読まれた設定、起動から tool 実行までの経路も確認する。

### Claude Code と Codex

| 警告フラグ | 意味 | 典型修正 |
|---|---|---|
| `days>1` | 人間の typed prompt が日跨ぎ。毎ターン全コンテキストを cache write し直す | セッション衛生ルールの徹底、handoff 手順の改善 |
| `cacheW>1M` | context churn。compaction、長大セッション、巨大ファイルの再読込 | 早期 handoff、bulk はファイルパス渡し、read の offset/limit |
| `big_user_msgs` | 20k 字超の人間入力。インライン貼り付け | `local://` またはファイルパス渡しの規範化 |
| `hit<70%` | Codex の cache 効率低下。並列セッションやコンテキスト作り直し | セッション構成の見直し |
| `final_ctx>200k` | コンテキスト肥大のまま完走 | 早期分割、サブエージェント委譲 |
| `idle_resumes>0` | 1 時間超の中断後、200k 超の context を再開して 100k 超を cache write | handoff を残して新セッションで再開 |

コスト上位セッションも確認する。

警告フラグがなくても、同じ調査を複数セッションで重複した場合や、機械的作業を高コストモデルで実行したルーティング違反はここに現れる。

既存の警告フラグをすり抜ける既知パターンは、常駐ワーカーの文脈累積である。

定期ジョブを受ける長寿命セッションは履歴がジョブごとに単調増加し、ターン単価が数倍に膨らんでから autocompact に入る。

`days=1` と `cacheW` 小のまま進行するため、疑ったらセッションのターン別 context 推移を直接見る。

ジョブ内容が会話履歴に依存しないなら、ジョブ終端でセッションをリセットする。

### OMP

OMP の現行機能と実際の経路の差分を確認する。

確認項目は次のとおりである。

| 項目 | 調査する事実 | 改善を検討する条件 |
|---|---|---|
| config | 実際に読み込まれた config と意図した設定 | 設定が未読、競合、または期待と異なる挙動を生んだ |
| plugin と patch | 有効な固定版、適用中の patch、更新後に新 session が使う内容 | plugin 更新と固定版または patch の整合が崩れる |
| model routing | 各工程で選ばれたモデルと作業の性質 | title や auto-thinking classifier などの補助用途に不適切なモデルを使う、または機械的作業に高コストモデルを使う |
| subagent | 委譲数、担当の独立性、重複調査、統合方法 | 依存する作業を無駄に並列化する、または独立作業を逐次化する |
| compaction と handoff | compaction の発生時点、引き継ぎ、再開後の context | compaction 後に同じ情報を再読込する、または日跨ぎ・長時間中断を resume する |
| tool error | 失敗した tool、引数、復旧経路、同じ失敗の反復 | tool の制約を確認せず再試行する、または設定で防げる失敗が繰り返される |
| prewalk | 計画後の最初の edit/write で低コスト実装モデルへ切り替わったか | 切替が起きない、または切替後の実装が失敗して再作業を生む |
| tiny model | title や auto-thinking classifier などのローカル補助用途での選択と結果 | 補助用途に対して不適切なモデルを選び、分類や題名の品質またはコストを悪化させる |

現行機能がすでに問題を防いでいるなら、新しい規範、hook、plugin、設定を足さない。

前回適用した各修正は、適用前後で比較できる同種の指標と実動経路を使って「改善」「悪化」「判定不能」に分ける。

稼働期間や条件が足りない場合は「判定不能」とし、効果を推測しない。

## 3. 提案

修正案ごとに次の 4 点を明示し、影響度順に並べる。

1. **影響度**: 推定削減量（トークン/週または $/週）または失敗・再作業を減らす具体的な効果。
2. **根拠**: journal、計測値、該当 session、設定、実動経路。
3. **着地先**: 下のマップから選ぶ。
4. **確認方法**: 適用後に実行する最小の実動確認。

着地先マップ:

| 修正の種類 | 着地先 |
|---|---|
| エージェントの行動規範 | `agents/global-instructions.md` |
| 機械的な強制（deny 等） | `claude/hooks/`、settings.json の PreToolUse |
| モデルルーティング、OMP 挙動 | `omp/config.yml`、`omp/APPEND_SYSTEM.md`、extensions |
| plugin の版、patch、導入経路 | `./scripts/omp-plugins` と `omp/patches/` |
| 手順の正本化 | 既存 skill |
| プロジェクト固有の原因 | 当該リポジトリの AGENTS.md、CLAUDE.md、`.claude/skills/`、`.claude/settings.json` |

plugin を更新する提案は、固定版と対応 patch の整合を確認し、両方を満たせる場合だけ出す。

更新後の plugin や patch が新しい OMP session にだけ反映されることも明記する。

原因がプロジェクト固有なら、修正もそのリポジトリに落とす。

一般化できたエッセンスだけをこの skill の診断節や dotfiles の規範へ昇格し、グローバル側へ個別プロジェクトの事情を書かない。

## 4. 承認

提案を項目ごとに提示し、各項目の承認を取ってから適用する。

規範ファイル、config、plugin、patch を無承認で書き換えない。

却下された案と保留された案も journal に一行残し、根拠が変わらない限り次サイクルで再提案しない。

## 5. 適用

承認された項目だけを、既存スタイルに合わせて適用する。

CLAUDE.md などに計測由来の規範を追加する場合は、計測値と日付を添える。

```text
(measured YYYY-MM-DD: <数値と事実>)
```

数値または実動経路の裏付けがない規範は書かない。

複数の変更は論理的に独立した単位へ分けてコミットする。

## 6. 検証

適用後は、各提案で示した最小の実動確認を行う。

設定変更なら実際に OMP を新規起動して読み込まれた設定と対象経路を確認する。

plugin または patch の変更なら、固定版と patch の整合を確認したうえで、新しい session で対象機能を動かす。

モデル routing、subagent、prewalk、tool error、handoff の変更なら、対象の起動経路を実行して意図した分岐、委譲、復旧、引き継ぎが起きることを観測する。

既存の計測ロジックを変更した場合は、対象期間の snapshot を再実行し、出力が一枚の Markdown で機密値を含まないことを確認する。

確認できなかった項目は適用済みとして扱わず、journal に未検証の理由を残す。

## 7. 記録

journal.md の先頭にエントリを追記する。

```markdown
## YYYY-MM-DD
- 計測: <期間、合計、警告フラグの要約>
- 前回比: <前回適用した修正の効果。改善、悪化、判定不能>
- 提案: <根拠と項目別の承認結果>
- 適用: <修正、着地先、実動確認>
- 却下・保留: <案と理由>
```

journal は一次記録で、リポジトリは public である。

知見は次の二層で住み分ける。

- **journal（ローカル）**: セッション ID、費用、プロジェクト名、個別の実行経路などの生の固有値。
- **公開層（コミットする）**: 固有値を落として一般化できた知見。
  新しい警告フラグパターンと典型修正は「2. 診断」の表へ、検出ロジックの改善は snapshot へ、行動規範は着地先マップの規範ファイルへ昇格する。

サイクルを閉じる前に、今回の発見のうち一般化できるものを確認し、昇格分を論理的なコミットで残す。

journal に書いて終わりにしない。

前回比が「判定不能」に続く場合は、稼働期間と比較条件を確認する。

標準周期は週 1 回である。
