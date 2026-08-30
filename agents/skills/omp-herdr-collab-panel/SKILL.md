---
name: omp-herdr-collab-panel
description: omp-herdr-collab の拡張。ユーザーが review-mode panel を明示したときだけ使う Herdr 専用の二人レビュー。独立 FINDINGS バリア・CROSS-CHECK・CONSOLIDATED・group fanout の契約を持つ。単独では読まず、必ず omp-herdr-collab とあわせて読む。
---

# omp-herdr-collab-panel

`omp-herdr-collab` の panel 拡張。共通の不変条件・revision 規約・transport・
許可境界・trust boundary はすべて base skill が正本で、ここには panel 固有の
差分だけを書く。panel はユーザーが `review-mode: panel` を明示したときだけ
起動する。自動的なリスク判定や任意人数への拡張はしない。

## 役割

- reviewer は正確に二人。実装者を含む三 identity と Herdr pane 名はすべて異なる。
- 両 reviewer は fresh context。reviewer-a は実装者と異なる model family、
  reviewer-b は実装者と同じ model family とする。panel に
  `independence-exception` はない。
- reviewer-a は実装者からの独立性を担う `correctness-contract` lens。
  reviewer-b は同系統の fresh な補完役として、対象の failure mode から
  `security`、`data-integrity`、`concurrency-state`、
  `usability-compatibility`、`operations`、`evidence-assumptions`、
  `maintainability-failure-modes` の一つを選び、理由を記録する。
- 二人とも lens に加えて common baseline（固定 revision と scope、既存契約、
  境界、エラー処理、回帰、根拠、confidence）を確認する。
- 一人が辞退または timeout した flow は non-go のままにする。single へ暗黙に
  縮退しない。single でやり直すならユーザー判断で別 flow を開始する。

## ライフサイクル

panel は一つの ledger で次の順序を強制する。対になった同種メッセージ内の
順序は任意である。

```
REVIEW-REQ
→ FINDINGS from reviewer-a and reviewer-b
→ FYI from coordinator with both FINDINGS paths
→ CROSS-CHECK from reviewer-a and reviewer-b
→ CONSOLIDATED
→ APPLIED（canonical finding がある場合）
→ VERIFIED from reviewer-a and reviewer-b
→ DECISION（aggregate unresolved high/mid がある場合）
```

- 二つの initial FINDINGS が揃うまで、coordinator は一方の FINDINGS を他方へ
  公開しない（independence barrier）。
- 各 CROSS-CHECK は peer の high/mid source ID だけを対象にし、該当がなくても
  `finding-ids: none` を送る。
- CONSOLIDATED は全 source ID を canonical または duplicate として保持し、
  棄却された指摘も落とさない。duplicate 群の canonical finding は群内の
  最高 severity を保持する。
- 各 reviewer は自分の prefix を持つ canonical ID を VERIFIED で一度だけ
  partition する。所有 ID がなくても zero-ID VERIFIED が必要である。
- 二人分を集約した unresolved high/mid だけがユーザーの DECISION を要求する。
  閉鎖状態と `require-closed` の意味は single と共通である。
- panel で REVIEW-REQ 後に許される FYI は、independence barrier 後に
  両 FINDINGS path を渡す coordinator relay だけである。

## タグとテンプレ

source ID は reviewer-a が `a-N`、reviewer-b が `b-N`。`[CROSS-CHECK]` と
`[CONSOLIDATED]` は panel 専用タグである。REVIEW-REQ は base skill の任意
handoff フィールド（`briefing` / `return-mode` / `return-directory` /
`instructions` 等）も使える。

```
[REVIEW-REQ] <対象>
review-mode: panel
revision: <commit:...>
scope: <対象範囲>
focus: <重点>
context: <課題・ゴールまたは参照>
implementer: <identity>
implementer-model: <model family>
reviewer-a: <identity>
reviewer-a-model: <opposite model family>
reviewer-a-context: fresh
reviewer-a-lens: correctness-contract
reviewer-b: <identity>
reviewer-b-model: <same model family as implementer>
reviewer-b-context: fresh
reviewer-b-lens: <catalog value>
reviewer-b-lens-reason: <対象 failure mode から選んだ理由>

[FINDINGS] <対象>
reviewed-revision: <REVIEW-REQ revision>
scope: <確認範囲>
verification: <確認内容>
count: <N>
reviewer: <担当 identity>
lens: <assigned lens>
finding-a-1: <high|mid|low> <path>:<line> <要約>
evidence-a-1: <根拠>
confidence-a-1: <high|mid|low>

[FYI] panel findings relay
reviewed-revision: <REVIEW-REQ revision>
reviewer-a-findings: <reviewer-a FINDINGS の絶対 path>
reviewer-b-findings: <reviewer-b FINDINGS の絶対 path>

[CROSS-CHECK] <peer findings>
reviewed-revision: <REVIEW-REQ revision>
source-reviewer: <peer identity>
checker: <self identity>
finding-ids: <peer high/mid source IDs、なければ none>
confirmed: <subset、なければ none>
rejected: <残り、なければ none>
verification: <確認内容>
evidence-<peer source ID>: <ID ごとの根拠>
confidence-<peer source ID>: <high|mid|low>

[CONSOLIDATED] <panel findings>
reviewed-revision: <REVIEW-REQ revision>
source-ids: <全 source IDs、なければ none>
canonical-ids: <canonical source IDs、なければ none>
duplicate-map: <duplicate=canonical、なければ none>
verification: <統合根拠>
finding-a-1: <canonical source finding の原文>
sources-a-1: <対応する source IDs>
cross-check-a-1: <not-required|confirmed|rejected|mixed>
```

