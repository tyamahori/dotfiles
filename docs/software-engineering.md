# ソフトウェア工学の知識はどこにあるか

このマシンのエージェント（Claude Code、Codex、Copilot CLI、OMP）が設計・実装・テスト・レビューで参照する規範は、常時注入される共有指示、必要なときだけ読む skill、運用手順を書いた `docs/` の三層に分かれている。この文書はその地図であってルール本文は持たないので、直すべきは表に挙げた正本のほうで、この地図は置き場所が変わったときだけ更新する。

## 三層に分ける理由は毎ターンの文脈コストにある

`agents/global-instructions.md` は全ホストで毎ターン読み込まれる。ここに手順や規範を足すと、その行数分がすべてのセッションの全ターンに課金される（実測は `agents/measured-notes.md`）。そのため共有指示には「どの skill をいつ読むか」の一行ポインタまでしか置かず、規範の本文は skill に、導入・運用の手順は `docs/` に置く。ponytail の YAGNI ラダーだけはプラグインが毎ターン注入するので、共有指示にも skill にも転記しない（`docs/ponytail.md`）。

## 地図

| 領域 | 正本 | 読むタイミング |
| --- | --- | --- |
| 知識の置き場所（Code は How、Test は What、Commit は Why、Comment は Why-not） | `agents/global-instructions.md` の「Where each kind of knowledge lives」 | 常時注入 |
| 実装量の判断（YAGNI ラダー、既存の再利用、標準ライブラリ優先） | ponytail プラグイン。案内は `docs/ponytail.md` | 常時注入 |
| 設計の形（深いモジュール、依存方向＝クリーンアーキテクチャの依存ルール、境界での検証、不変条件、エラー方針、抽象化の基準、Hyrum の法則、UNIX 哲学の「一つのことをして組み合わせる」、時刻と並行性） | `agents/skills/software-design/SKILL.md` | モジュール境界・公開 IF・エラー方針・データモデルを決める前 |
| リファクタリング手順（特性テスト → seam → 小さな一歩ごとにテストと commit、smell と対処の表） | 同 skill の「Refactoring」節 | 変更に既存の形が抵抗するとき、緑になった後 |
| ADR のテンプレートと置き場所（既存規約に合わせる、なければ `docs/adr/NNNN-title.md`） | 同 skill の「ADRs」節 | コミットを超えて残る決定をしたとき |
| 設計資料に何を書くか（書くべきかの判定、間違えたときのコストで内容を選ぶ、Goals は影響で・Non-goals を明示、Open issues は問題・選択肢・次の一歩） | 同 skill の「Design docs」節。HTML 化とコメント運用は `reviewable-design-doc` | 複数人・長期・要件曖昧・致命的リスクのある案件の実装前 |
| テスト設計（変更種別ごとに要るテスト、name the break、実物 > fake > stub > mock、特性テスト、property-based、mutation check、消すべきテスト） | `agents/skills/test-design/SKILL.md` | テストを書く・直す・消す前、mock や helper を足す前 |
| 依頼の枠組み（背景・課題・ゴール・スコープ・成果物、実行すれば分かる問いは聞かずに試す） | `task-briefing`、前提を問い直すなら `grill-me`（docs 付きなら用語集と ADR も書く） | 着手前、依頼が曖昧なとき |
| 複雑タスクの工程（調査 → 計画 → 独立レビュー → 証拠つき納品） | `sureforge` | 複数ファイル・複数段階の実装 |
| バグ診断（仮説と再現、根本原因の証拠、同じ前提の修正が二度失敗したら前提を検証する）と指標の改善（一変更ずつ計測して残すか戻す Hillclimb、測った数値を報告前に検める） | `diagnosing-bugs`（vendoring して節を追加）、共有指示の「Root-cause claims need reproduction」 | 障害・不具合・性能劣化、数値を目標まで改善するとき、測った数値を報告するとき |
| アプリ固有の検証手順（起動・Doctor・操作・証拠・後片付けと機能の地図を、対象リポジトリの project-local skill として生成・保守する） | `create-verification-skill`、汎用のブラウザ経路は `browser-verify` | 振る舞いを証明する手順がスクリプト化されていないアプリ |
| 判断の記録（判断ごとの TSV、transcript との突き合わせ、別モデル系統の Attention 節） | `show-me-your-work` | 長時間・放置前提・全面委任の作業 |
| レビュー（変更種別ごとの必須質問、fresh context での反証、差分の外への波及範囲、Copilot 事前確認、過剰設計の摘出、ローカル差分の証拠つきレビュー） | `github-pr-review`、`evidence-code-review`、`adversarial-verification`、`copilot-preflight`、`ponytail-review` / `ponytail-audit`、OMP の `reviewer` / `security-reviewer` | PR の前後 |
| 構造的な編集（rename、参照列挙、codemod） | 共有指示の「Structural edits」、`structural-edit`、OMP `lsp` / `ast_edit` | 複数箇所に及ぶ書き換え |
| 言語別のスクリプト作法 | `efficient-python`、`efficient-ts-js` | スクリプトを書く・実行する前 |
| 品質ゲート（semgrep、SonarQube、ruff、commit-msg の Why 検査） | `docs/semgrep.md`、`docs/sonarqube.md`、`ruff/ruff.toml`、`git/global-hooks/` | commit 時、完了報告前 |
| 判断の形式化（機械化できるか試す、`Mechanized:` の更新義務） | 本書「形式化のサイクルを回す」節、`agents/measured-notes.md` | 同じ判断を二度目にする前、hook/permission/schema を足したとき |

