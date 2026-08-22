#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Validate the revision-pinned herdr-collab review lifecycle."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import NoReturn


REVIEW_TAGS = {
    "review-req": "REVIEW-REQ",
    "findings": "FINDINGS",
    "cross-check": "CROSS-CHECK",
    "consolidated": "CONSOLIDATED",
    "applied": "APPLIED",
    "verified": "VERIFIED",
    "decision": "DECISION",
    "fyi": "FYI",
}
FLOW_REVIEW_TAGS = REVIEW_TAGS.keys() - {"fyi"}
TAG_TO_FILE = {value: key for key, value in REVIEW_TAGS.items()}
FILE_NAME_RE = re.compile(r"^(?P<number>[0-9]+)-(?P<tag>[a-z-]+)\.md$")
TITLE_RE = re.compile(
    r"^\[(?P<tag>REVIEW-REQ|FINDINGS|CROSS-CHECK|CONSOLIDATED|APPLIED|VERIFIED|DECISION|FYI)\]\s+\S.*$"
)
KEY_VALUE_RE = re.compile(r"^(?P<key>[a-z][a-z0-9-]*):\s*(?P<value>\S(?:.*\S)?)$")
REVISION_RE = re.compile(r"^(?:commit:[0-9A-Fa-f]{7,64}|snapshot:sha256:[0-9A-Fa-f]{64})$")
FINDING_RE = re.compile(r"^(?P<severity>high|mid|low)\s+(?P<path>\S+):(?P<line>[1-9][0-9]*)\s+\S.*$")
ID_LIST_RE = re.compile(r"^[1-9][0-9]*(?:\s*,\s*[1-9][0-9]*)*$")
NAMESPACED_ID_RE = re.compile(r"^[ab]-[1-9][0-9]*$")
NAMESPACED_ID_LIST_RE = re.compile(r"^[ab]-[1-9][0-9]*(?:\s*,\s*[ab]-[1-9][0-9]*)*$")
DUPLICATE_MAP_RE = re.compile(r"^(?P<duplicate>[ab]-[1-9][0-9]*)=(?P<canonical>[ab]-[1-9][0-9]*)$")
SEVERITY_RANK = {"low": 0, "mid": 1, "high": 2}
MODEL_FAMILY_ALIASES = {
    "claude": "claude",
    "codex": "codex",
    "openai": "codex",
    "gpt": "codex",
    "gemini": "gemini",
    "grok": "grok",
}
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class ValidationError(Exception):
    pass


@dataclass(frozen=True)
class Message:
    path: Path
    number: int
    tag: str
    sender: str
    recipient: str
    date: str
    values: dict[str, str]

    def value(self, key: str) -> str:
        try:
            return self.values[key]
        except KeyError as error:
            raise ValidationError(f"{self.path.name}: missing {key}") from error


def fail(message: str) -> NoReturn:
    raise ValidationError(message)


def parse_message(path: Path) -> Message:
    match = FILE_NAME_RE.fullmatch(path.name)
    if not match:
        fail(f"{path}: filename must be NN-<tag>.md")
    tag = match.group("tag")
    if tag not in REVIEW_TAGS:
        fail(f"{path}: not a review message")

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"{path}: cannot read message: {error}")

    if len(lines) < 5:
        fail(f"{path.name}: generated headers and body are required")
    header_values: list[str] = []
    for line, key in zip(lines[:3], ("from", "to", "date"), strict=True):
        prefix = f"{key}: "
        if not line.startswith(prefix) or not line[len(prefix) :].strip():
            fail(f"{path.name}: invalid {key} header")
        header_values.append(line[len(prefix) :].strip())
    if lines[3] != "":
        fail(f"{path.name}: a blank line must follow generated headers")
    try:
        datetime.strptime(header_values[2], DATE_FORMAT)
    except ValueError as error:
        fail(f"{path.name}: invalid date header ({error})")

    title = TITLE_RE.fullmatch(lines[4])
    if not title:
        fail(f"{path.name}: first body line must be a tagged review title")
    title_tag = title.group("tag")
    if TAG_TO_FILE[title_tag] != tag:
        fail(f"{path.name}: filename tag and body tag differ")

    values: dict[str, str] = {}
    for line in lines[5:]:
        if not line:
            continue
        value_match = KEY_VALUE_RE.fullmatch(line)
        if not value_match:
            fail(f"{path.name}: expected key/value line, got {line!r}")
        key = value_match.group("key")
        if key in values:
            fail(f"{path.name}: duplicate {key}")
        values[key] = value_match.group("value")

    return Message(
        path=path,
        number=int(match.group("number"), 10),
        tag=tag,
        sender=header_values[0],
        recipient=header_values[1],
        date=header_values[2],
        values=values,
    )


def require_fields(message: Message, required: set[str], allowed: set[str]) -> None:
    missing = required - message.values.keys()
    extra = message.values.keys() - allowed
    if missing:
        fail(f"{message.path.name}: missing {', '.join(sorted(missing))}")
    if extra:
        fail(f"{message.path.name}: unexpected {', '.join(sorted(extra))}")


def require_nonempty(message: Message, key: str) -> None:
    if not message.value(key).strip():
        fail(f"{message.path.name}: {key} must not be empty")


