# dotfiles

- エージェントの引き継ぎメモは
  `.agent-msgs/handoff/YYYY-MM-DD-<topic>.md` に置く（日付は手仕舞い日）。
- `docs/ops/` の日誌はユーザーの作業物。エージェントは編集・commit しない
  （`git add -A` で巻き込まない）。
- リモートの取り込みは作業前後に `git status --short --branch` を確認し、
  `git pull --ff-only` だけを使う。
- pull 差分に `agents/` または `omp/` が含まれたら `scripts/link` を実行する。
- `omp/config.yml`・`omp/extensions/` を変えたら、設定と extension は起動時に
  読み込まれる（`docs/omp.md`）ので、稼働中の OMP セッションに再起動が必要だと伝える。
- SonarQube の前に、`docs/sonarqube.md`「このdotfilesでは、先にBunのカバレッジを
  生成する」の全テスト計測を実行する。レポートなしの Gate 単独実行はしない。
