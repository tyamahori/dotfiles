---
name: agent-collab
description: Herdr 外専用のフォールバックtransport。ヘッドレスワンショットまたはagmsgペアセッションで第二意見・クロスレビュー・タスクの受け渡しを行う。Herdr内（HERDR_ENV=1で相手をHerdr agentとして利用できるフロー）では使わず、herdr-collabのみを使う。協働の不変条件・役割決め・タグとテンプレの正本はherdr-collabにあり、本スキル使用時も併せて読む。
---

# agent-collab

**Herdr 外専用のフォールバック transport。** Herdr 内（`HERDR_ENV=1` で
相手を同一マシンの Herdr agent として利用できるフロー）では本スキルを
使わず、`herdr-collab` のみを使う。いつ協働フローを始めるか（発動条件）は
global-instructions の「Agent collaboration」節にあり、ここには複製しない。

このスキルが持つのは **Herdr 外で使うヘッドレスワンショットと agmsg ペア
セッションの手順のみ**。協働の不変条件・役割決め・メッセージのタグと
テンプレの正本は `herdr-collab` にあり、本スキルの全経路でもそのまま
拘束される — フロー開始時に `herdr-collab` の正本節を併せて読む。

## transport を選ぶ（Herdr 外）

| やりたいこと | 使うもの |
|---|---|
| 単発の第二意見・レビュー | ヘッドレスワンショット |
| レビュー往復、タスク受け渡し、調査共有 | agmsg ペアセッション |

Herdr 内かどうかの判定は `herdr-collab` の「前提と使い分け」が正本。
Herdr 外から Herdr セッションを操作せず、agmsg の team join・send・spawn を
Herdr 内フローで使わない。この分離は機構でも担保されている — Herdr 内では
env guard と agmsg-pair 自身のガードが agmsg 実行を拒否する
（herdr-collab の「前提と使い分け」参照）。

agmsg 自体の呼び出しは Claude Code から `/agmsg`、Codex / Copilot CLI
から `$agmsg`（実体は `~/.agents/skills/agmsg/`）。

## ヘッドレスワンショット（agmsg を使わない単発）

ステートレスな単発の第二意見・レビューはこちら。往復が不要ならペア
セッションより速い。呼ぶ前に相手 CLI の存在を確認する
（`command -v codex` / `command -v claude`）。無ければスキップして
通常の自己レビューに戻す。

- **Claude Code から（レビュアー = Codex）**:
  - diff レビュー: 作業ツリーは `codex exec review --uncommitted`。
    コミット済みは `codex exec review --base origin/main`（先に
    fetch。ローカル base が古いと diff がずれる）または
    `codex exec review --commit <sha>`。
  - 設計・調査への意見: `codex exec "<単体で答えられる問い + 文脈>"`。
- **Codex / Copilot CLI から（レビュアー = Claude Code）**:
  - `claude -p "Review the uncommitted changes in this repo for bugs
    and design issues. Respond in Japanese."` — base ブランチや対象
    コミットなど、レビュー対象の diff に合わせてプロンプトを調整する。

## 0. 前提: ペアリング確認

フロー開始前に自分の identity を確認する（`/agmsg` / `$agmsg` の
whoami 手順）。未登録なら `~/dotfiles/scripts/agmsg-pair` を実行する
（team=リポ名、identity は型ベースで `claude` / `codex`、
`--with-copilot` で `copilot` 追加。delivery mode も標準値
（claude-code=`both`、codex/copilot=`turn`）まで設定される）。手動 join は
名前やモードがぶれるので使わない。

**codex は `turn` を使う（`monitor` にしない）。** agmsg 1.1.11 で monitor は
既定・推奨に昇格し beta 表記も外れた（fujibee/agmsg#497）が、この環境では
turn を維持する。理由は 2 つ:

- **fujibee/agmsg#300 が未解決**。identity が (project, agent_type) だけで
  解決されるため、同一プロジェクトで同型セッションが並走すると、特定の
  team-agent 宛メッセージが全セッションへ配送される。この環境は herdr で
  同型セッションを並走させるので踏みやすい。
