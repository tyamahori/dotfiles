#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Behavioral contract tests for the herdr-collab review lifecycle."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
REVIEW_FLOW = SKILL_DIR / "scripts" / "review-flow.py"
SEND = SKILL_DIR / "scripts" / "send.sh"
BASE_REVISION = "commit:" + "a" * 40
RESULT_REVISION = "commit:" + "b" * 40
STALE_REVISION = "commit:" + "c" * 40


def write_message(
    directory: Path,
    number: int,
    tag: str,
    sender: str,
    recipient: str,
    title: str,
    fields: list[tuple[str, str]],
) -> Path:
    path = directory / f"{number:02d}-{tag}.md"
    lines = [
        f"from: {sender}",
        f"to: {recipient}",
        "date: 2026-08-22 12:00:00",
        "",
        title,
        *(f"{key}: {value}" for key, value in fields),
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def review_request(directory: Path) -> Path:
    return write_message(
        directory,
        1,
        "review-req",
        "implementer",
        "reviewer",
        "[REVIEW-REQ] parser lifecycle",
        [
            ("revision", BASE_REVISION),
            ("scope", "agents/skills/herdr-collab"),
            ("focus", "lifecycle validation"),
            ("context", "Revision-pinned review flow"),
            ("implementer", "implementer"),
            ("implementer-model", "codex"),
            ("reviewer", "reviewer"),
            ("reviewer-model", "claude"),
            ("reviewer-context", "fresh"),
        ],
    )


def findings(directory: Path, entries: list[tuple[str, str, str, str]], revision: str = BASE_REVISION) -> Path:
    fields = [
        ("reviewed-revision", revision),
        ("scope", "agents/skills/herdr-collab"),
        ("verification", "Read the implementation and contract tests"),
        ("count", str(len(entries))),
    ]
    for identifier, (severity, location, summary, evidence) in enumerate(entries, start=1):
        fields.extend(
            [
                (f"finding-{identifier}", f"{severity} {location} {summary}"),
                (f"evidence-{identifier}", evidence),
                (f"confidence-{identifier}", "high"),
            ]
        )
    return write_message(directory, 2, "findings", "reviewer", "implementer", "[FINDINGS] parser lifecycle", fields)


def applied(directory: Path, resolved: str, dismissed: str) -> Path:
    fields = [
        ("base-revision", BASE_REVISION),
        ("result-revision", RESULT_REVISION),
        ("resolved", resolved),
        ("dismissed", dismissed),
        ("verification", "Ran focused lifecycle checks"),
    ]
    if resolved != "none":
        for identifier in resolved.replace(" ", "").split(","):
            fields.append((f"change-{identifier}", "Corrected the reported behavior"))
    if dismissed != "none":
        for identifier in dismissed.replace(" ", "").split(","):
            fields.append((f"reason-{identifier}", "Not reproducible from the pinned revision"))
    return write_message(directory, 3, "applied", "implementer", "reviewer", "[APPLIED] parser lifecycle", fields)


def verified(
    directory: Path,
    resolved: str,
    unresolved_high_mid: str,
    unresolved_low: str,
    status: str,
    number: int = 4,
    revision: str = RESULT_REVISION,
) -> Path:
    return write_message(
        directory,
        number,
        "verified",
        "reviewer",
        "implementer",
        "[VERIFIED] parser lifecycle",
        [
            ("result-revision", revision),
            ("resolved", resolved),
            ("unresolved-high-mid", unresolved_high_mid),
            ("unresolved-low", unresolved_low),
            ("verification", "Checked the resulting revision independently"),
            ("status", status),
        ],
    )


def decision(directory: Path, outcome: str) -> Path:
    return write_message(
        directory,
        5,
        "decision",
        "implementer",
        "reviewer",
        "[DECISION] parser lifecycle",
        [
            ("result-revision", RESULT_REVISION),
            ("finding-ids", "1"),
            ("decided-by", "user"),
            ("reason", "The user accepts the documented risk"),
            ("decision", outcome),
        ],
    )


class ReviewFlowTest(unittest.TestCase):
    def invoke(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(REVIEW_FLOW), *args],
            check=False,
            text=True,
            capture_output=True,
            env=env,
        )

    def invoke_send(self, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SEND), *args],
            check=False,
            text=True,
            capture_output=True,
            env=env,
        )

    def test_valid_pass_closes_at_verified_result_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [("mid", "scripts/review-flow.py:100", "Missing validation", "The field is absent")])
            applied(directory, "1", "none")
            final = verified(directory, "1", "none", "none", "pass")

            self.assertEqual(self.invoke("validate-message", str(final)).returncode, 0)
            status = self.invoke("status", "--dir", str(directory))
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(status.stdout, f"state=closed-pass revision={RESULT_REVISION}\n")
            self.assertEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_no_findings_skips_applied_and_closes_at_reviewed_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [])
            final = verified(directory, "none", "none", "none", "pass", number=3, revision=BASE_REVISION)

            self.assertEqual(self.invoke("validate-message", str(final)).returncode, 0)
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=closed-pass revision={BASE_REVISION}\n",
            )

    def test_low_only_unresolved_finding_closes_with_reporting(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [("low", "scripts/review-flow.py:100", "Optional wording", "The wording is unclear")])
            applied(directory, "none", "1")
            verified(directory, "none", "none", "1", "unresolved")

            status = self.invoke("status", "--dir", str(directory))
            self.assertEqual(status.stdout, f"state=closed-low revision={RESULT_REVISION}\n")
            self.assertEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_high_or_mid_unresolved_finding_requires_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [("high", "scripts/review-flow.py:100", "Unsafe branch", "The branch bypasses validation")])
            applied(directory, "none", "1")
            verified(directory, "none", "1", "none", "unresolved")

            status = self.invoke("status", "--dir", str(directory))
            self.assertEqual(status.stdout, f"state=awaiting-decision revision={RESULT_REVISION}\n")
            self.assertNotEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_user_accepted_risk_is_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [("mid", "scripts/review-flow.py:100", "Known tradeoff", "The tradeoff remains")])
            applied(directory, "none", "1")
            verified(directory, "none", "1", "none", "unresolved")
            decision(directory, "accept-risk")

            status = self.invoke("status", "--dir", str(directory))
            self.assertEqual(status.stdout, f"state=closed-risk revision={RESULT_REVISION}\n")
            self.assertEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_rework_is_terminal_but_not_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [("high", "scripts/review-flow.py:100", "Unsafe branch", "The branch bypasses validation")])
            applied(directory, "none", "1")
            verified(directory, "none", "1", "none", "unresolved")
            decision(directory, "rework")

            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=rework revision={RESULT_REVISION}\n",
            )
            self.assertNotEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_stale_findings_revision_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            candidate = findings(
                directory,
                [("mid", "scripts/review-flow.py:100", "Missing validation", "The field is absent")],
                revision=STALE_REVISION,
            )

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("reviewed-revision", result.stderr)

    def test_missing_evidence_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            candidate = write_message(
                directory,
                2,
                "findings",
                "reviewer",
                "implementer",
                "[FINDINGS] parser lifecycle",
                [
                    ("reviewed-revision", BASE_REVISION),
                    ("scope", "agents/skills/herdr-collab"),
                    ("verification", "Inspected it"),
                    ("count", "1"),
                    ("finding-1", "mid scripts/review-flow.py:100 Missing validation"),
                    ("confidence-1", "high"),
                ],
            )

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("evidence-1", result.stderr)

    def test_invalid_confidence_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            candidate = findings(
                directory,
                [("mid", "scripts/review-flow.py:100", "Missing validation", "The field is absent")],
            )
            content = candidate.read_text(encoding="utf-8").replace("confidence-1: high", "confidence-1: certain")
            candidate.write_text(content, encoding="utf-8")

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("confidence-1", result.stderr)

    def test_malformed_count_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            candidate = write_message(
                directory,
                2,
                "findings",
                "reviewer",
                "implementer",
                "[FINDINGS] parser lifecycle",
                [
                    ("reviewed-revision", BASE_REVISION),
                    ("scope", "agents/skills/herdr-collab"),
                    ("verification", "Inspected it"),
                    ("count", "one"),
                ],
            )

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("count", result.stderr)

    def test_non_partitioning_applied_response_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            review_request(directory)
            findings(directory, [("mid", "scripts/review-flow.py:100", "Missing validation", "The field is absent")])
            candidate = applied(directory, "1", "1")

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("multiple partitions", result.stderr)

    def test_send_rejects_invalid_review_messages_before_herdr_and_only_removes_new_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = root / "invalid-body.md"
            body.write_text("[REVIEW-REQ] incomplete\nrevision: not-a-revision\n", encoding="utf-8")
            environment = os.environ | {"HERDR_ENV": "1", "HERDR_PANE_ID": "test-pane"}

            new_message = self.invoke_send(
                "--root",
                str(root),
                "--flow",
                "invalid-new",
                "--to",
                "reviewer",
                "--from",
                "implementer",
                "--tag",
                "review-req",
                "--body",
                str(body),
                env=environment,
            )
            self.assertEqual(new_message.returncode, 2)
            self.assertIn("review flow validation failed", new_message.stderr)
            flow = root / ".agent-msgs" / "invalid-new"
            self.assertEqual(list(flow.glob("*.md")), [])

            existing = flow / "01-review-req.md"
            existing.write_text("from: implementer\nto: reviewer\ndate: invalid\n\n[REVIEW-REQ] incomplete\n", encoding="utf-8")
            existing_message = self.invoke_send(
                "--root",
                str(root),
                "--to",
                "reviewer",
                "--from",
                "implementer",
                "--file",
                str(existing),
                env=environment,
            )
            self.assertEqual(existing_message.returncode, 2)
            self.assertTrue(existing.exists())


if __name__ == "__main__":
    unittest.main()
