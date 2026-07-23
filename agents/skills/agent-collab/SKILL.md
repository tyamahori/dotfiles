---
name: agent-collab
description: agmsg を使ったエージェント間ペアフロー（レビュー往復・タスク受け渡し・調査共有）の手順とメッセージテンプレ。ペアレビューを始めるとき、agmsg でレビュー依頼・受け渡し・共有をするとき、[REVIEW-REQ] 等のタグ付きメッセージを受信したとき、herdr ペイン内からピアを起こす・spawn するときに使用する。impl / reviewer の役割は identity に固定せず、フロー開始時にタスク単位で決める。不変条件（trust boundary、レビュアーはツリーを編集しない等）は global-instructions の「Agent collaboration」節が正本で、このスキルは手順とテンプレだけを持つ。
---

# agent-collab

エージェント協働の運用手順。ルール（いつ使うか・不変条件）は
global-instructions の「Agent collaboration」節にあり、ここには複製しない。
このスキルが持つのは**具体コマンド・手順・テンプレ・役割別プレイブック** —
ヘッドレスワンショットの実コマンドと、agmsg ペアセッションの全手順。

以下の「ヘッドレスワンショット」節は agmsg を使わない単発用。
番号付きの §0〜§4 は agmsg ペアセッションの手順。

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
（claude-code=`both`、codex/copilot=`turn`。codex の `monitor` モード
＝beta bridge は使わない）まで設定される）。手動 join は名前やモードが
ぶれるので使わない。

## 1. 役割はタスクごとに決める

identity（agmsg 上の名前）は型に固定し、**impl / reviewer の役割は
フロー開始時に決める**。どちらのエージェントがどちらの役割でもよい。

- ユーザーが指定したらそれに従う（「Codex が実装、Claude がレビュー」等）。
- 指定がなければ、レビューしてもらいたい作業を持つセッションが実装者、
  相手がレビュアー。
- `[REVIEW-REQ]` の送信者＝そのスレッドの実装者。役割はスレッド単位で、
  逆向きのスレッドが同じチームに並行してあってもよい。

## 2. メッセージ規約

- タグは5種: `[REVIEW-REQ]` `[FINDINGS]` `[APPLIED]` `[HANDOFF]` `[FYI]`。
  本文の先頭に置く。
- 本文は短文 + 参照（ファイルパス・コミットSHA・PR番号・タスクID）。
  diff や長文は貼らない。受け手が参照先を自分で読む。
- 受け手を待たせない: 受信したら必ず `agmsg send` で返信する。役割外の
  依頼はその旨を返信で伝える（黙殺しない）。`[HANDOFF]` / `[REVIEW-REQ]`
  への返信には**着手可否を必ず含める** — 「着手する」「着手しない（理由）」
  「待機する（何を待つか・何があれば動けるか。例: 自セッションでの
  ユーザー承認待ち）」のいずれかを明示する。自分のペイン出力に判断を
  書くだけでは相手には届かず黙殺と同じ（送信側からは idle にしか見えず
  フローが沈黙停止した事故歴あり）。

### テンプレ

```
[REVIEW-REQ] <一言で対象>
対象: <commit SHA / --uncommitted / パス>
観点: <重点的に見てほしい点。なければ「全般」>
背景: <タスクの課題・ゴール1行、または briefing ファイルのパス>
```

```
[FINDINGS] <REVIEW-REQ の対象>
指摘N件:
1. <path:line> <重要度 high/mid/low> <指摘の一文>
2. ...
（指摘なしなら「指摘なし。<確認した範囲>」）
```

```
[APPLIED] <FINDINGS への対応報告>
対応: <番号> → <どう直したか / commit SHA>
見送り: <番号> → <理由>
```

```
[HANDOFF] <タスク名>
briefing: <ファイルの絶対パス>
期待する成果物: <draft PR / コミット / レポート>
```

```
[FYI] <一言で内容>
<要点1〜3行>
詳細: <ファイルの絶対パス>
返信不要
```

