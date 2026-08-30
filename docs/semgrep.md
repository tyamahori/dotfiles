# ローカルSemgrepの使い方

このガイドは、実装完了前にSemgrepでrepository固有のpattern検査を行う手順を扱う。
初回は「SonarQubeとの使い分け」と「リポジトリを検査対象にする」まで読み、それ以降は必要な節だけ参照する。

## SonarQubeとの使い分け

二つのgateは役割が異なるため、置き換えではなく併用する。

| gate | 得意分野 | 実行形態 |
| --- | --- | --- |
| `sonar-quality-gate` | 言語別の品質rule、重複、履歴つきのQuality Gate判定 | OrbStack上のlocal Serverで解析 |
| `semgrep-quality-gate` | repository固有ruleとsecurity patternの即時検査 | serverなしでCLIが数秒で完了 |

SonarQubeのcustom ruleはplugin開発を要するのに対し、SemgrepのruleはYAMLのpatternで書ける。
「このrepositoryで過去に起きたbugの類型を機械検査にする」用途はSemgrepが担う。
coverageや重複などの履歴つき品質判定はSonarQubeが担う。

## globalには実行環境、projectには検査ruleを置く

runner、Semgrep本体、AIエージェントの実行規約はdotfilesがmachine-globalに管理する。
project側の追加物は一つだけである。
rootの`.semgrep.yaml`でopt-inと検査ruleを定義する。

| 管理場所 | 対象 |
| --- | --- |
| dotfiles | devbox globalの`semgrep`、`semgrep-quality-gate`、global agent instructions |
| 検査対象リポジトリ | rootの`.semgrep.yaml` |

## リポジトリを検査対象にする

検査対象リポジトリのrootへ`.semgrep.yaml`を追加する。
最小構成は次のとおり。

```yaml
rules:
  - id: <rule名>
    languages: [generic]
    severity: ERROR
    message: <指摘時に表示する説明と修正方法>
    pattern: <検出したい文字列pattern>
    paths:
      include:
        - <検査するdirectory>
```

rule構文（`patterns`、`pattern-not-inside`、`metavariable-pattern`など）は[Semgrepのrule文書](https://semgrep.dev/docs/writing-rules/overview)を参照する。
shell scriptのように専用parserが未成熟な言語は、`languages: [generic]`のtext patternで検査する。
`.semgrep.yaml`自体はrunnerが検査対象から除外するため、rule内のpattern文字列が自己マッチすることはない。

既存の共有repositoryへ個人用として導入する場合は、SonarQubeと同じく`.semgrep.yaml`をcommitせず`.git/info/exclude`へ追加する（[`docs/sonarqube.md`](sonarqube.md)の該当節を参照）。
チームで同じruleを使うと合意した場合だけversion管理する。

rootに`.semgrep.yaml`がないリポジトリでは、`semgrep-quality-gate`は成功扱いでskipする。

## registry rulesetを取り込む

Semgrep公式のregistry ruleset（`p/secrets`など）を使う場合は、参照ではなくfileへ取り込む。
runnerは解析をlocalに保つため`--metrics=off`で実行しており、registryの動的参照はmetrics送信なしでは動かない。

```bash
curl -fsS https://semgrep.dev/c/p/<ruleset名> >> .semgrep.yaml
```

取り込んだfileは`rules:`配下のlistが重複するため、複数取り込むときは手で一つの`rules:`にまとめる。
取り込み後は内容を確認し、不要なruleを削ってからcommitまたはexcludeする。

## Quality Gateを実行する

通常のbuild、test、lintを先に実行し、その結果が通ってから次のcommandを実行する。

```bash
semgrep-quality-gate
```

commandはGit repository内のどのdirectoryから実行してもよい。
Git rootの`.semgrep.yaml`をruleとして`semgrep scan`を実行し、指摘が1件でもあればexit statusが非0になる。
`.gitignore`されたファイルは検査しない。
Claude Code、Codex、OMPは、rootに`.semgrep.yaml`があるリポジトリで、通常の検証後にこのcommandを一度実行する。

誤検知を1行だけ抑止する場合は、該当行に理由つきで`# nosemgrep: <rule id>`commentを置く。
抑止が繰り返し必要なruleは、rule側の`pattern-not-inside`や`paths`を直す。

## エラーから復旧する

### `skipped; ... has no .semgrep.yaml`

これは正常終了である。
対象リポジトリはopt-inしていない。
検査する場合はrootへ`.semgrep.yaml`を追加する。

### `semgrep is required`

`~/dotfiles/scripts/devbox`を実行してdevbox globalへ`semgrep`を導入する。

### rule fileの構文エラー

`semgrep scan`はrule fileをparseできないと失敗する。
指摘との区別は、出力末尾のScan Summaryとexit statusで判断する。

最終更新日：2026-08-30
