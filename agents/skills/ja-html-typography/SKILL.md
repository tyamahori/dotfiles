---
name: ja-html-typography
description: 日本語の HTML を人が読む成果物（Claude Artifact に上げる資料、関係者向けレポート、一枚ものページ）として手書きするとき、frontend-design と一緒に読む。狭い表示幅で崩れる改行（数値と単位の分断、式の途中折返し、表の列潰れ、識別子の任意位置切断）を CSS とマークアップで防ぐ規範と検証手順。
---

# ja-html-typography

`frontend-design` は配色・書体・レイアウトを決めるが英語前提で、和文の改行は扱わない。
Claude Artifact のプレビュー枠は 560〜720px 程度と狭く、PC 幅で整って見えた HTML の改行がそこで崩れる。
この skill はその崩れ方ごとに対処を固定する。

## ベース CSS

`body` に必ず入れる。すべて Chromium 150 / Safari 18 以降で有効。未対応環境では無視されるだけで害はない。

```css
body {
  line-break: strict;          /* 行頭禁則（小書き仮名・長音・句読点が行頭に来ない） */
  text-autospace: normal;      /* 和欧間のアキをブラウザに任せる。ソースに半角スペースは入れない */
  text-spacing-trim: normal;   /* 約物の連続を詰める */
}
p, li, dd, td { text-wrap: pretty; }                       /* 1 文字だけの行を避ける */
h1, h2, h3, th, caption, dt { word-break: auto-phrase; }   /* 文節で折る */
h1, h2, h3 { text-wrap: balance; }
.nowrap { white-space: nowrap; }
```

## マークアップの規則

0. **`<!DOCTYPE html><html lang="ja">` と `<meta charset="utf-8">` を必ず書く。** `<title>` や `<style>` から始めた断片は quirks mode で描画され、`lang` が無いと `word-break: auto-phrase` は何もせず、フォールバック字形も中国語寄りになる。
1. **数値・欧文と和文の間に半角スペースを入れない。** `3 つ` `100 万円` の空白は改行候補になり、`100` と `万円` が別の行に分かれる。`3つ` `100万円` と書き、見た目のアキは `text-autospace` に任せる。
2. **分けてはいけない語は `.nowrap`。** 日付（`2026-01`、`2026-09-07` は全体を）、`TASK-140` のような ID、金額と単位、`〜` で結んだ範囲。ハイフン後の改行は `line-break` では止まらない。
3. **式・コードブロックは折り返さない。** `white-space: pre; overflow-x: auto`。`pre-wrap` + `overflow-wrap: anywhere` は演算子の途中で折れて意味が壊れる。
4. **表は列を潰さず横スクロールへ。** `table { min-width: <列数に応じた rem> }` を包む `div { overflow-x: auto }`。先頭列のラベルと `td code` は `white-space: nowrap`。列が 5 本を超えたら 3 行に伸びたセルが必ず出る。
5. **識別子は任意位置で切らない。** 本文中の `code` には `overflow-wrap: anywhere` を許すが、表や定義リストでは外し、長い識別子は `_` の後ろに `<wbr>` を置いて区切りでだけ折れるようにする。
6. **`<br>` を使わない。** 一文一行の Markdown を HTML にするときは文をつなげて `<p>` にする。セル内や `<dt>` で複数項目を縦に並べるときは項目ごとに `<div>` / `display: block` の `<span>` にする。改行を残すと閲覧幅ごとに折返し位置が二重になる。
7. **書体は和文フォールバックを必ず並べる。** Web フォントが読めない環境（Artifact の CSP、オフライン）でも崩れないよう `"Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif` を末尾に置く。

## 検証

Artifact 幅で描画して確認する。OMP は `browser` ツール（headless）、Claude Code / Codex は `browser-verify` skill の経路に従う。

```js
// 560px と 720px の両方で
document.compatMode === 'CSS1Compat' && document.documentElement.lang === 'ja'
[...document.querySelectorAll('.nowrap')].filter(s => s.getClientRects().length > 1).length   // 0 件
document.documentElement.scrollWidth > innerWidth            // false であること（横はみ出しなし）
[...document.querySelectorAll('pre')].every(p => getComputedStyle(p).whiteSpace === 'pre')
[...document.querySelectorAll('td:first-child')].filter(td => {   // 先頭列が折れているセル。0 件であること
  const r = document.createRange(); r.selectNodeContents(td); return r.getClientRects().length > 1;
}).length
```

スクリーンショットは `<git toplevel>/.agent-msgs/screenshots/` に置き、数値と単位・日付・式が同じ行にあることを目で確認する。

## 既存 HTML に後から当てる

テキストノードだけを対象に `(\d)[ ](和文)` と `(和文)[ ](\d)` の空白を除き、`pre` を `white-space: pre; overflow-x: auto` に変え、上のベース CSS を足す。タグ属性や `<style>` の中は触らない。
