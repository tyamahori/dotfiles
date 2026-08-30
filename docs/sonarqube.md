# ローカルSonarQubeの使い方

このガイドは、OrbStack上のローカルSonarQubeで、実装完了前にQuality Gateを確認する手順を扱う。
初回は「globalとprojectの境界」と「リポジトリを解析対象にする」まで読み、それ以降は必要な節だけ参照する。

## globalには実行環境、projectには解析設定を置く

SonarQubeのServer、Scanner、認証情報、AIエージェントの実行規約はdotfilesがmachine-globalに管理する。
project側の追加物は一つだけである。
rootの`sonar-project.properties`でopt-inと解析範囲を定義する。

| 管理場所 | 対象 |
| --- | --- |
| dotfiles | Homebrew packages、OrbStack Compose、`sonar-quality-gate`、global agent instructions |
| macOS Keychain | local admin password、analysis token |
| Docker volumes | SonarQubeの解析履歴とServer data |
| 解析対象リポジトリ | rootの`sonar-project.properties` |

`sonar.projectKey`、解析対象directory、言語固有設定はprojectごとに異なるため、設定ファイルはprojectのrootへ置く。
ただし、個人用として導入するだけならversion管理しない。
共有するかどうかは、project側で合意して決める。

## リポジトリを解析対象にする

解析対象リポジトリのrootへ`sonar-project.properties`を追加する。
runnerが必須とする項目は`sonar.projectKey`である。
最小構成は次のとおり。

```properties
sonar.projectKey=<owner>-<repository>
sonar.projectName=<repository>
sonar.sources=.
sonar.sourceEncoding=UTF-8
```

### 個人利用では`.git/info/exclude`へ追加する

既存の共有repositoryへ個人用として導入する場合は、`sonar-project.properties`をcommitしない。
共有の`.gitignore`も変更せず、repository内だけに効く`.git/info/exclude`へ追加する。
worktreeでも正しいexclude fileを選べるように、pathはGitから取得する。

```bash
exclude_file=$(git rev-parse --git-path info/exclude)
printf '%s\n' 'sonar-project.properties' >> "$exclude_file"
```

`.git/info/exclude`はrepositoryへcommitされず、ほかの利用者には影響しない。
すでに追跡されているファイルはexcludeの対象にならない。
チームで同じ解析設定を使うと合意した場合だけ、`sonar-project.properties`をversion管理する。

### 解析対象はGit管理済みファイルに限る

未追跡は除く。
runnerは実行時に対象を検出し、既存の`sonar.exclusions`へ追加する。
`.gitignore`や`.git/info/exclude`に登録されたファイルには、SonarQubeのSCM除外を適用する。

Git管理済みファイルにworking tree上の変更がある場合は、その変更後の内容を解析する。
新規ファイルは`git add`でGitの追跡対象に入るまで解析しない。

`sonar.projectKey`はlocal Server内で一意にする。
GitHubの`owner-repository`形式に揃えると、同名repositoryを区別できる。

テストをsourceと分ける場合は、projectのdirectory構成に合わせて指定する。

```properties
sonar.sources=src
sonar.tests=test
sonar.exclusions=test/**
```

Python versionなどの解析条件もproject側へ置く。

```properties
sonar.python.version=3.14
```

別projectの設定をそのままコピーせず、存在するdirectoryと言語だけを指定する。
rootに`sonar-project.properties`がないリポジトリでは、`sonar-quality-gate`は成功扱いでskipする。

## Quality Gateを実行する
順序は変えない。

通常のbuild、test、lintを先に実行し、その結果が通ってから次のcommandを実行する。

```bash
sonar-quality-gate
```

commandはGit repository内のどのdirectoryから実行してもよい。
Git rootを検出して、次の処理を順に行う。

1. OrbStackでSonarQube Serverを起動する。
2. `http://sonarqube.local`が応答するまで待つ。
3. 初回にadmin passwordとanalysis tokenを生成してmacOS Keychainへ保存する（保存済みtokenが無効になっていた場合は再生成する）。
4. 未作成のprojectをlocal Serverへ登録する。
5. `sonar-scanner`を実行し、Quality Gateの判定を最大300秒待つ。