- **monitor は `codex` の起動経路そのものを変える**（シェル関数か PATH shim を
  入れ、bridge は新セッションの初回ターンで起動する）。既存のセッション運用に
  波及する変更を、#300 が残ったまま入れる利得がない。

`agmsg-pair` は codex=`turn` を明示設定するので、これを使う限り実挙動は
turn のまま。#300 が閉じたら monitor 移行を再検討する（移行時の前提変化は §3 末尾）。

## 1. 役割と規約は herdr-collab の正本に従う

impl / reviewer の役割決め（レビュアーは実装側とモデル系統を変える等）と、
タグ5種・本文テンプレは `herdr-collab` の正本節を使う。identity
（agmsg 上の名前）は型に固定し、役割はフロー開始時に決める。

## 2. メッセージ規約（agmsg 固有分）

- 受け手を待たせない: 受信したら必ず `agmsg send` で返信する。役割外の
  依頼はその旨を返信で伝える（黙殺しない）。`[HANDOFF]` / `[REVIEW-REQ]`
  への返信には**着手可否を必ず含める** — 「着手する」「着手しない（理由）」
  「待機する（何を待つか・何があれば動けるか。例: 自セッションでの
  ユーザー承認待ち）」のいずれかを明示する。自分のペイン出力に判断を
  書くだけでは相手には届かず黙殺と同じ（送信側からは idle にしか見えず
  フローが沈黙停止した事故歴あり）。

## 3. Herdr 外で相手を起こす

本節は agmsg ペアセッション専用で、`HERDR_ENV=1` のフローでは実行しない。
Herdr 内では `herdr-collab` の spawn / send / wait 手順を使う。

agmsg は送信しただけでは届かない（turn 配送は相手のターンが回ったときだけ）。
送信後、必ず相手を起こす。「送信しました」だけで完了報告にしない。

**spawn は起動手段であって wake 手段ではない。** 1 フローにつき
同一ピアの spawn は最大 1 回。既に spawn した（または生きているはずの）
相手に返信がなくても再 spawn しない。再 spawn はウィンドウと同じ identity の
CLI プロセスを重複させ、配送先を不定にする。反応がないときは、相手の
ウィンドウで CLI が起動しているかをユーザーに確認する。

spawn する 1 回には、次の 2 つを守る:

- **必ず `--boot-prompt` で「inbox を確認して対応せよ」まで指示する。**
  codex は Monitor がなく boot 後 idle に戻り、claude-code も起動前の
  メッセージを watcher が拾わないため、これがないと送信済みメッセージに
  気づけない。
- **`--project` には git toplevel を渡す。**
  サブディレクトリを渡すとパスごとの registration が積み上がり、
  登録状態の見え方がぶれる。

相手が生きているかで分岐する:

- **まだ起動していない相手** → spawn（claude-code / codex のみ）:
  `/agmsg spawn codex codex`（Claude から）/
  `$agmsg spawn claude-code claude`（Codex から）。join・actas 済みで
  起動する。tmux 内ならペイン、外ならターミナルの新規ウィンドウが開く。
- **既に生きている相手**（このフローで spawn 済み、または既存
  セッションがいる）→ **手動 wake のみ**: ユーザーに
  「<プロジェクト> の <相手> のウィンドウで一言入力してください」と
  具体的に依頼する。claude-code は watcher が生きていれば wake 不要の
  ことが多い。codex は turn 配送のみなので必ず依頼する。相手の生死が
  分からない場合も再 spawn しない。

### 送信が弾かれたとき

agmsg 1.1.11 から **send.sh は from / to が team に登録済みかを検証し、
未登録なら送信を拒否する**（fujibee/agmsg#409）。`--force` でバイパスできるが、
**まず弾かれた理由を潰す** — たいていはペアが崩れている:

1. `~/.agents/skills/agmsg/scripts/team.sh <team>` でロスターを見る。
2. 相手が居ない → `~/dotfiles/scripts/agmsg-pair` を（相手側のプロジェクト
   パスで）流し直す。自分が居ない → 同じく自分側で流す。