def require_revision(message: Message, key: str) -> str:
    revision = message.value(key)
    if not REVISION_RE.fullmatch(revision):
        fail(f"{message.path.name}: {key} must be commit:<7-64 hex> or snapshot:sha256:<64 hex>")
    return revision


def parse_id_list(message: Message, key: str) -> set[int]:
    raw = message.value(key)
    if raw == "none":
        return set()
    if not ID_LIST_RE.fullmatch(raw):
        fail(
            f"{message.path.name}: {key} must be `none` or numeric finding suffixes "
            "such as `1,2` (not `finding-1,finding-2`)"
        )
    identifiers = [int(value.strip(), 10) for value in raw.split(",")]
    if len(identifiers) != len(set(identifiers)):
        fail(f"{message.path.name}: {key} repeats a finding ID")
    return set(identifiers)


def require_exact_partition(message: Message, names: tuple[str, ...], expected: set[int]) -> dict[str, set[int]]:
    partitions = {name: parse_id_list(message, name) for name in names}
    seen: set[int] = set()
    for name, identifiers in partitions.items():
        duplicate = seen & identifiers
        if duplicate:
            fail(f"{message.path.name}: finding IDs {sorted(duplicate)} appear in multiple partitions")
        seen.update(identifiers)
    if seen != expected:
        fail(
            f"{message.path.name}: {', '.join(names)} must partition exactly "
            f"{sorted(expected)} (got {sorted(seen)})"
        )
    return partitions


def parse_namespaced_id_list(message: Message, key: str) -> set[str]:
    raw = message.value(key)
    if raw == "none":
        return set()
    if not NAMESPACED_ID_LIST_RE.fullmatch(raw):
        fail(f"{message.path.name}: {key} must be `none` or a comma-separated list of a-N/b-N finding IDs")
    identifiers = [value.strip() for value in raw.split(",")]
    if len(identifiers) != len(set(identifiers)):
        fail(f"{message.path.name}: {key} repeats a finding ID")
    return set(identifiers)


def require_exact_namespaced_partition(
    message: Message,
    names: tuple[str, ...],
    expected: set[str],
) -> dict[str, set[str]]:
    partitions = {name: parse_namespaced_id_list(message, name) for name in names}
    seen: set[str] = set()
    for identifiers in partitions.values():
        duplicate = seen & identifiers
        if duplicate:
            fail(f"{message.path.name}: finding IDs {sorted(duplicate)} appear in multiple partitions")
        seen.update(identifiers)
    if seen != expected:
        fail(
            f"{message.path.name}: {', '.join(names)} must partition exactly "
            f"{sorted(expected)} (got {sorted(seen)})"
        )
    return partitions


def recipient_set(message: Message) -> set[str]:
    recipients = message.recipient.split(",")
    if not recipients or any(not recipient for recipient in recipients):
        fail(f"{message.path.name}: to header must contain nonempty targets")
    if len(recipients) != len(set(recipients)):
        fail(f"{message.path.name}: to header repeats a target")
    return set(recipients)


def require_group_route(message: Message, sender: str, recipients: set[str], tag: str) -> None:
    if message.sender != sender or recipient_set(message) != recipients:
        fail(f"{message.path.name}: {tag} must route {sender} -> both reviewers")


def parse_duplicate_map(message: Message) -> dict[str, str]:
    raw = message.value("duplicate-map")
    if raw == "none":
        return {}
    mappings: dict[str, str] = {}
    for entry in raw.split(","):
        match = DUPLICATE_MAP_RE.fullmatch(entry.strip())
        if not match:
            fail(f"{message.path.name}: duplicate-map must be `none` or duplicate=canonical pairs")
        duplicate, canonical = match.group("duplicate"), match.group("canonical")
        if duplicate in mappings:
            fail(f"{message.path.name}: duplicate-map repeats {duplicate}")
        mappings[duplicate] = canonical
    return mappings


