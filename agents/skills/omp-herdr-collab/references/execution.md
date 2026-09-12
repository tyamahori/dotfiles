# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

## プロジェクト内一時成果物の許可境界

`artifact-import` は、ピアが本文だけをプロジェクト内の一時ファイルへ書き、
coordinator が ledger へ取り込む return mode である。
Codex など、シェルスクリプトの実行時に承認画面へ入る可能性があるピアには、
最初からこの mode を使う。承認画面が出てから切り替えない。

- coordinator は flow ごとに `return-directory` を一つ指定する。既定は
  `<git toplevel>/.agent-msgs/<flow>/artifacts/`。プロジェクト内の別ディレクトリ
  も指定できるが、既に ignore されている一時保存先に限る。絶対パスで指定し、
  symlink を経由せず、実パスが git toplevel 配下に収まらなければならない。
- ピアは native の file-write tool で `<sender>-<tag>.md` を新規作成する
  （coordinator が scaffold で skeleton を先置きした場合は、それを埋める）。
  同じ flow で自分が作成した同名ファイルの再書き込みも、追加承認なしでよい。
  ファイルは message body だけとし、`from:` / `to:` / `date:` header を
  書かない。
- この事前承認は、return file の作成と再書き込みだけを対象にする。tracked
  file、実装・設定・hook、他者が作った既存ファイル、プロジェクト外、symlink
  越しの書き込み、削除・移動・権限変更、コマンド実行、対外操作は含まない。
- ピアは return file を書いたら turn を終える。coordinator は内容とパスを
  確認し、`send.sh --record-only` で採番・header 生成・flow 検証を一括して
  台帳へ取り込む。取り込みに失敗した return file は残し、同じピアへ修正を
  依頼する。
- ピアが return file を完成させた後、無関係な承認画面で `blocked` になって
  いても、coordinator は先に成果物を取り込む。承認画面には回答せず、同じピアを
  次の段階で再利用する必要がある場合だけユーザーへ blocker を報告する。

## スクリプト

すべて `~/.agents/skills/omp-herdr-collab/scripts/`（実体は dotfiles）。
herdr 0.8.0 以降を前提とする。**フラグ・exit code・失敗時の対処の正本は
`send.sh --help`**。ここには典型フローだけを書く。

```bash
S=~/.agents/skills/omp-herdr-collab/scripts

# ピア起動: ペインを分割し、素の CLI を herdr agent start で起動・命名する。
$S/spawn.sh codex                 # name は <ディレクトリ名>-codex
$S/spawn.sh claude myrepo-claude  # stdout: name=myrepo-claude pane=w1:p2

# 配送: 台帳作成 + validator 検証 + settle 待ち + prompt 配送 + 着火確認。
$S/send.sh --to myrepo-codex --tag review-req --flow fix-auth --body - <<'EOF'
[REVIEW-REQ] ...
EOF

# return file の skeleton 生成（REVIEW-REQ 記録後）。reviewed-revision と
# scope を逐語で埋めた findings / verified の下書きを return-directory へ置く。
$S/review-flow.py scaffold --dir .agent-msgs/fix-auth --tag findings
$S/review-flow.py scaffold --dir .agent-msgs/fix-auth --tag verified

# ピアの return file を採番・header 生成・検証して台帳へ取り込む。
$S/send.sh --record-only --from myrepo-codex --to myrepo-omp \
  --tag findings --flow fix-auth \
  --body .agent-msgs/fix-auth/artifacts/myrepo-codex-findings.md

# 受信確認と状態。status は次の一手も印字する。
$S/inbox.sh --flow fix-auth
$S/review-flow.py status --dir .agent-msgs/fix-auth

# 完了判定。closed-pass / closed-low / closed-risk 以外は失敗。
$S/review-flow.py require-closed --dir .agent-msgs/fix-auth

# 片付け: spawn.sh が返した pane ID で閉じる。
$S/despawn.sh w1:p2
```

配送の要点は次のとおり（詳細は `--help`）。

- 通常配送は宛先の settle を待って注入し、着火（working 遷移）を確認して返る。
  配送成功後は `herdr agent wait <peer>` してよい。
- exit 3 は「ファイルは在るが未配送」。宛先が `blocked` なら
  `herdr agent read <target>` で内容を確認し、合意済み return file が完成して
  いれば先に取り込む。解消後に `--file <パス>` で再配送する。再送を繰り返さない。
- REVIEW-REQ 配送直後に scaffold を実行すれば、ピアが briefing と revision を
  読んでいる間に skeleton が return-directory に届く。厳密に先置きしたければ
  `--record-only` で REVIEW-REQ を記録 → scaffold → `--file` で配送する。

