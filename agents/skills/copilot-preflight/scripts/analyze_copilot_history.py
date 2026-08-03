#!/usr/bin/env python3
"""Summarize repository-wide GitHub Copilot PR review behavior via gh."""

from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any


def gh_text(args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["gh", *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("gh is not installed or not on PATH") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(exc.stderr.strip() or exc.stdout.strip() or str(exc)) from exc
    return result.stdout


def gh_json(args: list[str]) -> Any:
    return json.loads(gh_text(args))


def resolve_repo(repo: str | None) -> str:
    if repo:
        return repo
    value = gh_text(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).strip()
    if not value:
        raise RuntimeError("could not infer a repository; pass --repo OWNER/REPO")
    return value


def fetch_comment_pages(repo: str, workers: int) -> list[dict[str, Any]]:
    def fetch(page: int) -> list[dict[str, Any]]:
        return gh_json(["api", f"repos/{repo}/pulls/comments?per_page=100&page={page}"])

    comments: list[dict[str, Any]] = []
    page = 1
    while True:
        page_numbers = list(range(page, page + workers))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            batches = list(executor.map(fetch, page_numbers))
        for batch in batches:
            comments.extend(batch)
        if any(len(batch) < 100 for batch in batches):
            break
        page += workers
    return comments


def classify_area(path: str) -> str:
    lower = path.lower()
    if lower.endswith((".md", ".mdx", ".rst")) or lower.startswith("docs/"):
        return "documentation"
    if re.search(r"(?:^|/)(?:test|tests|e2e|spec|specs)(?:/|\.|$)", lower):
        return "tests"
    if lower.startswith(".github/"):
        return "github"
    if re.search(r"(?:^|/)(?:migrations?|prisma|database|db)(?:/|\.|$)", lower) or lower.endswith(".sql"):
        return "database"
    if lower.startswith(("scripts/", "docker/", "infra/")) or "compose" in lower:
        return "automation-infra"
    if lower.startswith("src/") or "/src/" in lower:
        return "source"
    return "other"


def count_reviews(repo: str, pr_numbers: list[int], workers: int, review_login: str) -> dict[int, int]:
    def fetch(number: int) -> tuple[int, int]:
        reviews = gh_json(["api", f"repos/{repo}/pulls/{number}/reviews?per_page=100"])
        count = sum(review.get("user", {}).get("login") == review_login for review in reviews)
        return number, count

    with ThreadPoolExecutor(max_workers=workers) as executor:
        return dict(executor.map(fetch, pr_numbers))


def build_summary(args: argparse.Namespace) -> dict[str, Any]:
    repo = resolve_repo(args.repo)
    all_comments = fetch_comment_pages(repo, args.workers)
    findings = [
        comment
        for comment in all_comments
        if comment.get("user", {}).get("login") == args.comment_login
        and not comment.get("in_reply_to_id")
    ]
    finding_ids = {comment["id"] for comment in findings}
    replies = [
        comment
        for comment in all_comments
        if comment.get("in_reply_to_id") in finding_ids
        and comment.get("user", {}).get("login") != args.comment_login
    ]

    pr_counts: collections.Counter[int] = collections.Counter()
    area_counts: collections.Counter[str] = collections.Counter()
    path_counts: collections.Counter[str] = collections.Counter()
    for comment in findings:
        number = int(comment["pull_request_url"].rsplit("/", 1)[1])
        path = comment.get("path") or "(unknown)"
        pr_counts[number] += 1
        area_counts[classify_area(path)] += 1
        path_counts[path] += 1

    dates = sorted(comment["created_at"] for comment in findings)
    summary: dict[str, Any] = {
        "repository": repo,
        "window": {"first": dates[0] if dates else None, "last": dates[-1] if dates else None},
        "top_level_findings": len(findings),
        "prs_with_findings": len(pr_counts),
        "human_reply_comments": len(replies),
        "areas": dict(area_counts.most_common()),
        "top_paths": dict(path_counts.most_common(args.top)),
        "top_prs": dict((str(number), count) for number, count in pr_counts.most_common(args.top)),
    }

    if args.with_reviews:
        prs = gh_json(["pr", "list", "-R", repo, "--state", "all", "--limit", "1000", "--json", "number"])
        counts = count_reviews(repo, [pr["number"] for pr in prs], args.workers, args.review_login)
        reviewed = [count for count in counts.values() if count]
        summary.update(
            pull_requests=len(prs),
            copilot_review_events=sum(reviewed),
            prs_reviewed_by_copilot=len(reviewed),
            mean_review_rounds=round(sum(reviewed) / len(reviewed), 2) if reviewed else 0,
        )
    return summary


def print_text(summary: dict[str, Any]) -> None:
    print(f"repository: {summary['repository']}")
    print(f"window: {summary['window']['first']} .. {summary['window']['last']}")
    print(f"top-level findings: {summary['top_level_findings']}")
    print(f"PRs with findings: {summary['prs_with_findings']}")
    print(f"human reply comments: {summary['human_reply_comments']}")
    for key, label in (
        ("pull_requests", "repository PRs"),
        ("copilot_review_events", "Copilot review events"),
        ("prs_reviewed_by_copilot", "PRs reviewed by Copilot"),
        ("mean_review_rounds", "mean review rounds"),
    ):
        if key in summary:
            print(f"{label}: {summary[key]}")
    print("areas:")
    for area, count in summary["areas"].items():
        print(f"  {area}: {count}")
    print("top paths:")
    for path, count in summary["top_paths"].items():
        print(f"  {count:4d}  {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="GitHub owner/repository; defaults to current checkout")
    parser.add_argument("--workers", type=int, default=8, help="parallel gh API calls (1-32)")
    parser.add_argument("--top", type=int, default=20, help="number of top paths and PRs")
    parser.add_argument("--comment-login", default="Copilot", help="inline comment author login")
    parser.add_argument("--review-login", default="copilot-pull-request-reviewer[bot]", help="review event author login")
    parser.add_argument("--with-reviews", action="store_true", help="also count review events per PR")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        parser.error("--workers must be between 1 and 32")
    if args.top < 1:
        parser.error("--top must be positive")
    try:
        summary = build_summary(args)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print_text(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