## 意図的に書いていないもの

言語やフレームワーク固有の規約（Laravel のディレクトリ構成、React の状態管理の選び方など）は、そのプロジェクトの `AGENTS.md` / `CLAUDE.md` に置く。dotfiles は複数プロジェクトをまたぐ規範だけを持ち、個別プロジェクトの設計判断は各リポジトリの ADR とコミットログに残す。レビューの契約（タグ、状態遷移、台帳）は `omp-herdr-collab` が正本であり、この地図では扱わない。

## 公開スキルを調べたうえで自作にした

2026-09 に `npx skills find` で設計・テスト・リファクタリング・ADR の公開スキルを調べた。テスト設計は `obra/superpowers` の `test-driven-development`（約22万インストール）と `addyosmani/agent-skills` の同名スキルが強く、設計は `markduan/a-philosophy-of-software-design-skills` など採用実績の薄いものしかなかった。リファクタリングは `wondelai/skills` の `refactoring-patterns`、ADR は `wshobson/agents` と `addyosmani/agent-skills` の `documentation-and-adrs` が候補だった。

そのまま入れなかった理由は三つある。superpowers はテストのないコードを削除する「Iron Law」を軸にしており、ponytail の「動く最小限」と衝突する。公開スキルはどれも英語の長文で、REST の命名規約やチェンジログの書き方まで含むため、skill 一覧の説明文と読み込み時の文脈を余計に消費する。そして dotfiles には `github-pr-review` の変更種別ごとの質問表や OMP の検証規範がすでにあり、そこへ接続する形で書くほうが重複を避けられる。

借りたのは中身である。superpowers の `writing-good-tests.md` から「name the break」「mock は自分の存在を assert しない」「mutation check」を、addyosmani から「まずスタックを発見する」「real > fake > stub > mock」「DAMP」「境界で検証し内側は信頼する」「Hyrum の法則」と ADR の「既存規約に合わせてから既定へ」を、Ousterhout から深いモジュールとエラーの定義消去を、Fowler から smell とカタログの対応を取り込んだ。出典は各 skill の末尾に残している。