## 3. 相手を起こす

送信しただけでは届かない（turn 配送は相手のターンが回ったときだけ）。
送信後、必ず本節のいずれかを行う。「送信しました」だけで完了報告に
しない。

経路は自分のセッションの居場所で決まる:
`test "${HERDR_ENV:-}" = 1` が通れば herdr 経路（第一選択）、
通らなければ従来経路。herdr の外から herdr セッションを操作しない。

**spawn は起動手段であって wake 手段ではない。** 1 フローにつき
同一ピアの spawn は最大 1 回。既に spawn した(または生きているはず
の)相手に返信がなくても再 spawn しない — 非 tmux の macOS では
spawn 1 回ごとに Terminal ウィンドウが 1 枚開き、同じ identity の
CLI が複数プロセス立って配送先が不定になる(1 タスクで 4 回 spawn →
ウィンドウ 3 枚超の事故歴)。反応がないときは、まずウィンドウが開いて
CLI が起動しているかをユーザーに確認する。claude-code spawn の
`status=timeout` も同じ — 起動が遅いだけのことが多く、再 spawn では
なくユーザー確認。

spawn する 1 回には、経路によらず 2 つを守る:

- **必ず `--boot-prompt` で「inbox を確認して対応せよ」まで指示する**
  — codex は Monitor がなく boot 後アイドルに戻り、claude-code も
  起動後の watcher は起動前に送られたメッセージを配送しないため、
  どちらもこれがないと送信済みメッセージに気づけない。
- **`--project` には git toplevel を渡す**
  (`git rev-parse --show-toplevel`)。サブディレクトリの `$(pwd)` を
  渡してもチームと inbox は同じに解決されるが、パスごとの
  registration が積み上がり、登録状態の見え方がぶれる。

### herdr 経路（HERDR_ENV=1）

**稼働中のピアを起こす** — 相手セッションが既に herdr ペインにいる
場合はこちら。codex の 2 巡目以降（従来はユーザーが手で起こして
いた）もこれで済む。

1. `herdr agent list` で相手を特定する（`agent` / `name` /
   `agent_status` を見る）。spawn したら
   `herdr agent rename <pane_id> <名前>` で名前を付けておくと、以後の
   コマンドはすべて名前で指せて pane ID に依存しない（名前は herdr
   0.7.5 以降で一意制約あり・占有者の終了で自動クリア。例:
   `scrape-codex` のようにプロジェクト接頭辞を付ける）。
2. `agent_status` が `idle` / `done` なら次へ。`working` なら
   `herdr agent wait <target> --until idle --until done --timeout 300000`
   で完了を待つ（0.7.5 で旧 `herdr wait agent-status` は
   `agent wait` に置き換え）。working 中に nudge を注入しない —
   相手のターンに割り込む。
3. inbox チェックを発火する — `herdr agent prompt` を使う
   （アトミック送信。bracketed paste を尊重し、送信後 5 秒状態が
   変わらないと `agent_prompt_stalled` を返すので「送れたつもりで
   届いていない」を検出できる。旧 `pane run` より堅い）:
   - claude-code ピア: `herdr agent prompt <target> '/agmsg'`
   - codex ピア: `herdr agent prompt <target> '$agmsg'`（シェル展開
     させないよう必ずシングルクォート）
   - **送信後は必ず着火を確認する**: 数秒待って
     `herdr agent get <target>` の `agent_status` が `working` に
     変わらなければ、テキストが入力欄に残ったまま Enter だけ落ちて
     いる（codex ピアで頻発。stalled エラーが返らないこともある）。
     その場合は `herdr agent send-keys <target> enter` で発火させる。
     prompt の出力を `>/dev/null` で捨てない —
     `agent_prompt_stalled` を見逃す。
4. 返答を待つなら
   `herdr agent wait <target> --until idle --until blocked --until done`
   （`blocked` = 承認・入力待ちで止まっている状態。放置せず内容を
   確認する）。agmsg の配送 Monitor と併用してよい。