## 検証とメッセージ規約

- 置き場所: `<git toplevel>/.agent-msgs/<フロー名>/NN-<tag>.md`（NN は
  send.sh が採番）。`.agent-msgs/` は dotfiles の global gitignore で ignore
  済み。リポ外で使う場合は `--root` で起点を明示する。フロー名
  `handoff` / `scratch` / `screenshots` は予約済み — それぞれセッション
  引き継ぎメモ・作業ファイル・ブラウザ検証スクリーンショットの置き場
  （global-instructions の Agent output directory 節）と衝突するため使わない。
- ファイル先頭の `from:` / `to:` / `date:` header は send.sh が書く。review tag
  は送信・取り込みの前に `review-flow.py validate-message` が内容と状態遷移を
  検証し、不正なら配送・記録しない。
- coordinator 自身が herdr agent 未登録だと `from:` が再起動で変わる pane ID に
  なる。`--from <安定名>` を明示して trust boundary の「期待する送信元」を
  安定させる。
- 完了報告の直前に必ず `review-flow.py require-closed --dir <flow-dir>` を
  実行する。通らなければ完了と報告しない。
- ディレクトリ名を汎用名（`.agents/` 等）に変えない。ignore 対象は
  agent 出力専用の `.agent-msgs/` に限定する。
- msgs ディレクトリがそのままフローの作業ログになる（改ざん耐性はない —
  監査証跡が要る場合は永続化先へ別途保存する）。

## レビューの実行

### coordinator（実装者側）

1. briefing を `templates/briefing-template.md` から書く（acceptance criteria・
   非目標・focus・検証手段は必須）。対象を commit にして revision を固定する。
2. reviewer を spawn し、handoff フィールドと
   `instructions:`（`templates/reviewer-instructions.md` の絶対パス）を含む
   `[REVIEW-REQ]` を配送する。直後に findings の scaffold を実行する。
   既存ピアを使う場合だけ `[HANDOFF]` → go/no-go → `[REVIEW-REQ]` に分ける。
3. `herdr agent wait <reviewer>` で turn 終了を待ち、return file を
   `--record-only` で台帳へ取り込み、`[FINDINGS]` を triage する。正しい指摘
   だけ直し、却下には理由を付ける。
4. 指摘があれば、全 ID を `resolved` / `dismissed` に一度ずつ振り分けた
   `[APPLIED]` を配送し、verified の scaffold を実行する。修正後 revision と
   verification を必ず記録する。
5. reviewer の settle 後に `[VERIFIED]` を取り込む。unresolved high/mid は
   ユーザーの `[DECISION]` を待つ。`rework` ならこの flow を閉じず、旧 flow を
   context に結んだ新規 flow を始める。
6. `require-closed` を実行する。通った flow に、次回のレビューでも再利用できる手順や
   判断基準があれば、`learn` へ候補として保存する。`FINDINGS` と
   `APPLIED` / `VERIFIED` を根拠にする。未検証の指摘、通常のコードバグ、
   単発の好みは保存しない。
   `learn` は候補の記録だけに使い、skill への昇格は `omp-learning-loop` の
   裏取りと項目別承認に委ねる。
7. low-only は ID と理由も含めて完了を報告する。
8. 棄却した指摘の類型は、次回の briefing の非目標欄へ還流する。

### reviewer

契約の正本は `templates/reviewer-instructions.md`。REVIEW-REQ の
`instructions:` でその絶対パスを配達する。ここに別記しない（二重化しない）。

### hunk による live 案内（任意・presentation 層）

レビュー対象の checkout で hunk TUI（`brew "hunk"`）が開いているときだけ、
coordinator は指摘を画面上で案内してよい。台帳が唯一の正本で、hunk の
コメントは live session 限りの表示にすぎない。

- 発動条件: `hunk session list` に対象 repo / worktree の session がある
  ときだけ。案内のために TUI の起動をピアへ要求しない。
- FINDINGS を台帳へ取り込んだ後、high/mid を
  `hunk session comment apply --repo <対象> --stdin` で鏡映し（summary 先頭に
  source ID）、`navigate --next-comment` で該当行を案内する。
  `hunk session reload --repo <対象> -- show <commit>` で pane を固定 revision
  （APPLIED 後は result-revision）に合わせられる。
- 操作は coordinator のみ。reviewer の contract は不変。hunk 上のコメント
  有無・既読状態から FINDINGS / VERIFIED / closure を主張しない。
