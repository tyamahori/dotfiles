#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Generate a local Codex usage-insights HTML report."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
CODEX_DIR = HOME / ".codex"
OUTPUT_DIR = HOME / ".local" / "share" / "codex-insights"

CATEGORIES = {
    "実装・修正": ("implement", "fix", "add ", "修正", "実装", "追加", "作って", "変更して"),
    "レビュー": ("review", "レビュー", "確認して", "audit", "監査"),
    "調査・診断": ("diagnose", "debug", "investigate", "調べ", "原因", "診断", "なぜ"),
    "GitHub・PR": ("pull request", " pr ", "github", "commit", "コミット", "issue"),
    "文章・文書": ("document", "docs", "readme", "記事", "文章", "文書", "リライト"),
    "運用・自動化": ("deploy", "monitor", "cron", "automation", "デプロイ", "監視", "自動"),
    "計画・設計": ("plan", "design", "spec", "計画", "設計", "仕様"),
}


@dataclass
class Session:
    session_id: str
    path: Path
    started: datetime | None = None
    ended: datetime | None = None
    cwd: str = ""
    model: str = "unknown"
    source: str = "unknown"
    prompts: list[str] = field(default_factory=list)
    assistant_messages: int = 0
    tools: Counter[str] = field(default_factory=Counter)
    tool_errors: int = 0
    interruptions: int = 0
    compactions: int = 0
    total_tokens: int = 0
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    period = parser.add_mutually_exclusive_group()
    period.add_argument("--days", type=int, default=90, help="days to include (default: 90)")
    period.add_argument("--all", action="store_true", help="include all recorded sessions")
    parser.add_argument("--output", type=Path, help="HTML output path")
    return parser.parse_args()


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def text_from_message(payload: dict) -> str:
    message = payload.get("message")
    if isinstance(message, str):
        return message.strip()
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        item["text"]
        for item in content
        if isinstance(item, dict)
        and item.get("type") in {"input_text", "output_text", "text"}
        and isinstance(item.get("text"), str)
    ).strip()


def clean_prompt(value: str) -> str:
    value = re.sub(r"<environment_context>.*?</environment_context>", "", value, flags=re.S)
    value = re.sub(r"<in-app-browser-context.*?</in-app-browser-context>", "", value, flags=re.S)
    value = re.sub(r"# AGENTS\.md instructions.*?</INSTRUCTIONS>", "", value, flags=re.S)
    return re.sub(r"\s+", " ", value).strip()[:280]


def session_files() -> list[Path]:
    files = list((CODEX_DIR / "sessions").glob("**/*.jsonl"))
    files.extend((CODEX_DIR / "archived_sessions").glob("*.jsonl"))
    return sorted(files)


def read_session(path: Path) -> Session | None:
    current = Session(path.stem, path)
    last_usage: dict = {}
    try:
        lines = path.open(errors="replace")
    except OSError:
        return None
    with lines:
        for raw in lines:
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                continue
            timestamp = parse_time(record.get("timestamp"))
            if timestamp:
                current.started = timestamp if current.started is None else min(current.started, timestamp)
                current.ended = timestamp if current.ended is None else max(current.ended, timestamp)
            kind = record.get("type")
            payload = record.get("payload") or {}
            subtype = payload.get("type")
            if kind == "session_meta":
                current.session_id = payload.get("session_id") or payload.get("id") or current.session_id
                current.cwd = payload.get("cwd", "")
                current.source = payload.get("source") or payload.get("originator") or current.source
            elif kind == "turn_context":
                current.cwd = current.cwd or payload.get("cwd", "")
                current.model = payload.get("model") or current.model
            elif kind == "event_msg" and subtype == "user_message":
                value = clean_prompt(text_from_message(payload))
                if value and not value.startswith("# AGENTS.md instructions"):
                    current.prompts.append(value)
            elif kind == "event_msg" and subtype == "agent_message":
                current.assistant_messages += 1
            elif kind == "event_msg" and subtype == "user_message_interrupted":
                current.interruptions += 1
            elif kind == "event_msg" and subtype == "context_compacted":
                current.compactions += 1
            elif kind == "event_msg" and subtype == "token_count":
                usage = (payload.get("info") or {}).get("total_token_usage") or {}
                if usage:
                    last_usage = usage
            elif kind == "response_item" and subtype in {"function_call", "custom_tool_call"}:
                current.tools[payload.get("name") or "unknown"] += 1
            elif kind == "response_item" and subtype in {"function_call_output", "custom_tool_call_output"}:
                output = str(payload.get("output") or payload.get("content") or "")
                if re.search(r'"exit_code"\s*:\s*[1-9]|Process exited with code [1-9]|isError.?[:=].?true', output):
                    current.tool_errors += 1
    current.total_tokens = int(last_usage.get("total_tokens", 0))
    current.input_tokens = int(last_usage.get("input_tokens", 0))
    current.cached_tokens = int(last_usage.get("cached_input_tokens", 0))
    current.output_tokens = int(last_usage.get("output_tokens", 0))
    return current if current.started else None