- `confirmed` と `rejected` は CROSS-CHECK の `finding-ids` を完全 partition する。
- CONSOLIDATED の各 source ID は canonical または duplicate に一度だけ現れる。
- panel APPLIED は canonical ID を `resolved` / `dismissed` に、panel VERIFIED は
  各 reviewer 所有の canonical ID を `resolved` / `unresolved-high-mid` /
  `unresolved-low` に完全 partition する。panel VERIFIED には `reviewer` と
  `finding-ids` を追加する。panel DECISION は aggregate unresolved high/mid
  canonical ID を対象にする。
- CROSS-CHECK の `evidence-` / `confidence-` の ID prefix は **peer のもの**
  （reviewer-b が reviewer-a の指摘を検査するなら `evidence-a-N`）。

## fanout

panel の REVIEW-REQ、group FYI、CONSOLIDATED、APPLIED、DECISION は
`send.sh --to reviewer-a,reviewer-b` で同じ ledger file を二人へ fanout する。

- target は空白なし・重複なしの正確に二つで、header の `to:` に
  comma-separated audience として残る。
- 各 target の settle・配送・着火観測は個別に行われ、いずれかの配送が
  失敗すれば exit 3 になる。
- 片方への配送失敗時も flow は未完了で、header 全体を `--to` に保ったまま
  `--retry-target <失敗した一宛先>` で復旧する。成功済みの相手へ再送しない。
  single にしない。

## coordinator と reviewer の手順

1. coordinator は一意な pane 名で、実装者と反対 model family の fresh
   reviewer-a と、実装者と同じ model family の fresh reviewer-b を一人ずつ
   spawn する。reviewer-b は実装者と同系統なので `spawn.sh` の既定 pane 名が
   実装者と衝突し得る。第二引数で明示名を渡す。lens と理由を決め、
   `instructions:` に `templates/reviewer-instructions-panel.md` の絶対パスを
   入れた group REVIEW-REQ を fanout する（single 用
   `reviewer-instructions.md` は数値 ID 前提で panel では使わない）。
   spawn したてのピアには base skill と同様に handoff フィールド統合で
   go/no-go 往復を省略できる。既存ピアを使う場合は group HANDOFF で
   go/no-go を先に取る。fanout 直後に findings の skeleton を二人分生成する
   （`review-flow.py scaffold --dir <flow> --tag findings --reviewer <各ペイン名>`）。
2. 各 reviewer は peer の結果を見ずに担当 lens と common baseline の FINDINGS
   を合意した return mode で返して turn を終える。coordinator は二人の settle
   と台帳への取り込みを確認し、両方が揃うまで相互配送しない。
3. 両 FINDINGS を台帳へ取り込んだ後、cross-check の skeleton を二人分生成し
   （`scaffold --tag cross-check --reviewer <各ペイン名>`。両 FINDINGS 記録前は
   independence barrier のため拒否される）、二つの FINDINGS 絶対 path を一つの
   group `[FYI]` で二人へ送る。各 reviewer は peer path の high/mid だけを
   CROSS-CHECK し、合意した return mode で返す。FINDINGS file 自体の `to:` を
   書き換えたり再配送したりしない。
4. coordinator は全 source を CONSOLIDATED に保持し、重複 mapping と対立を
   残したうえで、canonical ID を一つの APPLIED で triage する。APPLIED
   （canonical が無ければ CONSOLIDATED）の配送後に verified の skeleton を
   二人分生成する（`scaffold --tag verified --reviewer <各ペイン名>`。
   CONSOLIDATED 記録後なら各自の `finding-ids` は自動で埋まる）。各 reviewer は
   自分の prefix を持つ canonical ID を result revision 上で VERIFIED し、
   合意した return mode で返す。
5. aggregate unresolved high/mid はユーザーの DECISION を待つ。二人の VERIFIED
   と必要な DECISION が揃い、`require-closed` が通るまで完了と報告しない。

hunk による live 案内を使う場合、panel では CONSOLIDATED を台帳へ取り込んだ
後に鏡映する（それ以外は base skill の hunk 節に従う）。
