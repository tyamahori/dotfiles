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


def panel_request(
    directory: Path,
    *,
    implementer_model: str = "codex",
    reviewer_a_model: str = "claude",
    reviewer_b_model: str = "claude",
    reviewer_a_context: str = "fresh",
    reviewer_b_context: str = "fresh",
    reviewer_a_lens: str = "correctness-contract",
    reviewer_b_lens: str = "security",
    reviewer_b_lens_reason: str = "The change handles untrusted input",
) -> Path:
    return write_message(
        directory,
        1,
        "review-req",
        "implementer",
        "reviewer-a,reviewer-b",
        "[REVIEW-REQ] panel lifecycle",
        [
            ("review-mode", "panel"),
            ("revision", BASE_REVISION),
            ("scope", "agents/skills/herdr-collab"),
            ("focus", "panel lifecycle validation"),
            ("context", "Revision-pinned independent panel review"),
            ("implementer", "implementer"),
            ("implementer-model", implementer_model),
            ("reviewer-a", "reviewer-a"),
            ("reviewer-a-model", reviewer_a_model),
            ("reviewer-a-context", reviewer_a_context),
            ("reviewer-a-lens", reviewer_a_lens),
            ("reviewer-b", "reviewer-b"),
            ("reviewer-b-model", reviewer_b_model),
            ("reviewer-b-context", reviewer_b_context),
            ("reviewer-b-lens", reviewer_b_lens),
            ("reviewer-b-lens-reason", reviewer_b_lens_reason),
        ],
    )


def panel_findings(
    directory: Path,
    number: int,
    reviewer: str,
    entries: list[tuple[str, str, str, str]],
) -> Path:
    prefix = "a" if reviewer == "reviewer-a" else "b"
    lens = "correctness-contract" if prefix == "a" else "security"
    fields = [
        ("reviewed-revision", BASE_REVISION),
        ("scope", "agents/skills/herdr-collab"),
        ("verification", "Read the pinned implementation and contract tests"),
        ("count", str(len(entries))),
        ("reviewer", reviewer),
        ("lens", lens),
    ]
    for identifier, (severity, location, summary, evidence) in enumerate(entries, start=1):
        source_id = f"{prefix}-{identifier}"
        fields.extend(
            [
                (f"finding-{source_id}", f"{severity} {location} {summary}"),
                (f"evidence-{source_id}", evidence),
                (f"confidence-{source_id}", "high"),
            ]
        )
    return write_message(directory, number, "findings", reviewer, "implementer", "[FINDINGS] panel lifecycle", fields)


def panel_relay(directory: Path, number: int = 4) -> Path:
    return write_message(
        directory,
        number,
        "fyi",
        "implementer",
        "reviewer-a,reviewer-b",
        "[FYI] panel findings relay",
        [
            ("reviewed-revision", BASE_REVISION),
            ("reviewer-a-findings", str((directory / "02-findings.md").resolve())),
            ("reviewer-b-findings", str((directory / "03-findings.md").resolve())),
        ],
    )


def panel_cross_check(
    directory: Path,
    number: int,
    checker: str,
    source_reviewer: str,
    source_entries: list[tuple[str, str, str, str]],
    *,
    confirmed: str | None = None,
    rejected: str = "none",
) -> Path:
    prefix = "a" if source_reviewer == "reviewer-a" else "b"
    high_mid_ids = [
        f"{prefix}-{identifier}"
        for identifier, (severity, _, _, _) in enumerate(source_entries, start=1)
        if severity in {"high", "mid"}
    ]
    finding_ids = ", ".join(high_mid_ids) if high_mid_ids else "none"
    confirmed = finding_ids if confirmed is None else confirmed
    fields = [
        ("reviewed-revision", BASE_REVISION),
        ("source-reviewer", source_reviewer),
        ("checker", checker),
        ("finding-ids", finding_ids),
        ("confirmed", confirmed),
        ("rejected", rejected),
        ("verification", "Read the peer finding against the fixed revision"),
    ]
    for source_id in high_mid_ids:
        fields.extend(
            [
                (f"evidence-{source_id}", "The cited behavior is present"),
                (f"confidence-{source_id}", "high"),
            ]
        )
    return write_message(directory, number, "cross-check", checker, "implementer", "[CROSS-CHECK] panel lifecycle", fields)