def project_name(cwd: str) -> str:
    if not cwd:
        return "(unknown)"
    path = Path(cwd)
    try:
        parts = path.relative_to(HOME).parts
    except ValueError:
        return path.name
    if len(parts) >= 2 and parts[0] in {"project", "projects"}:
        return "/".join(parts[:3]) if len(parts) >= 3 else "/".join(parts)
    return parts[0] if parts else str(path)


def classify(prompt: str) -> str:
    lowered = f" {prompt.lower()} "
    scores = {name: sum(term in lowered for term in terms) for name, terms in CATEGORIES.items()}
    best, score = max(scores.items(), key=lambda item: item[1])
    return best if score else "その他"


def format_count(value: int) -> str:
    for size, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if value >= size:
            return f"{value / size:.1f}{suffix}"
    return str(value)


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def bars(items: list[tuple[str, int]]) -> str:
    peak = max((count for _, count in items), default=1)
    return "".join(
        f'<div class="bar-row"><span>{esc(name)}</span><div class="track"><i style="width:{max(2, count / peak * 100):.1f}%"></i></div><b>{count:,}</b></div>'
        for name, count in items
    )


def recommendations(sessions: list[Session], tools: Counter[str], prompts: int) -> list[tuple[str, str]]:
    errors = sum(s.tool_errors for s in sessions)
    compactions = sum(s.compactions for s in sessions)
    cached = sum(s.cached_tokens for s in sessions)
    inputs = sum(s.input_tokens for s in sessions)
    results: list[tuple[str, str]] = []
    if errors:
        results.append(("失敗を先回りする", f"ツール出力から {errors} 件の失敗を検出。反復する失敗は、再試行前に原因と前提条件を確認すると無駄なターンを減らせます。"))
    if compactions:
        results.append(("長いセッションを分割する", f"コンテキスト圧縮を {compactions} 回検出。大きな作業は durable な引き継ぎを残して新しいセッションへ分ける余地があります。"))
    if inputs and cached / inputs < 0.7:
        results.append(("再読込を減らす", f"入力トークンのキャッシュ比率は {cached / inputs:.0%}。長い資料は会話へ貼らず、ファイルパスで渡すと効率が上がります。"))
    if tools.get("exec_command", 0) > max(20, prompts * 3):
        results.append(("シェル往復をまとめる", "会話数に対してシェル実行が多めです。独立した読み取りや検索を一度にまとめると、待ち時間と文脈の増加を抑えられます。"))
    if not results:
        results.append(("現在の使い方を維持する", "履歴から大きな反復障害は見つかりませんでした。目的と完了条件を明示する運用を続けるのが有効です。"))
    return results[:4]


def render(sessions: list[Session], cutoff: datetime | None) -> str:
    prompts = [prompt for session in sessions for prompt in session.prompts]
    projects = Counter(project_name(s.cwd) for s in sessions)
    tools: Counter[str] = Counter()
    models = Counter(s.model for s in sessions)
    categories = Counter(classify(prompt) for prompt in prompts)
    for session in sessions:
        tools.update(session.tools)
    starts = [s.started for s in sessions if s.started]
    ends = [s.ended for s in sessions if s.ended]
    duration_hours = sum(
        (s.ended - s.started).total_seconds() / 3600
        for s in sessions
        if s.started and s.ended
    )
    total_tokens = sum(s.total_tokens for s in sessions)
    input_tokens = sum(s.input_tokens for s in sessions)
    cached_tokens = sum(s.cached_tokens for s in sessions)
    output_tokens = sum(s.output_tokens for s in sessions)
    cache_ratio = cached_tokens / input_tokens if input_tokens else 0
    recs = recommendations(sessions, tools, len(prompts))
    sample_prompts, seen = [], set()
    for prompt in reversed(prompts):
        if len(prompt) >= 12 and prompt.lower() not in seen:
            seen.add(prompt.lower())
            sample_prompts.append(prompt)
        if len(sample_prompts) == 8:
            break
    period = "記録全体" if cutoff is None else f"直近 {(datetime.now(timezone.utc) - cutoff).days} 日"
    date_range = "記録なし" if not starts or not ends else f"{min(starts).date()} – {max(ends).date()}"
    generated = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    top_category = categories.most_common(1)[0][0] if categories else "分類可能な依頼なし"
    top_project = projects.most_common(1)[0][0] if projects else "なし"
    return f"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Insights</title><style>