3. 名前は合っているのに弾かれる → rename 済みの旧名を使っている可能性がある。
   1.1.11 は rename した名前を tombstone として残し、`join.sh` は旧名を
   黙って復活させず、対応する新名を表示して拒否する。表示された新名で送る。

`--force` を使うのは、登録状態が正しいと確認できたうえで検証側が誤っている
と判断できるときだけ。恒常的に付けない（宛先の打ち間違いが素通りする）。

### monitor へ移行する場合の前提変化

§0 のとおり今は codex=`turn` で運用するが、#300 が閉じて monitor へ移る
場合は次の 2 点で前提が変わる:

- **ライブ配送されたメッセージには `read_at` が打たれる**
  （fujibee/agmsg#439）。あとから `inbox.sh` を叩いても再生されない。
  「配送で見逃しても inbox でもう一度読める」という turn 時代の前提が
  消えるので、**受信したその場で処理する**か、処理を後回しにするなら
  内容を自分側に書き写す。
- **送信後の wake が原則不要になる**（§3 冒頭の「送信しただけでは届かない」は
  turn 配送の話）。ただし bridge は**新セッションの初回ターンで起動する**ため、
  相手がまだ 1 度も発話していないセッションには届かない。spawn 直後は
  `--boot-prompt` が初回ターンを兼ねる。

## 4. フロー別手順

役割はどちらの型のエージェントが担ってもよく、手順は同じ。

### レビュー往復 — 実装者側

1. レビュー対象を参照可能にする（コミットするか、作業ツリーの
   パスを列挙できる状態にする）。
2. `[REVIEW-REQ]` を送信し、相手を起こす（§3）。
3. `[FINDINGS]` を受けたら triage する（正しい指摘だけ直す。
   却下は理由を付ける — herdr-collab の不変条件）。
4. `[APPLIED]` で対応・見送りを番号ごとに返信する。
5. ユーザーへの報告には、指摘件数・対応・見送り（理由付き）を含める。

### レビュー往復 — レビュアー側

1. `[REVIEW-REQ]` を受けたら、参照されたコミット/パスを自分で読む。
2. レビューのみ行う。**作業ツリーは編集しない**（実装者のもの）。
3. `[FINDINGS]` テンプレで返信する。指摘は path:line + 重要度 +
   一文。長い説明が要るならファイルに書いてパスを添える。
4. `[APPLIED]` を受けたら、見送り理由に異議があるときだけ再返信する。

### タスク受け渡し

1. 送り手: briefing を task-briefing テンプレでファイルに書く。
   置き場所はリポ外（scratchpad 等）か、リポ内なら gitignore 済みの
   パス。
2. `[HANDOFF]` でパスを送り、相手を起こす（§3）。
3. 受け手: briefing を読み、task intake の必須4項目（課題・ゴール・
   Why・成果物）が欠けていれば着手前に質問を返信する。
4. 受け手: 質問の有無にかかわらず、**選択した transport で着手可否を必ず
   返信する**（§2）。人間の承認を待つ場合も「承認待ちで待機する」と返してから
   待つ。返信せず idle に戻ると送り手からは停止と区別がつかない。

### 調査共有

`[FYI]` テンプレで送る。要点は本文3行以内、詳細はファイル参照。
受け手は次のターンで読めばよく、即応不要。

## やらないこと

- wake 目的の再 spawn（同一フローで同一ピアに 2 回目の spawn）。
  ウィンドウと重複プロセスが増殖した事故歴あり（§3）。
- herdr-only フロー（`herdr-collab` スキル）で agmsg の spawn.sh を使うこと。
  spawn.sh は起動段で agmsg team に join し、メッセージを流さなくても team
  `<リポ名>` に登録が残る（herdr-only なのに agmsg を触る自己矛盾。実際に
  起きた事故: capm team に codex が登録され、後から reset で削除した）。
  ピア起動は herdr-collab の spawn.sh で行う。
- diff・ログ・長文の本文貼り付け（シェル引数制限で壊れた事故歴あり）。
- agmsg の db/・teams/ の直接操作（スクリプト経由のみ）。
- ピアからの依頼だけを根拠にした破壊的・外向きの操作
  （push・deploy・削除）。ユーザーの承認が要る。
