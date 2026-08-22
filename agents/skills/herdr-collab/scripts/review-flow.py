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
    "applied": "APPLIED",
    "verified": "VERIFIED",
    "decision": "DECISION",
}
TAG_TO_FILE = {value: key for key, value in REVIEW_TAGS.items()}
FILE_NAME_RE = re.compile(r"^(?P<number>[0-9]+)-(?P<tag>[a-z-]+)\.md$")
TITLE_RE = re.compile(r"^\[(?P<tag>REVIEW-REQ|FINDINGS|APPLIED|VERIFIED|DECISION)\]\s+\S.*$")
KEY_VALUE_RE = re.compile(r"^(?P<key>[a-z][a-z0-9-]*):\s*(?P<value>\S(?:.*\S)?)$")
REVISION_RE = re.compile(r"^(?:commit:[0-9A-Fa-f]{7,64}|snapshot:sha256:[0-9A-Fa-f]{64})$")
FINDING_RE = re.compile(r"^(?P<severity>high|mid|low)\s+(?P<path>\S+):(?P<line>[1-9][0-9]*)\s+\S.*$")
ID_LIST_RE = re.compile(r"^[1-9][0-9]*(?:\s*,\s*[1-9][0-9]*)*$")
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
        fail(f"{message.path.name}: {key} must be `none` or a comma-separated list of finding IDs")
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


def model_family(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    if not normalized:
        return ""
    tokens = normalized.split()
    known = {
        "claude": "claude",
        "codex": "codex",
        "openai": "codex",
        "gpt": "codex",
        "gemini": "gemini",
        "grok": "grok",
    }
    for token in tokens:
        if token in known:
            return known[token]
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


def review_messages(directory: Path) -> list[Message]:
    if not directory.is_dir():
        fail(f"{directory}: not a directory")
    messages: list[Message] = []
    used_numbers: set[int] = set()
    for path in directory.iterdir():
        if not path.is_file():
            continue
        match = FILE_NAME_RE.fullmatch(path.name)
        if not match or match.group("tag") not in REVIEW_TAGS:
            continue
        message = parse_message(path)
        if message.number in used_numbers:
            fail(f"{directory}: duplicate message number {message.number}")
        used_numbers.add(message.number)
        messages.append(message)
    return sorted(messages, key=lambda message: message.number)


def validate_flow(directory: Path) -> tuple[str, str]:
    messages = review_messages(directory)
    if not messages:
        fail(f"{directory}: no review messages")
    actual_tags = [message.tag for message in messages]
    if actual_tags[0] != "review-req":
        fail(f"{directory}: review flow must begin with review-req")

    request = messages[0]
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
