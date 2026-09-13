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
| テスト設計（変更種別ごとに要るテスト、name the break、実物 > fake > stub > mock、特性テスト、property-based、mutation check、消すべきテスト） | `agents/skills/test-design/SKILL.md` | テストを書く・直す・消す前、mock や helper を足す前 |
| 依頼の枠組み（背景・課題・ゴール・スコープ・成果物） | `task-briefing`、前提を問い直すなら `grill-me` | 着手前、依頼が曖昧なとき |
| 複雑タスクの工程（調査 → 計画 → 独立レビュー → 証拠つき納品） | `sureforge` | 複数ファイル・複数段階の実装 |
| バグ診断（仮説と再現、根本原因の証拠） | `diagnosing-bugs`、共有指示の「Root-cause claims need reproduction」 | 障害・不具合・性能劣化 |
| レビュー（変更種別ごとの必須質問、fresh context での反証、Copilot 事前確認、過剰設計の摘出） | `github-pr-review`、`adversarial-verification`、`copilot-preflight`、`ponytail-review` / `ponytail-audit`、OMP の `reviewer` / `security-reviewer` | PR の前後 |
| 構造的な編集（rename、参照列挙、codemod） | 共有指示の「Structural edits」、`structural-edit`、OMP `lsp` / `ast_edit` | 複数箇所に及ぶ書き換え |
| 言語別のスクリプト作法 | `efficient-python`、`efficient-ts-js` | スクリプトを書く・実行する前 |
| 品質ゲート（semgrep、SonarQube、ruff、commit-msg の Why 検査） | `docs/semgrep.md`、`docs/sonarqube.md`、`ruff/ruff.toml`、`git/global-hooks/` | commit 時、完了報告前 |

## 意図的に書いていないもの

言語やフレームワーク固有の規約（Laravel のディレクトリ構成、React の状態管理の選び方など）は、そのプロジェクトの `AGENTS.md` / `CLAUDE.md` に置く。dotfiles は複数プロジェクトをまたぐ規範だけを持ち、個別プロジェクトの設計判断は各リポジトリの ADR とコミットログに残す。レビューの契約（タグ、状態遷移、台帳）は `omp-herdr-collab` が正本であり、この地図では扱わない。

## 公開スキルを調べたうえで自作にした

2026-09 に `npx skills find` で設計・テスト・リファクタリング・ADR の公開スキルを調べた。テスト設計は `obra/superpowers` の `test-driven-development`（約22万インストール）と `addyosmani/agent-skills` の同名スキルが強く、設計は `markduan/a-philosophy-of-software-design-skills` など採用実績の薄いものしかなかった。リファクタリングは `wondelai/skills` の `refactoring-patterns`、ADR は `wshobson/agents` と `addyosmani/agent-skills` の `documentation-and-adrs` が候補だった。

そのまま入れなかった理由は三つある。superpowers はテストのないコードを削除する「Iron Law」を軸にしており、ponytail の「動く最小限」と衝突する。公開スキルはどれも英語の長文で、REST の命名規約やチェンジログの書き方まで含むため、skill 一覧の説明文と読み込み時の文脈を余計に消費する。そして dotfiles には `github-pr-review` の変更種別ごとの質問表や OMP の検証規範がすでにあり、そこへ接続する形で書くほうが重複を避けられる。

借りたのは中身である。superpowers の `writing-good-tests.md` から「name the break」「mock は自分の存在を assert しない」「mutation check」を、addyosmani から「まずスタックを発見する」「real > fake > stub > mock」「DAMP」「境界で検証し内側は信頼する」「Hyrum の法則」と ADR の「既存規約に合わせてから既定へ」を、Ousterhout から深いモジュールとエラーの定義消去を、Fowler から smell とカタログの対応を取り込んだ。出典は各 skill の末尾に残している。

## 追加するときの判断

新しい規範を書きたくなったら、まず既存の skill の節として足せないかを見る。毎ターン読ませたい一行ポインタだけを `agents/global-instructions.md` に置き、手順や判断基準は skill、導入・運用の手順は `docs/` に書く。skill を増やしたら `scripts/link` を実行して各ホストの skills ディレクトリへ symlink し、`omp -p --no-session "read skill://<name>"` で新しいセッションから読めることを確かめる。
