#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CORE_PATH = ROOT / "libexec/reminder-service-core"


def load_core():
    loader = importlib.machinery.SourceFileLoader("benson_reminder_service_core", str(CORE_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise RuntimeError("could not load existing Reminder core")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def parse_bool(value: str) -> bool:
    if value == "true":
        return True
    if value == "false":
        return False
    raise argparse.ArgumentTypeError("enabled must be true or false")


def matches_filters(
    record: dict[str, Any],
    args: argparse.Namespace,
    canonical_recipient: str | None,
) -> bool:
    if args.reminder_id and str(record.get("reminderId")) != args.reminder_id:
        return False
    job_ids = {
        str(item.get("jobId"))
        for item in record.get("cronJobs", [])
        if isinstance(item, dict) and item.get("jobId")
    }
    if args.job_id and args.job_id not in job_ids:
        return False
    if canonical_recipient and canonical_recipient.casefold() not in {
        str(value).casefold() for value in record.get("recipientIds", [])
    }:
        return False
    if args.text and args.text.casefold() not in str(record.get("content") or "").casefold():
        return False
    if args.enabled is True and record.get("status") != "active":
        return False
    if args.enabled is False and record.get("status") != "paused":
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("operation", choices=("list-reminders", "find-reminders"))
    parser.add_argument("--requester", required=True)
    parser.add_argument("--reminder-id")
    parser.add_argument("--job-id")
    parser.add_argument("--recipient")
    parser.add_argument("--text")
    parser.add_argument("--enabled", type=parse_bool)
    args, unknown = parser.parse_known_args()
    operation = "list" if args.operation == "list-reminders" else "find"

    if unknown:
        print(json.dumps({
            "status": "failure",
            "operation": operation,
            "error": {
                "code": "REMINDER_DISCOVERY_FILTER_INVALID",
                "message": "unsupported discovery arguments",
            },
        }, ensure_ascii=False, separators=(",", ":")))
        return 2

    for field in ("reminder_id", "job_id", "recipient", "text"):
        value = getattr(args, field)
        if value is None:
            continue
        normalized = value.strip()
        if not normalized:
            print(json.dumps({
                "status": "failure",
                "operation": operation,
                "verified": False,
                "error": {
                    "code": "REMINDER_DISCOVERY_FILTER_INVALID",
                    "message": f"{field.replace('_', '-')} must contain non-whitespace text",
                    "retryable": False,
                },
                "warnings": [],
            }, ensure_ascii=False, separators=(",", ":")))
            return 2
        setattr(args, field, normalized)

    try:
        core = load_core()
        config = core.load_config()
        requester = core.resolve_trusted_requester(args.requester, config)
        requester_id = str(requester["id"])
        canonical_recipient = None
        if args.recipient:
            resolved = core.resolve_identity(args.recipient, config)
            canonical_recipient = str(resolved["id"])
        records = core.load_records()
        matches = [
            record
            for record in records
            if core.requester_can_access_record(record, requester_id)
            and matches_filters(record, args, canonical_recipient)
        ]
        result = {
            "status": "success",
            "operation": operation,
            "verified": True,
            "matchCount": len(matches),
            "matches": matches,
            "warnings": [],
        }
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        code = getattr(exc, "code", "REMINDER_DISCOVERY_FAILED")
        print(json.dumps({
            "status": "failure",
            "operation": operation,
            "verified": False,
            "error": {"code": code, "message": str(exc), "retryable": False},
            "warnings": [],
        }, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