:root{{--bg:#f6f7fb;--card:#fff;--ink:#172033;--muted:#667085;--accent:#0f766e;--soft:#ccfbf1;--line:#e5e7eb}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 system-ui,-apple-system,sans-serif}}main{{max-width:1060px;margin:auto;padding:48px 22px 80px}}h1{{font-size:38px;margin:0}}h2{{font-size:24px;margin:48px 0 16px}}h3{{margin:0 0 6px;font-size:17px}}
.subtitle,.note{{color:var(--muted)}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}}.card{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 2px 7px #1720330a}}.metric b{{display:block;font-size:28px;color:var(--accent)}}.callout{{border-left:5px solid var(--accent);background:var(--soft)}}
.bar-row{{display:grid;grid-template-columns:minmax(110px,1.2fr) 3fr 60px;gap:12px;align-items:center;margin:9px 0}}.bar-row b{{text-align:right}}.track{{height:10px;background:#edf0f4;border-radius:9px;overflow:hidden}}.track i{{display:block;height:100%;background:var(--accent)}}ul{{padding-left:20px}}li{{margin:8px 0}}footer{{margin-top:52px;color:var(--muted);font-size:13px}}@media(max-width:600px){{h1{{font-size:30px}}.bar-row{{grid-template-columns:1fr 2fr 45px}}}}
</style></head><body><main>
<h1>Codex Insights</h1><p class="subtitle">{esc(period)} · {esc(date_range)} · 生成: {esc(generated)}</p>
<section class="grid"><div class="card metric"><span>セッション</span><b>{len(sessions):,}</b></div><div class="card metric"><span>ユーザーメッセージ</span><b>{len(prompts):,}</b></div><div class="card metric"><span>稼働時間（概算）</span><b>{duration_hours:,.1f}h</b></div><div class="card metric"><span>処理トークン（累積）</span><b>{format_count(total_tokens)}</b></div></section>
<h2>ひと目でわかること</h2><div class="card callout"><p>最も多い依頼領域は <strong>{esc(top_category)}</strong>、最も利用の多い作業場所は <strong>{esc(top_project)}</strong> です。</p><p>入力トークンのキャッシュ比率は <strong>{cache_ratio:.0%}</strong>。ツール失敗を <strong>{sum(s.tool_errors for s in sessions):,}</strong> 件、コンテキスト圧縮を <strong>{sum(s.compactions for s in sessions):,}</strong> 回検出しました。</p></div>
<h2>何に取り組んでいるか</h2><div class="grid"><div class="card"><h3>依頼の種類</h3>{bars(categories.most_common())}</div><div class="card"><h3>主な作業場所</h3>{bars(projects.most_common(10))}</div></div>
<h2>Codex の使い方</h2><div class="grid"><div class="card"><h3>よく使うツール</h3>{bars(tools.most_common(12))}</div><div class="card"><h3>モデル</h3>{bars(models.most_common())}<p class="note">入力 {format_count(input_tokens)} / キャッシュ {format_count(cached_tokens)} / 出力 {format_count(output_tokens)}</p></div></div>
<h2>改善できそうな点</h2><div class="grid">{''.join(f'<div class="card"><h3>{esc(title)}</h3><p>{esc(body)}</p></div>' for title, body in recs)}</div>
<h2>最近の依頼例</h2><div class="card"><ul>{''.join(f'<li>{esc(prompt)}</li>' for prompt in sample_prompts) or '<li>表示できる依頼がありません。</li>'}</ul></div>
<footer>ローカルの Codex JSONL 履歴だけを解析した推定レポートです。請求・契約上の正確な利用量ではありません。短い依頼抜粋を含むため、外部共有前に確認してください。</footer>
</main></body></html>"""


def main() -> int:
    args = parse_args()
    if not args.all and args.days <= 0:
        raise SystemExit("--days must be greater than zero")
    cutoff = None if args.all else datetime.now(timezone.utc) - timedelta(days=args.days)
    by_id: dict[str, Session] = {}
    unreadable = 0
    for path in session_files():
        session = read_session(path)
        if session is None:
            unreadable += 1
            continue
        if cutoff and session.ended and session.ended < cutoff:
            continue
        previous = by_id.get(session.session_id)
        if previous is None or path.stat().st_mtime > previous.path.stat().st_mtime:
            by_id[session.session_id] = session
    sessions = sorted(by_id.values(), key=lambda s: s.started or datetime.min.replace(tzinfo=timezone.utc))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output = args.output.expanduser() if args.output else OUTPUT_DIR / f"insights-{datetime.now().strftime('%Y-%m-%d-%H%M%S')}.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render(sessions, cutoff), encoding="utf-8")
    latest = OUTPUT_DIR / "report.html"
    if output.resolve() != latest.resolve():
        shutil.copyfile(output, latest)
    print(f"Report: {output}")
    print(f"Latest: {latest}")
    print(f"Sessions: {len(sessions)}")
    print(f"Unreadable files skipped: {unreadable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