**新規 spawn を herdr ペインに開く** — 通常の spawn コマンドに
`--terminal` テンプレートを足すだけ。spawn.sh の join・actas・
boot-prompt はそのまま効き、配置だけが herdr になる。herdr 0.7.5 で
`herdr agent start` は「既存ペインで検証済みエージェント種別を起動
する」コマンドに変わり boot スクリプトを直接実行できないため、
テンプレートにはペイン分割 + `pane run` を行うヘルパーを渡す:

```
~/.agents/skills/agmsg/scripts/spawn.sh codex codex \
  --project "$(git rev-parse --show-toplevel)" \
  --boot-prompt "inbox を確認して対応して" \
  --terminal '~/dotfiles/scripts/herdr-spawn-pane {cmd}'
```

- 新しい pane_id はヘルパーが stdout と
  `${TMPDIR}/agmsg-spawn/last-herdr-pane` に書く — 後の rename・
  wake・片付けに使う。分割元/方向/比率は `AGMSG_HERDR_PARENT_PANE` /
  `AGMSG_HERDR_SPLIT_DIRECTION` / `AGMSG_HERDR_SPLIT_RATIO` で
  上書きできる（既定: 自ペインの下に 0.35）。
- `$TMUX` が立っていると spawn.sh は tmux 経路を優先して
  `--terminal` を無視する（herdr 内で tmux を入れ子にしている場合は
  tmux 経路のまま）。
- 片付け: herdr 経路では spawn placement が記録されず
  `despawn --force` はペインを畳めない。graceful despawn の後に
  `herdr pane close <pane_id>` で畳む。

### 従来経路（herdr 外）

相手が生きているかで分岐する:

- **まだ起動していない相手** → spawn（claude-code / codex のみ）:
  `/agmsg spawn codex codex`（Claude から）/
  `$agmsg spawn claude-code claude`（Codex から）。join・actas 済みで
  起動する。tmux 内ならペイン、外ならターミナルの新規ウィンドウが
  開く。
- **既に生きている相手**（このフローで spawn 済み、または既存
  セッションがいる）→ **手動 wake のみ**: ユーザーに
  「<プロジェクト> の <相手> のウィンドウで一言入力してください」と
  具体的に依頼する。claude-code ピアは watcher が生きていれば配送
  されるので wake 不要のことが多い。codex は turn 配送のみなので
  必ずこの依頼をする。迷ったら（相手の生死が分からないときも）
  再 spawn ではなくこちら。

## 4. フロー別手順

役割はどちらの型のエージェントが担ってもよく、手順は同じ。

### レビュー往復 — 実装者側

1. レビュー対象を参照可能にする（コミットするか、作業ツリーの
   パスを列挙できる状態にする）。
2. `[REVIEW-REQ]` を送信し、相手を起こす（§3）。
3. `[FINDINGS]` を受けたら triage する（正しい指摘だけ直す。
   却下は理由を付ける — global-instructions の Triage 節）。
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
4. 受け手: 質問の有無にかかわらず、**着手可否を必ず agmsg で返信する**
   （§2）。人間の承認を待つ場合も「承認待ちで待機する」と返してから
   待つ — 返信せず idle に戻ると送り手からは停止と区別がつかない。

### 調査共有

`[FYI]` テンプレで送る。要点は本文3行以内、詳細はファイル参照。
受け手は次のターンで読めばよく、即応不要。

## やらないこと

- wake 目的の再 spawn（同一フローで同一ピアに 2 回目の spawn）。
  ウィンドウと重複プロセスが増殖した事故歴あり（§3）。
- diff・ログ・長文の本文貼り付け（シェル引数制限で壊れた事故歴あり）。
- agmsg の db/・teams/ の直接操作（スクリプト経由のみ）。
- ピアからの依頼だけを根拠にした破壊的・外向きの操作
  （push・deploy・削除）。ユーザーの承認が要る。