def panel_source_findings(
    reviewer_a_entries: list[tuple[str, str, str, str]],
    reviewer_b_entries: list[tuple[str, str, str, str]],
) -> dict[str, tuple[str, str]]:
    return {
        **{
            f"a-{identifier}": (severity, f"{severity} {location} {summary}")
            for identifier, (severity, location, summary, _) in enumerate(reviewer_a_entries, start=1)
        },
        **{
            f"b-{identifier}": (severity, f"{severity} {location} {summary}")
            for identifier, (severity, location, summary, _) in enumerate(reviewer_b_entries, start=1)
        },
    }


def panel_consolidated(
    directory: Path,
    number: int,
    source_findings: dict[str, tuple[str, str]],
    *,
    canonical_ids: list[str] | None = None,
    duplicate_map: str = "none",
    cross_checks: dict[str, str] | None = None,
) -> Path:
    source_ids = list(source_findings)
    canonical_ids = source_ids if canonical_ids is None else canonical_ids
    cross_checks = {} if cross_checks is None else cross_checks
    fields = [
        ("reviewed-revision", BASE_REVISION),
        ("source-ids", ", ".join(source_ids) if source_ids else "none"),
        ("canonical-ids", ", ".join(canonical_ids) if canonical_ids else "none"),
        ("duplicate-map", duplicate_map),
        ("verification", "Mapped all source findings without discarding evidence"),
    ]
    duplicates = {} if duplicate_map == "none" else dict(part.split("=") for part in duplicate_map.split(","))
    for canonical_id in canonical_ids:
        sources = [canonical_id, *(source_id for source_id, mapped in duplicates.items() if mapped == canonical_id)]
        high_mid = [source_id for source_id in sources if source_findings[source_id][0] in {"high", "mid"}]
        outcomes = {cross_checks.get(source_id, "confirmed") for source_id in high_mid}
        cross_check = "not-required" if not high_mid else outcomes.pop() if len(outcomes) == 1 else "mixed"
        fields.extend(
            [
                (f"finding-{canonical_id}", source_findings[canonical_id][1]),
                (f"sources-{canonical_id}", ", ".join(sources)),
                (f"cross-check-{canonical_id}", cross_check),
            ]
        )
    return write_message(
        directory,
        number,
        "consolidated",
        "implementer",
        "reviewer-a,reviewer-b",
        "[CONSOLIDATED] panel lifecycle",
        fields,
    )


def panel_applied(directory: Path, number: int, resolved: str, dismissed: str) -> Path:
    fields = [
        ("base-revision", BASE_REVISION),
        ("result-revision", RESULT_REVISION),
        ("resolved", resolved),
        ("dismissed", dismissed),
        ("verification", "Ran focused lifecycle checks"),
    ]
    for source_id in ([] if resolved == "none" else resolved.replace(" ", "").split(",")):
        fields.append((f"change-{source_id}", "Corrected the canonical finding"))
    for source_id in ([] if dismissed == "none" else dismissed.replace(" ", "").split(",")):
        fields.append((f"reason-{source_id}", "The fixed revision cannot reproduce the finding"))
    return write_message(
        directory,
        number,
        "applied",
        "implementer",
        "reviewer-a,reviewer-b",
        "[APPLIED] panel lifecycle",
        fields,
    )


def panel_verified(
    directory: Path,
    number: int,
    reviewer: str,
    finding_ids: str,
    resolved: str,
    unresolved_high_mid: str,
    unresolved_low: str,
    status: str,
    revision: str = RESULT_REVISION,
) -> Path:
    return write_message(
        directory,
        number,
        "verified",
        reviewer,
        "implementer",
        "[VERIFIED] panel lifecycle",
        [
            ("result-revision", revision),
            ("reviewer", reviewer),
            ("finding-ids", finding_ids),
            ("resolved", resolved),
            ("unresolved-high-mid", unresolved_high_mid),
            ("unresolved-low", unresolved_low),
            ("verification", "Independently read the result revision"),
            ("status", status),
        ],
    )


