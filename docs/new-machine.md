# 新しいMacのセットアップ手順

新しいMacにこの環境をクリーンセットアップで再現する手順。
移行アシスタントやTime Machineからの復元は使わない前提で書いている。
1〜6節を上から順に実行し、7節の一覧で漏れを確認して、8節の検証で仕上げる。
日常運用（パッケージの層分け、OMPの使い方、レビュー運用）はREADMEと `docs/omp.md` にあり、この文書は移行のときにだけ読む。

未検証：フレッシュなmacOSでの通し実行はまだ経ていない（現行マシンの状態調査から起こした手順）。
次回の移行で詰まった箇所は、その場でこの文書に追記する。

## 1. 旧マシンでの持ち出し確認

- dotfilesを最新にしてpushする：`./scripts/sync`
- 7節の一覧を見て、リポジトリ外の機械ローカル状態のうち引き継ぐものを確認する。
  秘密情報は1Passwordが正本なので、ファイルとして持ち出すものは原則ない。
- 他リポジトリの未pushコミットと未コミットの作業ツリーを掃く。

## 2. 新マシンで最初にやる2つ

- App Storeにサインインする。
  `scripts/apps`（brew bundle）の `mas` 行は、サインインしていないとインストールに失敗する。
- コマンドラインツールを入れる：`xcode-select --install`。
  クローンに使うgitがこれで動くようになる。

## 3. クローンして ./scripts/setup を実行する

```bash
git clone https://github.com/tyamahori/dotfiles.git ~/project/dotfiles
cd ~/project/dotfiles
./scripts/setup
```

- SSH鍵はまだ使えないのでHTTPSでクローンする（公開リポジトリなので認証も不要）。
- 実行中にsudoパスワードを何度か求められる（Spotlight無効化、Homebrew、Nixインストーラ）。
- 各スクリプトは冪等なので、途中で失敗しても原因を直して `./scripts/setup` を再実行すればよい。
- 実行内容と順序はREADMEの「Setup」節のとおり（init → apps → devbox → python → link → omp-plugins）。

## 4. 認証を復元する

上から順に進める。後の項目が前の項目に依存する。

### 1PasswordとSSH

1. 1Passwordにサインインし、設定 > 開発者 で「SSHエージェントを使用」を有効にする。
2. `~/.ssh/config` を作り、次を書く（このファイルは機械ローカルで、リポジトリ管理外）：

```
Host *
	IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

以後、SSHリモートへの `git push` は1PasswordのGUI承認を伴う。
1Passwordがロック中のpushは `communication with agent failed` で失敗する。
これはネットワークや認証設定の問題ではないので、リモートやSSH設定をいじらず1Passwordを解錠する。
OrbStack用のInclude行は、OrbStackの初回起動時にOrbStack自身が追記する。

### GitHub CLI

```bash
gh auth login
```

`.gitconfig` のcredential helperはgh経由なので、HTTPSリモートはこれで通るようになる。
`gh` 本体はsetupの管理外。未導入なら手動で導入し、`gh` がある状態で `scripts/init` を再実行すると `gh-copilot` 拡張が入る。

### エージェントCLI

- Claude Code：`claude` を起動してログインする。
- Codex：`codex` を起動してログインし、`/hooks` を開いてリンク済みフック定義と ponytail / plannotator のライフサイクルフックを trust する（README の「Japanese prose review」節、`docs/ponytail.md`、`docs/diagram-workflow.md`）。
- OMP：`omp` を起動して各プロバイダにログインする。資格情報は `~/.omp/agent/agent.db` に入る（機械ローカル）。

ponytail は 6節までのスクリプトで自動導入される（OMP は `scripts/omp-plugins`、Codex は `scripts/link`、Claude Code は `claude/settings.json` の宣言）。図表/レビュー系では、plannotator も `scripts/link` でバイナリと共通 skills、Claude Code は `claude/settings.json` で plugin、OMP は `scripts/omp-plugins` で pi-extension を再現する。archify は `scripts/link` が global skill として補完する。Codex の hook trust だけ手動。詳細は `docs/ponytail.md` と `docs/diagram-workflow.md`。

### GUI常駐アプリ

Karabiner-Elements、Raycast、SoundSourceなどは初回起動時にアクセシビリティや入力監視の許可を求める。
OrbStack、Superwhisper、Slackなどは各自サインインする。

## 5. jbcontextを再構築する（setupは面倒を見ない）

セマンティック検索のjbcontextは自前のインストーラで `~/.jbcontext/` に入り、dotfilesの自動化の外にある。
順序が重要で、特に3と4を飛ばすとリポジトリ管理ファイルが書き換えられたままになる。

1. [JetBrains/context](https://github.com/JetBrains/context) の手順でインストールする。
   JetBrains AIのトークン（`~/.jbcontext/grazie-token-prod.json`）を使うため、初回にアカウント認証がある想定（未検証）。
2. `jbcontext setup-agent --auto` を実行する（Claude CodeとCodexの両方が対象になる）。
3. 直後に `git -C ~/dotfiles status` を確認する。
   setup-agentは共有指示ファイル（`agents/global-instructions.md`）を単一エージェント流儀に書き換えるので、差分が出ていたらエージェント中立版（コミット `e674eb5` の形）に再マージする。
   `claude/settings.json` に差分が出た場合もrevertする。jbcontextのClaudeフックの置き場は `~/.claude/settings.local.json` であり、リポジトリ管理の `settings.json` には入れない。
4. 再書き換えの検知が効いていることを確認する。かつての予防フラグ（`agentSetups` の `hooks` / `instructions` 無効化）は0.9.11系のスキーマ変更で消滅しており、防御は検知に移行済み。`scripts/jbcontext-clobber-check`（Claude / Codexの SessionStart フック）と `omp/extensions/jbcontext-clobber-guard.ts` が、セッション開始時に監視対象2ファイルの未コミット差分を警告する。

自動更新や手動の `setup-agent` 再実行で書き換えは再発する。
警告が出たら3の再マージをやり直し、`~/.jbcontext/logs/jbcontext.log` のAutoUpdater行と突合する。

## 6. launchdジョブの有効と無効を選ぶ

`scripts/link` はlaunchdジョブを描画してロードするが、明示的なdisable状態は尊重する。
現行マシンでは `com.tyamahori.ollama` を無効にしている（ollamaは必要なときに `ollama serve` で起動する運用）。
同じ状態にするには次の2つを実行する。

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tyamahori.ollama.plist
launchctl disable gui/$(id -u)/com.tyamahori.ollama
```