2026-10 には poteto の pstack（`cursor/plugins`）を再検討した。Claude Code プラグイン版でも多モデルのパネルは Claude 単独に縮み、原則と playbook の大半は ponytail・`test-design`・`software-design`・`diagnosing-bugs` と重なるため、導入は見送った。代わりに、手元にない部分を既存 skill の節として取り込んだ。最初に `blast-radius` を `adversarial-verification` の「波及範囲」観点に、hillclimb playbook と `attack-the-premise` を `diagnosing-bugs` に入れた。続けて、`benchmark-checklist` と `explain-the-number` を `diagnosing-bugs` の「Vet the number」節と `agent-usage-review` の診断に、poteto-mode の「観測できる問いは聞かずに試す」を `task-briefing` に、`correct` の「二度起きたら一クラス」「過去の実例で落ちることを確かめる」を本書の「形式化のサイクルを回す」に、playbook の手順を todo へそのまま写す運用を共有指示の「Skills to load first」に入れた。`create-verification-skill` と `maintain-verification-skill` だけは置き場所になる既存 skill がないため、一つの skill にまとめて新設した。

三回目は、uehaj の Zenn 記事「[【メモ】pstack (Claude Code 移植版pstack-claude) のスタック構成とオーケストレーションを読む](https://zenn.dev/uehaj/articles/claude-code-pstack-structure-memo)」で残りを洗い直した。poteto-mode の「読んだ原則だけを根拠に挙げる」「直しや再試行は統合したスコープで新しい subagent に渡す」と、`principle-never-block-on-the-human` の「戻せる作業は進めてから見せ、代わりに決めた既定は報告する」を共有指示に入れた。`principle-encode-lessons-in-structure` の強度の順と「構造で直したら文章は症状として削る」は本書の「形式化のサイクルを回す」に、`show-me-your-work` は置き場所がないため skill として新設した。記事のコメントで勧められていた Matt Pocock の `grill-with-docs` は、中身の `grilling` がすでに `grill-me` に入っているので、もう一方の `domain-modeling`（用語集と ADR）だけを `grill-me` の一節として足した。orchestrate playbook とモデルの振り分けは、単一ホストで Herdr が担う部分と重なるため入れていない。

四回目は取り込みではなく、取り込んだ原則を手元の実績に当てた。`correct` の「失敗はクラスで数える」を、`agent-usage-review` の snapshot に「繰り返し失敗」の節として足し、拒否ルール・lint の code・fail-fast・bash の service mode 拒否を週ごとに数えるようにした。その集計で週をまたいで繰り返していたものは、文面を足さずに構造で直した。bash の `name` と `async` の併用は OMP extension で引数を直し、shellcheck の SC2016 と SC1091 は lint-on-edit から外し、`shell-read-search` は件数・存在確認の grep と scratch・`/tmp`・ログへの読み取りを許すよう範囲を絞った。`guard-the-context-window` の段階的開示は、自作の `cognitive-rhythm-writing` を本体と `references/` に分ける形で当てた。

五回目は、sc30gsw の Zenn 本「[【Cursor pstack】AIエージェントに開発を任せる環境をつくる](https://zenn.dev/sc30gsw/books/080faba713547b)」の全44章と付録、pstack 本体（`0b8e952`）を、章ごと・skill ごとに読み直した。これまでの四回で入っていないものだけを、置き場所のある既存 skill に一節ずつ足している。`architect` の「呼び出し側から骨組みを書き、形の違う二案を比べ、作り込む途中で崩れの兆候が出たら骨組みを捨てる」、`why` の由来のたどり方、冪等性と共有状態の二原則は `software-design` に入れた。`principle-fix-root-causes` の「その状態は正当か」で直す場所を分ける考え方と、赤いテストは報告された症状と同じ理由で落ちることを確かめる手順は `diagnosing-bugs` に入れた。`build-the-lever` は `structural-edit` に、型の規律は `efficient-ts-js` に、`pause-safely`・`swarm`・`ketchup` は `show-me-your-work` に、`sharpen` の「指定しすぎも点検する」は `task-briefing` に入れた。検証の振り分けで観測側を先に疑う手順は `create-verification-skill`、変更より前のスクショを証拠にしない規則は `browser-verify`、rebase 後の `git patch-id` 比較は `github-pr-review`、flaky の再実行を一度に限る規則は `github-pr-respond` が受け持つ。共有指示に足したのは二つだけである。一つは PR 本文にスコープ外と波及範囲を書くこと、もう一つはゲートを緩めて通さないことだ。`recall` を元にした skill は作らなかった。過去セッションは OMP の eval にある `archive` で引けるうえ、使う頻度もまだ測れていない。審査基準を隠す arena と、複数モデルの合議も入れていない。

六回目は、pstack を `0148b78`（0.15.27）まで追い、五回目の記録に名前のない skill を読んだ。五回目以降の上流の変更は `sharpen` から一文を消しただけで、`task-briefing` に入れた内容には関係しない。Zenn 本も 2026-10-18 に本文が更新されている。章ごとの更新日は各章の viewer に出るが、五回目に読んだ時点の日付も本文の写しも残していないため、どの章が変わったかは確かめていない。足したのは三つある。`principle-test-behavior-not-implementation` の「呼ばれないことの assert は、呼び出しが必要な入力で同じ依存を動かし、呼ばれることを確かめるケースと対にする」を `test-design` に入れた。`principle-model-the-domain` が挙げる兆候のうち、互いに排他な状態を別々の boolean で持つことと、手順の名前で分けたモジュールを `software-design` の表に入れた。`typescript-best-practices` の「名前どおりに検査しない型ガードは `as` より悪い」は `efficient-ts-js` に入れた。`technical-writing` の Diátaxis は、置き場所になる日本語の文章 skill が上流から取り込んだものなので手を入れていない。`unslop` は `humanizer` とほぼ重なる。`create-formal-verification-skill` は、このリポジトリに model checker を当てる並行処理や状態機械がないので見送った。`teach` の図を段階的に描く手順は以前に見送っており、`reflect` は `omp-reflect` と、`automate-me` は共有指示と `agent-usage-review` と重なる。`make-bot-ui` と `poteto-help` は Cursor 専用である。

七回目は、Zenn 本の全53ページ（44章、部の扉、はじめに、付録、おわりに）を描画して写しを `.agent-msgs/scratch/zenn/` に残し、その写しを章ごとに今の skill と突き合わせた。pstack は `0148b78` から動いていない。はじめにの改訂表の最新は第8版（0.15.25）で、その変更点はすべて五回目・六回目で入っていた。足したのは三つある。第41章が挙げるエージェント向け CLI の性質（機械が読める出力、次のコマンドまで書くエラー、段階的な `--help`、破壊的な操作の `--dry-run`）は `create-verification-skill` の Helpers に入れた。第43章の「複数案を実際に作り、スクリーンショットや測った値で選ぶ」は、観測できる振る舞いが違う案に限って `software-design` の骨組みの手順に入れた。第16章の「待機中のエージェントを進捗確認のために再開せず、残した痕跡を読み取り専用で数える」は `omp-herdr-collab` のやらないことに入れた。見送ったものは次のとおり。「失敗するテストのコミットを修正の下に置く」は、各コミットが単独で通る（bisect できる）という共通指示の前提と衝突する。途中で見つけた問題を次の回で直す自己修復は、無関係な修正は follow-up として報告するという共通指示と衝突する。計画書を完了後に消す運用は、承認済み計画を `.agent-msgs/plans/` に残す共通指示と衝突する。起動ごとの Effort 選択は、`omp/config.yml` の modelRoles に任せている。抑止コメントに期限と承認者を書く規則は、一人で使うリポジトリでは承認者が常に本人になる。サブエージェントの返却量の上限は「大きなものはファイルパスで渡す」でほぼ覆われている。TypeScript の引数をオブジェクトで渡す規則と構造化ログは、使い捨てのスクリプトが中心の `efficient-ts-js` には合わない。

続けて、向きを逆にして skill ごとに本の写しを当てた。足したのは六つある。第32章の「期待値は本来あるべき挙動にし、既存のアサーションを弱めない」を `test-design` に入れた。第11章の「効くかもしれない変更は確かめていない仮説であり、証拠が仮説を否定したらその変更を戻す」を `diagnosing-bugs` の修正手順に入れ、`local.patch` を作り直した。第14章からは三つを `github-pr-respond` に入れた。指摘を消すためだけにコードを変えない。修正は1回の push にまとめる。子 PR がある PR では、レビュー対応で履歴を書き換えない（親がマージされた後に子を移すのは別の手順で、本でも分けている）。第13章の「構造を変えた skill は試し、文調だけなら省く」と、第36章の「新しいチェックが過去の違反を止めることを確かめる」は、`omp-learning-loop` の実動確認に入れた。第27章の「入口が複数ある機能は、すべての入口を操作して初めて確かめたことになる」は `create-verification-skill` の保守に入れた。第34章の「PR 説明は1分で読める長さにし、ログや SHA の一覧はリンクにする」は、共通指示の PR の項に入れた。見送ったものは次のとおり。worktree の片付け条件は、未コミットの作業を消す場合は既存の「破壊的な操作は先に確認する」で覆われ、マージ済みの worktree を消すのはブランチが残るので害がない。保守の頻度（1日1回）は利用者の運用方針で決まる。到達不能の確認をやり直す規則は、到達不能を合格扱いしない既存文で足りる。既存の `as` を取り除く手順は、使い捨てのスクリプトが中心の `efficient-ts-js` には合わない。skill の修正を別 PR に分ける規則は、論理単位で commit を分ける共通指示で足りる。

## 追加するときの判断

新しい規範を書きたくなったら、まず既存の skill の節として足せないかを見る。毎ターン読ませたい一行ポインタだけを `agents/global-instructions.md` に置き、手順や判断基準は skill、導入・運用の手順は `docs/` に書く。skill を増やしたら `scripts/link` を実行して各ホストの skills ディレクトリへ symlink し、`omp -p --no-session "read skill://<name>"` で新しいセッションから読めることを確かめる。

## 形式化のサイクルを回す

`agents/measured-notes.md` の `Mechanized:` 欄はこのリポジトリにおける形式化の実装である。判断が繰り返し必要になったら、まず構造的な信号に落とせないか試す。強い順に、型や schema で誤った状態を作れなくする、semgrep ルールやテストで commit を止める、hook・permission・skillOverrides で実行時に止める、の三段を当たる。落とせれば prose 規則を機械的な強制に置き換え、常時注入の一行ポインタだけを残せる（毎ターンの再判断が要らなくなる分だけ、共有指示は削れる）。強制が入った規則の本文を「念のため」残すと、二つの正本がずれていく。仕組みで直したなら、文章の側は症状として削る。

落とせない判断は、理由を書いて次回の判断コストを下げる。そのうえで規則を目立つ位置に移し、実際に起きた失敗例を一つ添える。抽象的な規則だけでは、エージェントは自分の行動がその規則に当たると気づきにくい。

間違いを機械化の対象に数えるのは、同じ種類の間違いが二度起きてからにする。一度きりの失敗に規則を足しても、再発する証拠がないまま規則だけが増える。hook・semgrep ルール・テストを足したら、記録に残っている過去の実例（該当コミットの差分や `measured-notes.md` の事例）をそのチェックに通し、実際に落ちることを確かめる。過去の実例で落ちないチェックは、その間違いを防げる根拠にならない。

新しいチェックを入れた時点で既存の違反が残っているなら、違反を baseline として記録し、新しい違反だけを落とす。baseline は減らす向きにだけ更新し、増やす変更は通さない。ゲートの閾値や除外を緩めて通すのも、baseline を増やすのと同じ扱いにする。

`Mechanized: no` の行は解決済みの課題ではなく、新しい signal（hook の新機能、設定スキーマの追加、ファイル規約の整備）が出たときに再挑戦する対象のキューとして読む。逆に「no」のまま放置すると、後から追加した機械化に記録が追いつかず、規則が二重管理になる（2026-08-26 の `skillOverrides.update-config` 追加が測定ノートに反映されず 2026-09-16 まで "no" のままだった例がある）。skill や hook を足して既存の判断を機械化したら、対応する measured-notes.md のエントリを同じコミットで更新する。