def panel_decision(directory: Path, number: int, finding_ids: str, outcome: str) -> Path:
    return write_message(
        directory,
        number,
        "decision",
        "implementer",
        "reviewer-a,reviewer-b",
        "[DECISION] panel lifecycle",
        [
            ("result-revision", RESULT_REVISION),
            ("finding-ids", finding_ids),
            ("decided-by", "user"),
            ("reason", "The user made the documented aggregate decision"),
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


    def build_panel_to_consolidated(
        self,
        directory: Path,
        reviewer_a_entries: list[tuple[str, str, str, str]],
        reviewer_b_entries: list[tuple[str, str, str, str]],
    ) -> dict[str, tuple[str, str]]:
        panel_request(directory)
        panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
        panel_findings(directory, 3, "reviewer-b", reviewer_b_entries)
        panel_relay(directory)
        panel_cross_check(directory, 5, "reviewer-b", "reviewer-a", reviewer_a_entries)
        panel_cross_check(directory, 6, "reviewer-a", "reviewer-b", reviewer_b_entries)
        source_findings = panel_source_findings(reviewer_a_entries, reviewer_b_entries)
        panel_consolidated(directory, 7, source_findings)
        return source_findings

    def test_panel_pass_closes_after_both_reviewers_verify_namespaced_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("mid", "scripts/review-flow.py:100", "Missing panel guard", "The guard is absent")]
            reviewer_b_entries = [("low", "scripts/send.sh:90", "Unclear output", "The output is ambiguous")]
            self.build_panel_to_consolidated(directory, reviewer_a_entries, reviewer_b_entries)
            panel_applied(directory, 8, "a-1, b-1", "none")
            panel_verified(directory, 9, "reviewer-b", "b-1", "b-1", "none", "none", "pass")
            final = panel_verified(directory, 10, "reviewer-a", "a-1", "a-1", "none", "none", "pass")

            self.assertEqual(self.invoke("validate-message", str(final)).returncode, 0)
            status = self.invoke("status", "--dir", str(directory))
            self.assertEqual(status.stdout, f"state=closed-pass revision={RESULT_REVISION}\n")
            self.assertEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_panel_zero_findings_requires_two_zero_id_cross_checks_and_verifications(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", [])
            panel_findings(directory, 3, "reviewer-b", [])
            panel_relay(directory)
            panel_cross_check(directory, 5, "reviewer-a", "reviewer-b", [])
            panel_cross_check(directory, 6, "reviewer-b", "reviewer-a", [])
            panel_consolidated(directory, 7, {})
            panel_verified(directory, 8, "reviewer-a", "none", "none", "none", "none", "pass", BASE_REVISION)
            final = panel_verified(directory, 9, "reviewer-b", "none", "none", "none", "none", "pass", BASE_REVISION)

            self.assertEqual(self.invoke("validate-message", str(final)).returncode, 0)
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=closed-pass revision={BASE_REVISION}\n",
            )

    def test_panel_low_only_unresolved_finding_closes_low(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("low", "scripts/review-flow.py:101", "Wording is unclear", "The report lacks context")]
            self.build_panel_to_consolidated(directory, reviewer_a_entries, [])
            panel_applied(directory, 8, "none", "a-1")
            panel_verified(directory, 9, "reviewer-a", "a-1", "none", "none", "a-1", "unresolved")
            panel_verified(directory, 10, "reviewer-b", "none", "none", "none", "none", "pass")

            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=closed-low revision={RESULT_REVISION}\n",
            )

    def test_panel_unresolved_high_requires_group_decision_and_rework_stays_open(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("high", "scripts/review-flow.py:102", "Unsafe panel path", "The path omits validation")]
            self.build_panel_to_consolidated(directory, reviewer_a_entries, [])
            panel_applied(directory, 8, "none", "a-1")
            panel_verified(directory, 9, "reviewer-a", "a-1", "none", "a-1", "none", "unresolved")
            panel_verified(directory, 10, "reviewer-b", "none", "none", "none", "none", "pass")
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=awaiting-decision revision={RESULT_REVISION}\n",
            )
            panel_decision(directory, 11, "a-1", "rework")

            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=rework revision={RESULT_REVISION}\n",
            )
            self.assertNotEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_panel_user_accepted_high_risk_closes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_b_entries = [("mid", "scripts/send.sh:101", "Unsafe route", "The route omits validation")]
            self.build_panel_to_consolidated(directory, [], reviewer_b_entries)
            panel_applied(directory, 8, "none", "b-1")
            panel_verified(directory, 9, "reviewer-a", "none", "none", "none", "none", "pass")
            panel_verified(directory, 10, "reviewer-b", "b-1", "none", "b-1", "none", "unresolved")
            panel_decision(directory, 11, "b-1", "accept-risk")

            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=closed-risk revision={RESULT_REVISION}\n",
            )
            self.assertEqual(self.invoke("require-closed", "--dir", str(directory)).returncode, 0)

    def test_panel_requires_opposite_models_fresh_contexts_and_fixed_lenses(self) -> None:
        invalid_requests = [
            ({"reviewer_a_model": "codex"}, "opposite model family"),
            ({"reviewer_b_model": "gemini"}, "opposite model family"),
            ({"implementer_model": "codex claude"}, "unambiguously identify"),
            ({"reviewer_a_model": "claude codex"}, "unambiguously use"),
            ({"reviewer_b_context": "resumed"}, "reviewer-b-context"),
            ({"reviewer_a_lens": "security"}, "reviewer-a-lens"),
            ({"reviewer_b_lens": "correctness-contract"}, "reviewer-b-lens"),
            ({"reviewer_b_lens_reason": ""}, "reviewer-b-lens-reason"),
        ]
        for overrides, expected_error in invalid_requests:
            with self.subTest(overrides=overrides), tempfile.TemporaryDirectory() as temporary:
                candidate = panel_request(Path(temporary), **overrides)
                result = self.invoke("validate-message", str(candidate))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_error, result.stderr)

    def test_panel_missing_second_findings_is_open_and_cross_check_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("mid", "scripts/review-flow.py:103", "Missing branch", "The branch is absent")]
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=panel-open-findings revision={BASE_REVISION}\n",
            )
            candidate = panel_cross_check(directory, 3, "reviewer-b", "reviewer-a", reviewer_a_entries)

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("independent FINDINGS", result.stderr)

    def test_panel_requires_group_relay_before_cross_check(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [
                ("mid", "scripts/review-flow.py:104", "Missing branch", "The branch is absent")
            ]
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            panel_findings(directory, 3, "reviewer-b", [])

            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=panel-open-relay revision={BASE_REVISION}\n",
            )
            premature = panel_cross_check(directory, 4, "reviewer-b", "reviewer-a", reviewer_a_entries)
            result = self.invoke("validate-message", str(premature))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("coordinator FYI", result.stderr)
            premature.unlink()

            relay = panel_relay(directory)
            self.assertEqual(self.invoke("validate-message", str(relay)).returncode, 0)
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=panel-open-cross-check revision={BASE_REVISION}\n",
            )
            panel_cross_check(directory, 5, "reviewer-b", "reviewer-a", reviewer_a_entries)
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=panel-open-cross-check revision={BASE_REVISION}\n",
            )


    def test_panel_allows_group_fyi_relay_after_both_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [
                ("mid", "scripts/review-flow.py:104", "Missing branch", "The branch is absent")
            ]
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            panel_findings(directory, 3, "reviewer-b", [])
            relay = panel_relay(directory)
            relay.write_text(
                relay.read_text(encoding="utf-8").replace(
                    "to: reviewer-a,reviewer-b", "to: reviewer-a"
                ),
                encoding="utf-8",
            )
            result = self.invoke("validate-message", str(relay))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FYI must route", result.stderr)
            relay.unlink()

            relay = panel_relay(directory)
            relay.write_text(
                relay.read_text(encoding="utf-8").replace(
                    str((directory / "03-findings.md").resolve()), "/wrong/03-findings.md"
                ),
                encoding="utf-8",
            )
            result = self.invoke("validate-message", str(relay))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("corresponding FINDINGS", result.stderr)
            relay.unlink()

            final_relay = panel_relay(directory)
            self.assertEqual(self.invoke("validate-message", str(final_relay)).returncode, 0)
            panel_cross_check(directory, 5, "reviewer-b", "reviewer-a", reviewer_a_entries)
            panel_cross_check(directory, 6, "reviewer-a", "reviewer-b", [])
            source_findings = panel_source_findings(reviewer_a_entries, [])
            final = panel_consolidated(directory, 7, source_findings)

            result = self.invoke("validate-message", str(final))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=panel-open-applied revision={BASE_REVISION}\n",
            )

    def test_panel_rejects_relay_before_both_findings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", [])
            candidate = panel_relay(directory, 3)

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("independent FINDINGS", result.stderr)

    def test_panel_cross_check_rejects_own_reviewer_and_wrong_peer_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("mid", "scripts/review-flow.py:104", "Missing branch", "The branch is absent")]
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            panel_findings(directory, 3, "reviewer-b", [])
            panel_relay(directory)
            candidate = panel_cross_check(directory, 5, "reviewer-a", "reviewer-a", reviewer_a_entries)
            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("other reviewer", result.stderr)

            candidate.write_text(
                candidate.read_text(encoding="utf-8")
                .replace("source-reviewer: reviewer-a", "source-reviewer: reviewer-b")
                .replace("finding-ids: a-1", "finding-ids: b-1")
                .replace("confirmed: a-1", "confirmed: b-1")
                .replace("evidence-a-1", "evidence-b-1")
                .replace("confidence-a-1", "confidence-b-1"),
                encoding="utf-8",
            )
            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unexpected", result.stderr)

    def test_panel_consolidation_rejects_lossy_and_invalid_mappings(self) -> None:
        reviewer_a_entries = [("mid", "scripts/review-flow.py:105", "Missing branch", "The branch is absent")]
        reviewer_b_entries = [("mid", "scripts/send.sh:105", "Missing route", "The route is absent")]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            panel_findings(directory, 3, "reviewer-b", reviewer_b_entries)
            panel_relay(directory)
            panel_cross_check(directory, 5, "reviewer-b", "reviewer-a", reviewer_a_entries)
            panel_cross_check(directory, 6, "reviewer-a", "reviewer-b", reviewer_b_entries)
            source_findings = panel_source_findings(reviewer_a_entries, reviewer_b_entries)
            candidate = panel_consolidated(directory, 7, source_findings, canonical_ids=["a-1"])

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("canonical-ids", result.stderr)

            candidate.write_text(
                candidate.read_text(encoding="utf-8").replace("duplicate-map: none", "duplicate-map: b-1=b-1"),
                encoding="utf-8",
            )
            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("duplicate-map", result.stderr)

    def test_panel_duplicate_mapping_cannot_downgrade_severity(self) -> None:
        reviewer_a_entries = [
            ("low", "scripts/review-flow.py:105", "Shared issue", "Reviewer A rates the issue low")
        ]
        reviewer_b_entries = [
            ("high", "scripts/review-flow.py:105", "Shared issue", "Reviewer B demonstrates high impact")
        ]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            panel_findings(directory, 3, "reviewer-b", reviewer_b_entries)
            panel_relay(directory)
            panel_cross_check(directory, 5, "reviewer-b", "reviewer-a", reviewer_a_entries)
            panel_cross_check(directory, 6, "reviewer-a", "reviewer-b", reviewer_b_entries)
            source_findings = panel_source_findings(reviewer_a_entries, reviewer_b_entries)
            candidate = panel_consolidated(
                directory,
                7,
                source_findings,
                canonical_ids=["a-1"],
                duplicate_map="b-1=a-1",
            )

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("highest duplicate severity (high)", result.stderr)

    def test_panel_missing_reviewer_verified_remains_open_and_rejects_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("mid", "scripts/review-flow.py:106", "Missing branch", "The branch is absent")]
            self.build_panel_to_consolidated(directory, reviewer_a_entries, [])
            panel_applied(directory, 8, "a-1", "none")
            panel_verified(directory, 9, "reviewer-a", "a-1", "a-1", "none", "none", "pass")
            self.assertEqual(
                self.invoke("status", "--dir", str(directory)).stdout,
                f"state=panel-open-verified revision={RESULT_REVISION}\n",
            )
            candidate = panel_decision(directory, 10, "a-1", "accept-risk")

            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("panel VERIFIED", result.stderr)

    def test_panel_rejects_revision_and_group_routing_mismatches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            reviewer_a_entries = [("mid", "scripts/review-flow.py:107", "Missing branch", "The branch is absent")]
            panel_request(directory)
            panel_findings(directory, 2, "reviewer-a", reviewer_a_entries)
            panel_findings(directory, 3, "reviewer-b", [])
            panel_relay(directory)
            candidate = panel_cross_check(directory, 5, "reviewer-b", "reviewer-a", reviewer_a_entries)
            candidate.write_text(
                candidate.read_text(encoding="utf-8").replace(BASE_REVISION, STALE_REVISION, 1),
                encoding="utf-8",
            )
            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("reviewed-revision", result.stderr)

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.build_panel_to_consolidated(
                directory,
                [("low", "scripts/review-flow.py:108", "Wording is unclear", "The report lacks context")],
                [],
            )
            candidate = directory / "07-consolidated.md"
            candidate.write_text(
                candidate.read_text(encoding="utf-8").replace("to: reviewer-a,reviewer-b", "to: reviewer-a"),
                encoding="utf-8",
            )
            result = self.invoke("validate-message", str(candidate))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("CONSOLIDATED", result.stderr)

    def fake_herdr_environment(self, root: Path, failed_target: str = "") -> dict[str, str]:
        binary_directory = root / "bin"
        binary_directory.mkdir()
        herdr = binary_directory / "herdr"
        herdr.write_text(
            "#!/bin/bash\n"
            "printf '%s\\n' \"$*\" >> \"$HERDR_LOG\"\n"
            "if [ \"$1\" = agent ] && [ \"$2\" = wait ]; then\n"
            "  [ \"${HERDR_FAIL_TARGET:-}\" = \"$3\" ] && exit 1\n"
            "  printf '{}\\n'\n"
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        jq = binary_directory / "jq"
        jq.write_text("#!/bin/bash\ncat >/dev/null\nprintf 'working\\n'\n", encoding="utf-8")
        herdr.chmod(0o755)
        jq.chmod(0o755)
        return os.environ | {
            "HERDR_ENV": "1",
            "HERDR_PANE_ID": "test-pane",
            "HERDR_LOG": str(root / "herdr.log"),
            "HERDR_FAIL_TARGET": failed_target,
            "PATH": f"{binary_directory}:{os.environ['PATH']}",
        }

    def test_send_fans_out_one_ledger_file_to_both_reviewers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = root / "body.md"
            body.write_text("[FYI] panel delivery\nRead the ledger file.\n", encoding="utf-8")
            result = self.invoke_send(
                "--root",
                str(root),
                "--flow",
                "panel-fanout",
                "--to",
                "reviewer-a,reviewer-b",
                "--from",
                "implementer",
                "--tag",
                "fyi",
                "--body",
                str(body),
                env=self.fake_herdr_environment(root),
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            ledger_files = list((root / ".agent-msgs" / "panel-fanout").glob("*.md"))
            self.assertEqual(len(ledger_files), 1)
            self.assertIn("to: reviewer-a,reviewer-b", ledger_files[0].read_text(encoding="utf-8"))
            prompts = (root / "herdr.log").read_text(encoding="utf-8")
            self.assertIn("agent prompt reviewer-a", prompts)
            self.assertIn("agent prompt reviewer-b", prompts)

    def test_send_validates_panel_relay_fyi_but_preserves_generic_fyi(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            flow_directory = root / ".agent-msgs" / "panel-relay"
            flow_directory.mkdir(parents=True)
            panel_request(flow_directory)
            panel_findings(flow_directory, 2, "reviewer-a", [])
            panel_findings(flow_directory, 3, "reviewer-b", [])
            body = root / "body.md"
            body.write_text("[FYI] panel findings relay\nreviewed-revision: invalid\n", encoding="utf-8")
            environment = self.fake_herdr_environment(root)

            invalid = self.invoke_send(
                "--root",
                str(root),
                "--flow",
                "panel-relay",
                "--to",
                "reviewer-a,reviewer-b",
                "--from",
                "implementer",
                "--tag",
                "fyi",
                "--body",
                str(body),
                env=environment,
            )

            self.assertEqual(invalid.returncode, 2)
            self.assertIn("review flow validation failed", invalid.stderr)
            self.assertFalse((flow_directory / "04-fyi.md").exists())
            self.assertFalse((root / "herdr.log").exists())

            body.write_text(
                "[FYI] panel findings relay\n"
                f"reviewed-revision: {BASE_REVISION}\n"
                f"reviewer-a-findings: {(flow_directory / '02-findings.md').resolve()}\n"
                f"reviewer-b-findings: {(flow_directory / '03-findings.md').resolve()}\n",
                encoding="utf-8",
            )
            valid = self.invoke_send(
                "--root",
                str(root),
                "--flow",
                "panel-relay",
                "--to",
                "reviewer-a,reviewer-b",
                "--from",
                "implementer",
                "--tag",
                "fyi",
                "--body",
                str(body),
                env=environment,
            )

            self.assertEqual(valid.returncode, 0, valid.stderr)
            self.assertTrue((flow_directory / "04-fyi.md").exists())

    def test_send_fanout_reports_failure_when_any_reviewer_cannot_settle(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = root / "body.md"
            body.write_text("[FYI] panel delivery\nRead the ledger file.\n", encoding="utf-8")
            environment = self.fake_herdr_environment(root, "reviewer-b")
            result = self.invoke_send(
                "--root",
                str(root),
                "--flow",
                "panel-failure",
                "--to",
                "reviewer-a,reviewer-b",
                "--from",
                "implementer",
                "--tag",
                "fyi",
                "--body",
                str(body),
                env=environment,
            )

            self.assertEqual(result.returncode, 3)
            self.assertIn("reviewer-b", result.stderr)
            ledger_files = list((root / ".agent-msgs" / "panel-failure").glob("*.md"))
            self.assertEqual(len(ledger_files), 1)
            prompts = (root / "herdr.log").read_text(encoding="utf-8")
            self.assertIn("agent prompt reviewer-a", prompts)
            self.assertNotIn("agent prompt reviewer-b", prompts)

            retry = self.invoke_send(
                "--root",
                str(root),
                "--to",
                "reviewer-a,reviewer-b",
                "--from",
                "implementer",
                "--file",
                str(ledger_files[0]),
                "--retry-target",
                "reviewer-b",
                env=environment | {"HERDR_FAIL_TARGET": ""},
            )

            self.assertEqual(retry.returncode, 0, retry.stderr)
            retried_prompts = (root / "herdr.log").read_text(encoding="utf-8")
            self.assertEqual(retried_prompts.count("agent prompt reviewer-a"), 1)
            self.assertEqual(retried_prompts.count("agent prompt reviewer-b"), 1)

    def test_send_allocates_concurrent_panel_findings_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            flow_directory = root / ".agent-msgs" / "panel-race"
            flow_directory.mkdir(parents=True)
            panel_request(flow_directory)
            bodies: list[tuple[str, Path]] = []
            for reviewer, lens in (
                ("reviewer-a", "correctness-contract"),
                ("reviewer-b", "security"),
            ):
                body = root / f"{reviewer}.md"
                body.write_text(
                    "[FINDINGS] panel lifecycle\n"
                    f"reviewed-revision: {BASE_REVISION}\n"
                    "scope: agents/skills/herdr-collab\n"
                    "verification: Read the pinned implementation and contract tests\n"
                    "count: 0\n"
                    f"reviewer: {reviewer}\n"
                    f"lens: {lens}\n",
                    encoding="utf-8",
                )
                bodies.append((reviewer, body))
            environment = self.fake_herdr_environment(root)
            processes = [
                subprocess.Popen(
                    [
                        str(SEND),
                        "--root",
                        str(root),
                        "--flow",
                        "panel-race",
                        "--to",
                        "implementer",
                        "--from",
                        reviewer,
                        "--tag",
                        "findings",
                        "--body",
                        str(body),
                    ],
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=environment,
                )
                for reviewer, body in bodies
            ]
            results = [process.communicate(timeout=30) for process in processes]

            self.assertEqual([process.returncode for process in processes], [0, 0], results)
            finding_files = sorted(flow_directory.glob("*-findings.md"))
            self.assertEqual([path.name for path in finding_files], ["02-findings.md", "03-findings.md"])
            self.assertEqual(
                {
                    path.read_text(encoding="utf-8").splitlines()[0]
                    for path in finding_files
                },
                {"from: reviewer-a", "from: reviewer-b"},
            )

    def test_send_file_retry_cannot_change_recorded_route(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            existing = root / "01-fyi.md"
            existing.write_text(
                "from: reviewer-a\n"
                "to: implementer\n"
                "date: 2026-08-22 12:00:00\n\n"
                "[FYI] retry route\n"
                "Read the ledger file.\n",
                encoding="utf-8",
            )
            environment = self.fake_herdr_environment(root)

            result = self.invoke_send(
                "--root",
                str(root),
                "--to",
                "reviewer-b",
                "--file",
                str(existing),
                env=environment,
            )

            self.assertEqual(result.returncode, 2)
            self.assertIn("--to must exactly match", result.stderr)
            self.assertTrue(existing.exists())
            self.assertFalse((root / "herdr.log").exists())

            invalid_retry = self.invoke_send(
                "--root",
                str(root),
                "--to",
                "implementer",
                "--file",
                str(existing),
                "--retry-target",
                "reviewer-b",
                env=environment,
            )
            self.assertEqual(invalid_retry.returncode, 2)
            self.assertIn("--retry-target must belong", invalid_retry.stderr)


if __name__ == "__main__":
    unittest.main()