## 7. リポジトリが持たない機械ローカル状態

移行のたびにここを見て、引き継ぐものと作り直すものを判断する。

| パス | 中身 | 新マシンでの復元 |
|---|---|---|
| `~/.ssh/config` | 1Password IdentityAgentとOrbStackのInclude | 4節で手書き |
| `~/.claude/settings.local.json` | jbcontextのClaudeフック | 5節のsetup-agentが生成 |
| `~/.jbcontext/` | 本体、config.json、JetBrains AIトークン | 5節 |
| `~/.omp/agent/agent.db` ほか | OMPの資格情報とセッション履歴 | 再ログイン（履歴は持ち越さない） |
| `~/.codex/auth.json` など各CLIの資格情報 | エージェントCLIのログイン状態 | 再ログイン |
| `git/sensitive-patterns.local` | pre-commitガードの追加パターン | 必要になったら再作成 |
| `~/.wakeup` | 別プロジェクトのsleepwatcherフック | そのプロジェクト側の手順で再リンク |
| launchdのdisable状態 | ジョブごとの有効と無効の選択 | 6節 |
| Composeプロジェクト`sonarqube`のDocker volumes | ローカル解析履歴と設定 | `sonar-quality-gate`の初回実行で再作成 |
| macOS Keychainの`dotfiles-sonarqube-*` | ローカルServerのadminパスワードと解析token | `sonar-quality-gate`の初回実行で再生成 |

sleepwatcher本体はBrewfileで入るが、サービスの起動は手動：`brew services start sleepwatcher`。
`~/.wakeup` を使うプロジェクトを再構築するときだけでよい。

## 8. 検証

| 確認 | コマンド | 期待する結果 |
|---|---|---|
| python | `zsh -lc 'which python'` | `~/.local/bin/python` |
| devbox層 | `zsh -lc 'which go bun uv'` | devboxプロファイル配下のパス |
| brew bundle | `brew bundle check --file dotfiles/.Brewfile` | 依存が満たされている |
| リンク | `ls -l ~/dotfiles ~/.claude/CLAUDE.md` | 本リポジトリを指すsymlink |
| SSH | `ssh -T git@github.com` | 1Password承認の後に認証成功 |
| skills | `ls ~/.claude/skills` | authored skillsのsymlinkと `archify` / `plannotator-*` が見える |
| plannotator | `plannotator --version` | バージョンが表示される |
| archify | `node ~/.agents/skills/archify/bin/archify.mjs doctor` | `Archify is ready.` |
| Claude plugin | `claude plugin list` | `plannotator@plannotator` が enabled |
| OMP | `omp plugin list` | `@plannotator/pi-extension` が入っている |
| ponytail | 各CLIで「ponytailのルールは注入されているか」と質問 | `PONYTAIL MODE ACTIVE — level: full` を引用して回答（`docs/ponytail.md`） |
| jbcontext | リポジトリ内で `jbcontext search "..."` | 検索結果が返る |
| launchd | `launchctl list \| grep tyamahori` | 6節で選んだジョブだけが載る |
| SonarQube | dotfiles内で`sonar-quality-gate` | ローカルServerが起動し、Quality Gateが返る |

最終更新：2026-08-29（クリーンセットアップでの通し実行は未経験）。