成功時はScanner logに次の行が出る。

```text
QUALITY GATE STATUS: PASSED
```

Claude Code、Codex、OMPは、rootに`sonar-project.properties`があるリポジトリで、通常の検証後にこのcommandを一度実行する。
解析結果はlocal Serverだけに送られ、SonarQube Cloudへは送られない。

## 解析結果をブラウザで確認する

DashboardはOrbStackのlocal domainから開く。

```bash
open http://sonarqube.local
```

通常はcredentialを表示しない。
admin passwordが必要な場合だけ、Keychainから明示的に取得する。

```bash
security find-generic-password \
  -a admin \
  -s dotfiles-sonarqube-admin \
  -w
```

passwordやanalysis tokenをrepository、shell history、`.env`へ保存しない。
通常の解析では`sonar-quality-gate`がKeychainを読むため、利用者がtokenを取得する必要はない。

## Serverを操作する
普段は手動操作しない。

Compose fileは`~/dotfiles/sonarqube/compose.yaml`にある。
OrbStackの自動domain routingを使うため、host portは公開しない。

Serverを明示的に起動する場合は次を実行する。

```bash
docker compose -f ~/dotfiles/sonarqube/compose.yaml up -d
```

停止しても解析履歴は消えない。

```bash
docker compose -f ~/dotfiles/sonarqube/compose.yaml stop
```

異常時はまずServer logを見る。

```bash
docker compose -f ~/dotfiles/sonarqube/compose.yaml logs --tail=100 server
```

稼働状態はHTTP APIでも確認できる。

```bash
curl -fsS http://sonarqube.local/api/system/status | jq
```
statusが`UP`なら正常である。

`sonar-quality-gate`は、OrbStack再起動後に`sonarqube.local`の登録が消えていた場合、Containerを再起動して登録を回復する。
手動でDNS設定や`/etc/hosts`を変更しない。

## local dataを初期化する

この操作は破壊的である。
次の操作は解析履歴、project、tokenを削除するため、local Serverを作り直す場合だけ実行する。

```bash
docker compose -f ~/dotfiles/sonarqube/compose.yaml down -v
security delete-generic-password \
  -a admin \
  -s dotfiles-sonarqube-admin || true
security delete-generic-password \
  -a "$USER" \
  -s dotfiles-sonarqube-token || true
```

初期化後に`sonar-quality-gate`を実行すると、Server、認証情報、projectを作り直す。
`docker compose down`を`-v`なしで実行した場合は、Docker volumesと解析履歴を保持する。

## エラーから復旧する

### `skipped; ... has no sonar-project.properties`

これは正常終了である。
対象リポジトリはopt-inしていない。
解析する場合はrootへ`sonar-project.properties`を追加する。

### `SonarQube did not become ready`

OrbStackが起動していることを確認してから、`sonar-quality-gate`を再実行する。
Containerが動いているのにdomainが解決しない場合も、runnerがContainerを再起動して復旧を試みる。

### Keychainのadmin passwordが無効

Docker volumesとKeychainのどちらか一方だけを削除すると、Serverと保存済みcredentialが一致しなくなる。
解析履歴が不要なら、「local dataを初期化する」の手順で両方を削除して作り直す。
解析履歴を残す必要がある場合は、Serverのadmin passwordを確認してKeychain項目を復旧する。

### Scannerのwarningだけが出る

warningだけでは失敗ではない。
未commit fileのblame情報不足やScanner内部のJava warningは、Quality Gateの成否とは別である。
最後の`QUALITY GATE STATUS`とcommandのexit statusで結果を判断する。

## commandの役割を区別する

三つのcommandは別物である。
`sonar-quality-gate`は、このmachineのlocal Server起動、認証、project登録、Scanner実行をまとめる入口である。
内部では`sonar-scanner`がrepository全体を解析する。

Homebrew caskの`sonarqube-cli`が提供する`sonar`は別のcommandであり、このQuality Gateでは使わない。
`sonar`のserverless analysisはSecrets detectionに限定されるため、通常の完了前検査を置き換えない。

最終更新日：2026-08-29