def model_family(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    if not normalized:
        return ""
    tokens = normalized.split()
    for token in tokens:
        if token in MODEL_FAMILY_ALIASES:
            return MODEL_FAMILY_ALIASES[token]
    return tokens[0]


def unambiguous_model_family(value: str) -> str:
    tokens = re.sub(r"[^a-z0-9]+", " ", value.casefold()).split()
    families = {
        MODEL_FAMILY_ALIASES[token]
        for token in tokens
        if token in MODEL_FAMILY_ALIASES
    }
    if len(families) != 1:
        return ""
    return families.pop()
    return tokens[0]


def validate_review_request(message: Message) -> None:
    required = {
        "revision",
        "scope",
        "focus",
        "context",
        "implementer",
        "implementer-model",
        "reviewer",
        "reviewer-model",
        "reviewer-context",
    }
    allowed = required | {"independence-exception"}
    require_fields(message, required, allowed)
    for key in required:
        require_nonempty(message, key)
    require_revision(message, "revision")

    if message.sender != message.value("implementer"):
        fail(f"{message.path.name}: from header must name the implementer")
    if message.recipient != message.value("reviewer"):
        fail(f"{message.path.name}: to header must name the reviewer")
    if message.value("implementer") == message.value("reviewer"):
        fail(f"{message.path.name}: implementer and reviewer must be different identities")


    fresh = message.value("reviewer-context") == "fresh"
    same_family = model_family(message.value("implementer-model")) == model_family(message.value("reviewer-model"))
    exception = message.values.get("independence-exception")
    if not fresh or same_family:
        if not exception or not exception.startswith("user-approved: ") or not exception.removeprefix("user-approved: ").strip():
            fail(
                f"{message.path.name}: non-fresh or same-family review requires "
                "independence-exception: user-approved: <reason>"
            )
    elif exception:
        fail(f"{message.path.name}: independence-exception is only allowed for a non-fresh or same-family review")


def validate_findings(message: Message) -> dict[int, str]:
    fixed = {"reviewed-revision", "scope", "verification", "count"}
    for key in fixed:
        require_nonempty(message, key)
    if not re.fullmatch(r"0|[1-9][0-9]*", message.value("count")):
        fail(f"{message.path.name}: count must be a non-negative integer")
    count = int(message.value("count"), 10)
    expected_keys = fixed | {
        f"{prefix}-{identifier}"
        for identifier in range(1, count + 1)
        for prefix in ("finding", "evidence", "confidence")
    }
    require_fields(message, fixed, expected_keys)
    require_revision(message, "reviewed-revision")

    severities: dict[int, str] = {}
    for identifier in range(1, count + 1):
        finding = message.value(f"finding-{identifier}")
        finding_match = FINDING_RE.fullmatch(finding)
        if not finding_match:
            fail(
                f"{message.path.name}: finding-{identifier} must be "
                "<high|mid|low> <path>:<line> <summary>"
            )
        if not message.value(f"evidence-{identifier}").strip():
            fail(f"{message.path.name}: evidence-{identifier} must not be empty")
        confidence = message.value(f"confidence-{identifier}")
        if confidence not in {"high", "mid", "low"}:
            fail(f"{message.path.name}: confidence-{identifier} must be high, mid, or low")
        severities[identifier] = finding_match.group("severity")
    return severities


def validate_applied(message: Message, expected_ids: set[int]) -> None:
    fixed = {"base-revision", "result-revision", "resolved", "dismissed", "verification"}
    dynamic = {
        f"change-{identifier}" for identifier in expected_ids
    } | {
        f"reason-{identifier}" for identifier in expected_ids
    }
    require_fields(message, fixed, fixed | dynamic)
    for key in ("base-revision", "result-revision", "verification"):
        require_nonempty(message, key)
    require_revision(message, "base-revision")
    require_revision(message, "result-revision")
    partitions = require_exact_partition(message, ("resolved", "dismissed"), expected_ids)
    expected_dynamic = {f"change-{identifier}" for identifier in partitions["resolved"]} | {
        f"reason-{identifier}" for identifier in partitions["dismissed"]
    }
    actual_dynamic = {key for key in message.values if key.startswith("change-") or key.startswith("reason-")}
    if actual_dynamic != expected_dynamic:
        fail(f"{message.path.name}: change-N and reason-N must match resolved and dismissed exactly")
    for key in expected_dynamic:
        require_nonempty(message, key)


def validate_verified(message: Message, expected_ids: set[int], severities: dict[int, str]) -> dict[str, set[int]]:
    fixed = {
        "result-revision",
        "resolved",
        "unresolved-high-mid",
        "unresolved-low",
        "verification",
        "status",
    }
    require_fields(message, fixed, fixed)
    for key in ("result-revision", "verification", "status"):
        require_nonempty(message, key)
    require_revision(message, "result-revision")
    partitions = require_exact_partition(
        message,
        ("resolved", "unresolved-high-mid", "unresolved-low"),
        expected_ids,
    )
    invalid_high_mid = {
        identifier
        for identifier in partitions["unresolved-high-mid"]
        if severities[identifier] not in {"high", "mid"}
    }
    invalid_low = {
        identifier
        for identifier in partitions["unresolved-low"]
        if severities[identifier] != "low"
    }
    if invalid_high_mid:
        fail(f"{message.path.name}: unresolved-high-mid contains non-high/mid finding IDs {sorted(invalid_high_mid)}")
    if invalid_low:
        fail(f"{message.path.name}: unresolved-low contains non-low finding IDs {sorted(invalid_low)}")
    unresolved = partitions["unresolved-high-mid"] | partitions["unresolved-low"]
    expected_status = "pass" if not unresolved else "unresolved"
    if message.value("status") != expected_status:
        fail(f"{message.path.name}: status must be {expected_status}")
    return partitions


def validate_decision(message: Message, expected_ids: set[int]) -> str:
    fixed = {"result-revision", "finding-ids", "decided-by", "reason", "decision"}
    require_fields(message, fixed, fixed)
    for key in fixed:
        require_nonempty(message, key)
    require_revision(message, "result-revision")
    if parse_id_list(message, "finding-ids") != expected_ids:
        fail(f"{message.path.name}: finding-ids must match unresolved high/mid IDs exactly")
    if message.value("decided-by") != "user":
        fail(f"{message.path.name}: decided-by must be user")
    if message.value("decision") not in {"accept-risk", "rework"}:
        fail(f"{message.path.name}: decision must be accept-risk or rework")
    return message.value("decision")


PANEL_REVIEWER_B_LENSES = {
    "security",
    "data-integrity",
    "concurrency-state",
    "usability-compatibility",
    "operations",
    "evidence-assumptions",
    "maintainability-failure-modes",
}


def validate_panel_review_request(message: Message) -> None:
    required = {
        "review-mode",
        "revision",
        "scope",
        "focus",
        "context",
        "implementer",
        "implementer-model",
        "reviewer-a",
        "reviewer-a-model",
        "reviewer-a-context",
        "reviewer-a-lens",
        "reviewer-b",
        "reviewer-b-model",
        "reviewer-b-context",
        "reviewer-b-lens",
        "reviewer-b-lens-reason",
    }
    require_fields(message, required, required)
    for key in required:
        require_nonempty(message, key)
    if message.value("review-mode") != "panel":
        fail(f"{message.path.name}: review-mode must be panel")
    require_revision(message, "revision")

    implementer = message.value("implementer")
    reviewer_a = message.value("reviewer-a")
    reviewer_b = message.value("reviewer-b")
    identities = (implementer, reviewer_a, reviewer_b)
    if any("," in identity for identity in identities) or len(set(identities)) != len(identities):
        fail(f"{message.path.name}: implementer and panel reviewers must be distinct single identities")
    require_group_route(message, implementer, {reviewer_a, reviewer_b}, "REVIEW-REQ")
    implementer_family = unambiguous_model_family(message.value("implementer-model"))
    if implementer_family not in {"claude", "codex"}:
        fail(
            f"{message.path.name}: implementer-model must unambiguously identify "
            "the claude or codex model family"
        )
    opposite_family = "claude" if implementer_family == "codex" else "codex"
    for reviewer in ("reviewer-a", "reviewer-b"):
        if message.value(f"{reviewer}-context") != "fresh":
            fail(f"{message.path.name}: {reviewer}-context must be fresh")
        if unambiguous_model_family(message.value(f"{reviewer}-model")) != opposite_family:
            fail(
                f"{message.path.name}: {reviewer}-model must unambiguously use "
                f"the opposite model family ({opposite_family}) from the implementer"
            )
    if message.value("reviewer-a-lens") != "correctness-contract":
        fail(f"{message.path.name}: reviewer-a-lens must be correctness-contract")
    if message.value("reviewer-b-lens") not in PANEL_REVIEWER_B_LENSES:
        fail(f"{message.path.name}: reviewer-b-lens is not a permitted panel lens")


def validate_panel_findings(
    message: Message,
    reviewer: str,
    lens: str,
    prefix: str,
) -> dict[str, tuple[str, str]]:
    fixed = {"reviewed-revision", "scope", "verification", "count", "reviewer", "lens"}
    for key in fixed:
        require_nonempty(message, key)
    if message.value("reviewer") != reviewer or message.value("lens") != lens:
        fail(f"{message.path.name}: reviewer and lens must match the REVIEW-REQ assignment")
    if not re.fullmatch(r"0|[1-9][0-9]*", message.value("count")):
        fail(f"{message.path.name}: count must be a non-negative integer")
    count = int(message.value("count"), 10)
    expected_keys = fixed | {
        f"{field}-{prefix}-{identifier}"
        for identifier in range(1, count + 1)
        for field in ("finding", "evidence", "confidence")
    }
    require_fields(message, fixed, expected_keys)
    require_revision(message, "reviewed-revision")

    findings: dict[str, tuple[str, str]] = {}
    for identifier in range(1, count + 1):
        source_id = f"{prefix}-{identifier}"
        finding = message.value(f"finding-{source_id}")
        finding_match = FINDING_RE.fullmatch(finding)
        if not finding_match:
            fail(
                f"{message.path.name}: finding-{source_id} must be "
                "<high|mid|low> <path>:<line> <summary>"
            )
        if not message.value(f"evidence-{source_id}").strip():
            fail(f"{message.path.name}: evidence-{source_id} must not be empty")
        if message.value(f"confidence-{source_id}") not in {"high", "mid", "low"}:
            fail(f"{message.path.name}: confidence-{source_id} must be high, mid, or low")
        findings[source_id] = (finding_match.group("severity"), finding)
    return findings


def validate_cross_check(
    message: Message,
    revision: str,
    source_reviewer: str,
    checker: str,
    expected_ids: set[str],
) -> dict[str, str]:
    fixed = {
        "reviewed-revision",
        "source-reviewer",
        "checker",
        "finding-ids",
        "confirmed",
        "rejected",
        "verification",
    }
    dynamic = {f"{field}-{source_id}" for source_id in expected_ids for field in ("evidence", "confidence")}
    require_fields(message, fixed, fixed | dynamic)
    for key in fixed:
        require_nonempty(message, key)
    if require_revision(message, "reviewed-revision") != revision:
        fail(f"{message.path.name}: reviewed-revision must equal REVIEW-REQ revision")
    if message.value("source-reviewer") != source_reviewer or message.value("checker") != checker:
        fail(f"{message.path.name}: source-reviewer and checker must identify the peer review")
    if parse_namespaced_id_list(message, "finding-ids") != expected_ids:
        fail(f"{message.path.name}: finding-ids must equal the peer's high/mid source IDs")
    partitions = require_exact_namespaced_partition(message, ("confirmed", "rejected"), expected_ids)
    for source_id in expected_ids:
        if not message.value(f"evidence-{source_id}").strip():
            fail(f"{message.path.name}: evidence-{source_id} must not be empty")
        if message.value(f"confidence-{source_id}") not in {"high", "mid", "low"}:
            fail(f"{message.path.name}: confidence-{source_id} must be high, mid, or low")
    return {
        source_id: "confirmed"
        for source_id in partitions["confirmed"]
    } | {
        source_id: "rejected"
        for source_id in partitions["rejected"]
    }


def validate_consolidated(
    message: Message,
    revision: str,
    findings: dict[str, tuple[str, str]],
    cross_checks: dict[str, str],
) -> tuple[set[str], dict[str, str]]:
    fixed = {"reviewed-revision", "source-ids", "canonical-ids", "duplicate-map", "verification"}
    source_ids = set(findings)
    canonical_ids = parse_namespaced_id_list(message, "canonical-ids")
    dynamic = {
        f"{field}-{canonical_id}"
        for canonical_id in canonical_ids
        for field in ("finding", "sources", "cross-check")
    }
    require_fields(message, fixed, fixed | dynamic)
    for key in fixed:
        require_nonempty(message, key)
    if require_revision(message, "reviewed-revision") != revision:
        fail(f"{message.path.name}: reviewed-revision must equal REVIEW-REQ revision")
    if parse_namespaced_id_list(message, "source-ids") != source_ids:
        fail(f"{message.path.name}: source-ids must list every source finding exactly once")
    duplicate_map = parse_duplicate_map(message)
    duplicate_ids = set(duplicate_map)
    expected_canonical = source_ids - duplicate_ids
    if not duplicate_ids <= source_ids or not set(duplicate_map.values()) <= expected_canonical:
        fail(f"{message.path.name}: duplicate-map must map source IDs to canonical source IDs")
    if canonical_ids != expected_canonical:
        fail(f"{message.path.name}: canonical-ids must be every source ID not listed as a duplicate")

    for canonical_id in canonical_ids:
        if message.value(f"finding-{canonical_id}") != findings[canonical_id][1]:
            fail(f"{message.path.name}: finding-{canonical_id} must preserve its canonical source finding")
        mapped_sources = {canonical_id} | {
            duplicate_id
            for duplicate_id, mapped_canonical in duplicate_map.items()
            if mapped_canonical == canonical_id
        }
        if parse_namespaced_id_list(message, f"sources-{canonical_id}") != mapped_sources:
            fail(f"{message.path.name}: sources-{canonical_id} must match duplicate-map")
        highest_severity = max(
            (findings[source_id][0] for source_id in mapped_sources),
            key=SEVERITY_RANK.__getitem__,
        )
        if findings[canonical_id][0] != highest_severity:
            fail(
                f"{message.path.name}: finding-{canonical_id} must preserve the "
                f"highest duplicate severity ({highest_severity})"
            )
        high_mid = {
            source_id
            for source_id in mapped_sources
            if findings[source_id][0] in {"high", "mid"}
        }
        expected_cross_check = "not-required"
        if high_mid:
            outcomes = {cross_checks[source_id] for source_id in high_mid}
            expected_cross_check = outcomes.pop() if len(outcomes) == 1 else "mixed"
        if message.value(f"cross-check-{canonical_id}") != expected_cross_check:
            fail(
                f"{message.path.name}: cross-check-{canonical_id} must be "
                f"{expected_cross_check}"
            )
    return canonical_ids, duplicate_map


def validate_panel_applied(message: Message, expected_ids: set[str]) -> None:
    fixed = {"base-revision", "result-revision", "resolved", "dismissed", "verification"}
    dynamic = {
        f"{field}-{source_id}"
        for source_id in expected_ids
        for field in ("change", "reason")
    }
    require_fields(message, fixed, fixed | dynamic)
    for key in ("base-revision", "result-revision", "verification"):
        require_nonempty(message, key)
    require_revision(message, "base-revision")
    require_revision(message, "result-revision")
    partitions = require_exact_namespaced_partition(message, ("resolved", "dismissed"), expected_ids)
    expected_dynamic = {
        f"change-{source_id}" for source_id in partitions["resolved"]
    } | {
        f"reason-{source_id}" for source_id in partitions["dismissed"]
    }
    actual_dynamic = {key for key in message.values if key.startswith(("change-", "reason-"))}
    if actual_dynamic != expected_dynamic:
        fail(f"{message.path.name}: change-N and reason-N must match resolved and dismissed exactly")
    for key in expected_dynamic:
        require_nonempty(message, key)


def validate_panel_verified(
    message: Message,
    reviewer: str,
    expected_ids: set[str],
    findings: dict[str, tuple[str, str]],
) -> dict[str, set[str]]:
    fixed = {
        "result-revision",
        "reviewer",
        "finding-ids",
        "resolved",
        "unresolved-high-mid",
        "unresolved-low",
        "verification",
        "status",
    }
    require_fields(message, fixed, fixed)
    for key in ("result-revision", "reviewer", "verification", "status"):
        require_nonempty(message, key)
    if message.value("reviewer") != reviewer:
        fail(f"{message.path.name}: reviewer must identify the sender")
    require_revision(message, "result-revision")
    if parse_namespaced_id_list(message, "finding-ids") != expected_ids:
        fail(f"{message.path.name}: finding-ids must contain exactly the reviewer's canonical IDs")
    partitions = require_exact_namespaced_partition(
        message,
        ("resolved", "unresolved-high-mid", "unresolved-low"),
        expected_ids,
    )
    invalid_high_mid = {
        source_id
        for source_id in partitions["unresolved-high-mid"]
        if findings[source_id][0] not in {"high", "mid"}
    }
    invalid_low = {
        source_id
        for source_id in partitions["unresolved-low"]
        if findings[source_id][0] != "low"
    }
    if invalid_high_mid:
        fail(f"{message.path.name}: unresolved-high-mid contains non-high/mid finding IDs {sorted(invalid_high_mid)}")
    if invalid_low:
        fail(f"{message.path.name}: unresolved-low contains non-low finding IDs {sorted(invalid_low)}")
    unresolved = partitions["unresolved-high-mid"] | partitions["unresolved-low"]
    if message.value("status") != ("pass" if not unresolved else "unresolved"):
        fail(f"{message.path.name}: status must match unresolved partitions")
    return partitions


def validate_panel_decision(message: Message, expected_ids: set[str]) -> str:
    fixed = {"result-revision", "finding-ids", "decided-by", "reason", "decision"}
    require_fields(message, fixed, fixed)
    for key in fixed:
        require_nonempty(message, key)
    require_revision(message, "result-revision")
    if parse_namespaced_id_list(message, "finding-ids") != expected_ids:
        fail(f"{message.path.name}: finding-ids must match unresolved high/mid IDs exactly")
    if message.value("decided-by") != "user":
        fail(f"{message.path.name}: decided-by must be user")
    if message.value("decision") not in {"accept-risk", "rework"}:
        fail(f"{message.path.name}: decision must be accept-risk or rework")
    return message.value("decision")


def validate_panel_relay(
    message: Message,
    revision: str,
    implementer: str,
    reviewers: set[str],
    expected_paths: dict[str, Path],
) -> None:
    fixed = {"reviewed-revision", "reviewer-a-findings", "reviewer-b-findings"}
    require_fields(message, fixed, fixed)
    require_group_route(message, implementer, reviewers, "FYI")
    if require_revision(message, "reviewed-revision") != revision:
        fail(f"{message.path.name}: reviewed-revision must equal REVIEW-REQ revision")
    for key, expected_path in expected_paths.items():
        require_nonempty(message, key)
        actual_path = Path(message.value(key))
        if not actual_path.is_absolute():
            fail(f"{message.path.name}: {key} must be an absolute path")
        if actual_path.resolve() != expected_path.resolve():
            fail(f"{message.path.name}: {key} must identify the corresponding FINDINGS file")


def review_messages(directory: Path) -> list[Message]:
    if not directory.is_dir():
        fail(f"{directory}: not a directory")
    messages: list[Message] = []
    used_numbers: set[int] = set()
    for path in directory.iterdir():
        if not path.is_file():
            continue
        match = FILE_NAME_RE.fullmatch(path.name)
        if not match or match.group("tag") not in FLOW_REVIEW_TAGS:
            continue
        message = parse_message(path)
        if message.number in used_numbers:
            fail(f"{directory}: duplicate message number {message.number}")
        used_numbers.add(message.number)
        messages.append(message)

    messages.sort(key=lambda message: message.number)
    if not messages or messages[0].tag != "review-req" or messages[0].values.get("review-mode") != "panel":
        return messages

    request_number = messages[0].number
    for path in directory.iterdir():
        if not path.is_file():
            continue
        match = FILE_NAME_RE.fullmatch(path.name)
        if not match or match.group("tag") != "fyi" or int(match.group("number"), 10) <= request_number:
            continue
        message = parse_message(path)
        if message.number in used_numbers:
            fail(f"{directory}: duplicate message number {message.number}")
        used_numbers.add(message.number)
        messages.append(message)
    return sorted(messages, key=lambda message: message.number)


def validate_panel_flow(directory: Path, messages: list[Message], request: Message) -> tuple[str, str]:
    validate_panel_review_request(request)
    revision = require_revision(request, "revision")
    implementer = request.value("implementer")
    reviewers = {
        request.value("reviewer-a"): ("a", request.value("reviewer-a-lens")),
        request.value("reviewer-b"): ("b", request.value("reviewer-b-lens")),
    }
    reviewer_names = set(reviewers)
    if len(messages) == 1:
        return "panel-open-review", revision

    index = 1
    findings_by_reviewer: dict[str, dict[str, tuple[str, str]]] = {}
    findings_paths_by_reviewer: dict[str, Path] = {}
    while index < len(messages) and messages[index].tag == "findings":
        findings_message = messages[index]
        reviewer = findings_message.value("reviewer")
        if reviewer not in reviewers or reviewer in findings_by_reviewer:
            fail(f"{findings_message.path.name}: panel FINDINGS must be one message from each assigned reviewer")
        prefix, lens = reviewers[reviewer]
        if findings_message.sender != reviewer or findings_message.recipient != implementer:
            fail(f"{findings_message.path.name}: FINDINGS must route reviewer -> implementer")
        findings = validate_panel_findings(findings_message, reviewer, lens, prefix)
        if require_revision(findings_message, "reviewed-revision") != revision:
            fail(f"{findings_message.path.name}: reviewed-revision must equal REVIEW-REQ revision")
        if findings_message.value("scope") != request.value("scope"):
            fail(f"{findings_message.path.name}: scope must equal REVIEW-REQ scope")
        findings_by_reviewer[reviewer] = findings
        findings_paths_by_reviewer[reviewer] = findings_message.path
        index += 1
    if len(findings_by_reviewer) != 2:
        if index == len(messages):
            return "panel-open-findings", revision
        fail(f"{directory}: panel REVIEW-REQ requires independent FINDINGS from both reviewers before FYI")

    if index == len(messages):
        return "panel-open-relay", revision
    relay = messages[index]
    if relay.tag != "fyi":
        fail(f"{directory}: both panel FINDINGS must be followed by the coordinator FYI")
    validate_panel_relay(
        relay,
        revision,
        implementer,
        reviewer_names,
        {
            "reviewer-a-findings": findings_paths_by_reviewer[request.value("reviewer-a")],
            "reviewer-b-findings": findings_paths_by_reviewer[request.value("reviewer-b")],
        },
    )
    index += 1

    all_findings = {
        source_id: finding
        for reviewer_findings in findings_by_reviewer.values()
        for source_id, finding in reviewer_findings.items()
    }
    cross_checks_by_checker: dict[str, dict[str, str]] = {}
    while index < len(messages) and messages[index].tag == "cross-check":
        cross_check = messages[index]
        checker = cross_check.value("checker")
        if checker not in reviewers or checker in cross_checks_by_checker:
            fail(f"{cross_check.path.name}: panel CROSS-CHECK must be one message from each assigned reviewer")
        source_reviewer = cross_check.value("source-reviewer")
        if source_reviewer not in reviewers or source_reviewer == checker:
            fail(f"{cross_check.path.name}: CROSS-CHECK must check the other reviewer")
        if cross_check.sender != checker or cross_check.recipient != implementer:
            fail(f"{cross_check.path.name}: CROSS-CHECK must route reviewer -> implementer")
        expected_ids = {
            source_id
            for source_id, (severity, _) in findings_by_reviewer[source_reviewer].items()
            if severity in {"high", "mid"}
        }
        cross_checks_by_checker[checker] = validate_cross_check(
            cross_check,
            revision,
            source_reviewer,
            checker,
            expected_ids,
        )
        index += 1
    if len(cross_checks_by_checker) != 2:
        if index == len(messages):
            return "panel-open-cross-check", revision
        fail(f"{directory}: panel CROSS-CHECK requires one check by each reviewer before CONSOLIDATED")

    cross_check_outcomes = {
        source_id: outcome
        for checked_findings in cross_checks_by_checker.values()
        for source_id, outcome in checked_findings.items()
    }
    if index == len(messages):
        return "panel-open-consolidated", revision
    consolidated = messages[index]
    if consolidated.tag != "consolidated":
        fail(f"{directory}: panel CROSS-CHECK messages must be followed by CONSOLIDATED")
    require_group_route(consolidated, implementer, reviewer_names, "CONSOLIDATED")
    canonical_ids, _ = validate_consolidated(consolidated, revision, all_findings, cross_check_outcomes)
    index += 1

    if canonical_ids:
        if index == len(messages):
            return "panel-open-applied", revision
        applied = messages[index]
        if applied.tag != "applied":
            fail(f"{directory}: panel CONSOLIDATED with canonical findings must be followed by APPLIED")
        require_group_route(applied, implementer, reviewer_names, "APPLIED")
        validate_panel_applied(applied, canonical_ids)
        if require_revision(applied, "base-revision") != revision:
            fail(f"{applied.path.name}: base-revision must equal CONSOLIDATED reviewed-revision")
        result_revision = require_revision(applied, "result-revision")
        index += 1
    else:
        result_revision = revision

    verified_by_reviewer: dict[str, dict[str, set[str]]] = {}
    while index < len(messages) and messages[index].tag == "verified":
        verified = messages[index]
        reviewer = verified.value("reviewer")
        if reviewer not in reviewers or reviewer in verified_by_reviewer:
            fail(f"{verified.path.name}: panel VERIFIED must be one message from each assigned reviewer")
        if verified.sender != reviewer or verified.recipient != implementer:
            fail(f"{verified.path.name}: VERIFIED must route reviewer -> implementer")
        prefix, _ = reviewers[reviewer]
        expected_ids = {source_id for source_id in canonical_ids if source_id.startswith(f"{prefix}-")}
        partitions = validate_panel_verified(verified, reviewer, expected_ids, all_findings)
        if require_revision(verified, "result-revision") != result_revision:
            fail(f"{verified.path.name}: result-revision must equal the revision under verification")
        verified_by_reviewer[reviewer] = partitions
        index += 1
    if len(verified_by_reviewer) != 2:
        if index == len(messages):
            return "panel-open-verified", result_revision
        fail(f"{directory}: panel VERIFIED requires one message from each reviewer")

    unresolved_high_mid = set().union(
        *(partitions["unresolved-high-mid"] for partitions in verified_by_reviewer.values())
    )
    unresolved_low = set().union(
        *(partitions["unresolved-low"] for partitions in verified_by_reviewer.values())
    )
    if not unresolved_high_mid:
        if index != len(messages):
            fail(f"{messages[index].path.name}: DECISION is only legal for unresolved high/mid findings")
        return ("closed-low" if unresolved_low else "closed-pass"), result_revision
    if index == len(messages):
        return "awaiting-decision", result_revision
    decision = messages[index]
    if decision.tag != "decision" or index + 1 != len(messages):
        fail(f"{directory}: unresolved high/mid panel findings require one final DECISION")
    require_group_route(decision, implementer, reviewer_names, "DECISION")
    outcome = validate_panel_decision(decision, unresolved_high_mid)
    if require_revision(decision, "result-revision") != result_revision:
        fail(f"{decision.path.name}: result-revision must equal VERIFIED result-revision")
    return ("closed-risk" if outcome == "accept-risk" else "rework"), result_revision


def validate_flow(directory: Path) -> tuple[str, str]:
    messages = review_messages(directory)
    if not messages:
        fail(f"{directory}: no review messages")
    actual_tags = [message.tag for message in messages]
    if actual_tags[0] != "review-req":
        fail(f"{directory}: review flow must begin with review-req")

    request = messages[0]
    if request.values.get("review-mode") == "panel":
        return validate_panel_flow(directory, messages, request)
    validate_review_request(request)
    revision = require_revision(request, "revision")
    implementer = request.value("implementer")
    reviewer = request.value("reviewer")
    if len(messages) == 1:
        return "open-review", revision
    if messages[1].tag != "findings":
        fail(f"{directory}: REVIEW-REQ must be followed by FINDINGS")

    findings = messages[1]
    if findings.sender != reviewer or findings.recipient != implementer:
        fail(f"{findings.path.name}: FINDINGS must route reviewer -> implementer")
    severities = validate_findings(findings)
    if require_revision(findings, "reviewed-revision") != revision:
        fail(f"{findings.path.name}: reviewed-revision must equal REVIEW-REQ revision")
    if findings.value("scope") != request.value("scope"):
        fail(f"{findings.path.name}: scope must equal REVIEW-REQ scope")
    if len(messages) == 2:
        return "open-findings", revision

    finding_ids = set(severities)
    if finding_ids:
        expected_tags = ["review-req", "findings", "applied", "verified", "decision"]
        if len(messages) > len(expected_tags) or actual_tags != expected_tags[: len(actual_tags)]:
            fail(f"{directory}: illegal review message ordering: {' -> '.join(actual_tags)}")
        applied = messages[2]
        if applied.sender != implementer or applied.recipient != reviewer:
            fail(f"{applied.path.name}: APPLIED must route implementer -> reviewer")
        validate_applied(applied, finding_ids)
        if require_revision(applied, "base-revision") != require_revision(findings, "reviewed-revision"):
            fail(f"{applied.path.name}: base-revision must equal FINDINGS reviewed-revision")
        result_revision = require_revision(applied, "result-revision")
        if len(messages) == 3:
            return "open-applied", result_revision
        verified = messages[3]
    else:
        expected_tags = ["review-req", "findings", "verified"]
        if len(messages) > len(expected_tags) or actual_tags != expected_tags[: len(actual_tags)]:
            fail(f"{directory}: zero findings must proceed directly to VERIFIED")
        result_revision = revision
        verified = messages[2]

    if verified.sender != reviewer or verified.recipient != implementer:
        fail(f"{verified.path.name}: VERIFIED must route reviewer -> implementer")
    verified_partitions = validate_verified(verified, finding_ids, severities)
    if require_revision(verified, "result-revision") != result_revision:
        fail(f"{verified.path.name}: result-revision must equal the revision under verification")
    unresolved_high_mid = verified_partitions["unresolved-high-mid"]
    if not unresolved_high_mid:
        expected_length = 4 if finding_ids else 3
        if len(messages) != expected_length:
            fail(f"{messages[-1].path.name}: DECISION is only legal for unresolved high/mid findings")
        if verified_partitions["unresolved-low"]:
            return "closed-low", result_revision
        return "closed-pass", result_revision

    if len(messages) == 4:
        return "awaiting-decision", result_revision

    decision = messages[4]
    if decision.sender != implementer or decision.recipient != reviewer:
        fail(f"{decision.path.name}: DECISION must route implementer -> reviewer")
    outcome = validate_decision(decision, unresolved_high_mid)
    if require_revision(decision, "result-revision") != result_revision:
        fail(f"{decision.path.name}: result-revision must equal VERIFIED result-revision")
    return ("closed-risk" if outcome == "accept-risk" else "rework"), result_revision


def command_validate_message(path_value: str) -> int:
    path = Path(path_value)
    match = FILE_NAME_RE.fullmatch(path.name)
    if match and match.group("tag") == "fyi":
        messages = review_messages(path.parent)
        if (
            not messages
            or messages[0].tag != "review-req"
            or messages[0].values.get("review-mode") != "panel"
            or int(match.group("number"), 10) <= messages[0].number
        ):
            return 0
    message = parse_message(path)
    validate_flow(message.path.parent)
    return 0


def command_status(directory_value: str, require_closed: bool) -> int:
    state, revision = validate_flow(Path(directory_value))
    if require_closed and state not in {"closed-pass", "closed-low", "closed-risk"}:
        raise ValidationError(f"state={state} is not closed")
    print(f"state={state} revision={revision}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    validate = subcommands.add_parser("validate-message", help="validate a review message and its containing flow")
    validate.add_argument("file", metavar="FILE")
    for command in ("status", "require-closed"):
        state = subcommands.add_parser(command, help="report a review flow state")
        state.add_argument("--dir", required=True, metavar="DIR")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        if args.command == "validate-message":
            return command_validate_message(args.file)
        return command_status(args.dir, args.command == "require-closed")
    except ValidationError as error:
        print(f"review-flow.py: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
