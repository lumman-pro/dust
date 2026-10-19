#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["google-cloud-storage>=3,<4"]
# ///
"""Inventory live GCS object metadata for DFS search capacity planning.

See gcs-corpus-stats.md for layout selection and interpretation of stored bytes.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


LOGGER = logging.getLogger("gcs_corpus_stats")
DEFAULT_PAGE_SIZE = 1000
REQUEST_TIMEOUT_SECONDS = 60
PROGRESS_EVERY_PAGES = 25
LIST_FIELDS = "items(name,size,contentType,contentEncoding),nextPageToken"
UNKNOWN_MIME_TYPE = "unknown"
UNKNOWN_SCOPE_ID = ""
MIME_TOKEN = r"[a-z0-9!#$%&'*+.^_`|~-]+"
MIME_PATTERN = re.compile(rf"{MIME_TOKEN}/{MIME_TOKEN}", re.ASCII)
TEXT_MIME_TYPES = frozenset({
    "application/ecmascript",
    "application/javascript",
    "application/json",
    "application/ndjson",
    "application/sql",
    "application/toml",
    "application/vnd.dust.frame",
    "application/vnd.dust.frame.slideshow",
    "application/x-javascript",
    "application/x-ndjson",
    "application/x-yaml",
    "application/xml",
    "application/yaml",
})
UNKNOWN_MIME_TYPES = frozenset({
    UNKNOWN_MIME_TYPE,
    "application/octet-stream",
    "binary/octet-stream",
})
CANONICAL_PATH = re.compile(r"files/w/([^/]+)/[^/]+/(original|processed|public)")
MOUNT_PATH = re.compile(r"w/([^/]+)/(conversations|pods|users)/[^/]+/files/(.+)")
CORE_DOCUMENT_PATH = re.compile(r"([^/]+)/[^/]+/[^/]+/[0-9]+_[^/]+\.json")
CORE_LEGACY_TEXT_PATH = re.compile(r"([^/]+)/[^/]+/[^/]+/[^/]+/content\.txt")
CORE_DOCUMENT_ID_PATH = re.compile(r"([^/]+)/[^/]+/[^/]+/document_id\.txt")
STAT_COLUMNS = ["object_count", "stored_bytes", "largest_object_bytes"]


def normalize_content_type(raw: str | None) -> str:
    value = (raw or "").partition(";")[0].strip().lower()
    return value if MIME_PATTERN.fullmatch(value) else UNKNOWN_MIME_TYPE


def content_category(content_type: str) -> str:
    if content_type in UNKNOWN_MIME_TYPES:
        return "unknown"
    if (
        content_type.startswith("text/")
        or content_type in TEXT_MIME_TYPES
        or content_type.endswith(("+json", "+xml", "+yaml"))
    ):
        return "text"
    return "binary"


def is_processed_filename(name: str) -> bool:
    filename = name.rsplit("/", 1)[-1]
    if filename.endswith(".processed"):
        return len(filename) > len(".processed")
    basename, marker, extension = filename.rpartition(".processed.")
    return bool(marker and basename and extension and "." not in extension)


def storage_role(name: str, layout: str) -> tuple[str, str, str]:
    """Return role, scope kind, and scope ID without inferring a source MIME type."""
    if layout == "private-uploads":
        canonical = CANONICAL_PATH.fullmatch(name)
        if canonical:
            return f"canonical_{canonical[2]}", "workspace", canonical[1]
        mounted = MOUNT_PATH.fullmatch(name)
        if mounted:
            role = (
                "mounted_processed_candidate"
                if is_processed_filename(mounted[3])
                else "mounted_file"
            )
            return role, "workspace", mounted[1]
        parts = name.split("/")
        if len(parts) >= 3 and parts[0] == "w" and parts[1]:
            role = "other_private_upload"
            if len(parts) >= 5 and parts[2] == "conversations":
                role = "conversation_metadata"
            elif len(parts) >= 5 and parts[2] == "pods":
                if parts[4] == "state":
                    role = "sandbox_state"
                elif parts[4] == "sandbox-functions":
                    role = "sandbox_function"
            elif len(parts) >= 6 and parts[2] == "frames":
                if parts[4:6] == ["state", "files"]:
                    role = "frame_file"
                elif parts[4] == "publications":
                    role = "frame_publication"
                elif parts[4:6] == ["state", "databases"]:
                    role = "sandbox_state"
            return role, "workspace", parts[1]
        return "other_private_upload", "unknown", UNKNOWN_SCOPE_ID

    if layout == "data-sources":
        for pattern, role in (
            (CORE_DOCUMENT_PATH, "core_document_envelope"),
            (CORE_LEGACY_TEXT_PATH, "core_legacy_text"),
            (CORE_DOCUMENT_ID_PATH, "core_document_id"),
        ):
            match = pattern.fullmatch(name)
            if match:
                return role, "core_project", match[1]
        return "other_data_source", "unknown", UNKNOWN_SCOPE_ID

    return "unclassified", "unknown", UNKNOWN_SCOPE_ID


@dataclass
class Stats:
    object_count: int = 0
    stored_bytes: int = 0
    largest_object_bytes: int = 0

    def add(self, size_bytes: int) -> None:
        self.object_count += 1
        self.stored_bytes += size_bytes
        self.largest_object_bytes = max(self.largest_object_bytes, size_bytes)

    def row(self) -> dict[str, int]:
        return {column: getattr(self, column) for column in STAT_COLUMNS}


class Inventory:
    def __init__(self, layout: str):
        self.layout = layout
        self.totals = Stats()
        self.directory_markers = 0
        self.pages = 0
        self.by_content_type = defaultdict(Stats)
        self.by_role = defaultdict(Stats)
        self.by_scope = defaultdict(Stats)
        self.by_category = defaultdict(Stats)

    def add(self, name: str, size_bytes: int, raw_type: str | None, encoding: str | None):
        """@cc [owner:flvndvd,label:backend] inventory-counted-bytes
        Each listed live object MUST contribute its complete GCS size exactly once.
        Zero-byte directory markers MUST be counted separately. Object names MUST NOT
        supply a missing MIME type. Missing names or invalid sizes raise ValueError
        at this standalone CLI boundary and prevent a completed report.
        """
        if not name or not isinstance(size_bytes, int) or size_bytes < 0:
            raise ValueError("GCS returned missing or invalid name/size metadata")
        if name.endswith("/") and size_bytes == 0:
            self.directory_markers += 1
            return
        content_type = normalize_content_type(raw_type)
        category = content_category(content_type)
        role, scope_kind, scope_id = storage_role(name, self.layout)
        content_encoding = (encoding or "identity").strip().lower() or "identity"
        self.totals.add(size_bytes)
        self.by_content_type[(role, content_type, category, content_encoding)].add(size_bytes)
        self.by_role[(role, category)].add(size_bytes)
        self.by_scope[(scope_kind, scope_id, role, category)].add(size_bytes)
        self.by_category[category].add(size_bytes)


def scan(bucket, layout: str, prefixes: list[str], page_size: int) -> Inventory:
    """@cc [owner:flvndvd,label:security,label:performance] inventory-metadata-only
    Scanning MUST use paginated object listings only, with no object body downloads,
    per-object metadata fetches, or remote writes. Every page MUST be consumed.
    Retained state MUST scale with aggregate groups, not with listed object count.
    """
    inventory = Inventory(layout)
    for prefix in prefixes:
        blobs = bucket.list_blobs(
            prefix=prefix,
            versions=False,
            page_size=page_size,
            fields=LIST_FIELDS,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        for page in blobs.pages:
            for blob in page:
                inventory.add(blob.name, blob.size, blob.content_type, blob.content_encoding)
            inventory.pages += 1
            if inventory.pages % PROGRESS_EVERY_PAGES == 0:
                LOGGER.info(
                    "%s pages, %s objects, %s stored bytes",
                    inventory.pages, inventory.totals.object_count, inventory.totals.stored_bytes,
                )
    return inventory


def write_csv(path: Path, bucket: str, dimensions: list[str], groups) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["bucket", *dimensions, *STAT_COLUMNS])
        writer.writeheader()
        for key, stats in sorted(groups.items()):
            writer.writerow({"bucket": bucket, **dict(zip(dimensions, key)), **stats.row()})


def write_json(path: Path, value) -> None:
    temporary_path = path.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(path)


def write_report(output_dir: Path, run: dict, inventory: Inventory) -> None:
    write_csv(
        output_dir / "by-content-type.csv", run["bucket"],
        ["storage_role", "content_type", "content_category", "content_encoding"],
        inventory.by_content_type,
    )
    write_csv(
        output_dir / "by-role.csv", run["bucket"],
        ["storage_role", "content_category"], inventory.by_role,
    )
    write_csv(
        output_dir / "by-scope.csv", run["bucket"],
        ["scope_kind", "scope_id", "storage_role", "content_category"], inventory.by_scope,
    )
    write_json(output_dir / "summary.json", {
        **run,
        "status": "complete",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "list_pages": inventory.pages,
        "directory_markers_excluded": inventory.directory_markers,
        "totals": inventory.totals.row(),
        "by_content_category": {
            key: inventory.by_category[key].row() for key in ("text", "binary", "unknown")
        },
        "measurement": "GCS stored object bytes from declared MIME metadata",
        "unique_application_files": None,
        "extracted_text_bytes": None,
    })


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, help="Bucket name without gs://")
    parser.add_argument(
        "--layout", required=True, choices=["private-uploads", "data-sources", "generic"],
        help="Interpret object paths using the selected repository storage layout",
    )
    parser.add_argument(
        "--prefix", action="append", help="Literal GCS prefix, repeatable. Default: entire bucket",
    )
    parser.add_argument("--output-dir", type=Path, required=True, help="New local output directory")
    parser.add_argument("--project", help="Google Cloud project for the ADC client")
    parser.add_argument("--billing-project", help="Billing project for Requester Pays buckets")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    args = parser.parse_args(argv)
    if not args.bucket or "/" in args.bucket:
        parser.error("--bucket must be a bucket name without a scheme or path")
    if not 1 <= args.page_size <= DEFAULT_PAGE_SIZE:
        parser.error(f"--page-size must be between 1 and {DEFAULT_PAGE_SIZE}")
    args.prefixes = sorted(args.prefix or [""])
    for previous, current in zip(args.prefixes, args.prefixes[1:]):
        if current.startswith(previous):
            parser.error("--prefix values must not duplicate or overlap each other")
    return args


def main(argv=None) -> None:
    args = parse_args(argv)
    # Import the SDK only for scanning so help works without it.
    from google.cloud import storage

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    run = {
        "schema_version": 1,
        "status": "incomplete",
        "bucket": args.bucket,
        "layout": args.layout,
        "prefixes": args.prefixes,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "object_versions": "live only",
        "page_size": args.page_size,
    }
    write_json(args.output_dir / "summary.json", run)
    with storage.Client(project=args.project) as client:
        bucket = client.bucket(args.bucket, user_project=args.billing_project)
        inventory = scan(bucket, args.layout, args.prefixes, args.page_size)
    write_report(args.output_dir, run, inventory)
    LOGGER.info(
        "Complete: %s objects, %s stored bytes. Reports: %s",
        inventory.totals.object_count, inventory.totals.stored_bytes, args.output_dir,
    )


if __name__ == "__main__":
    main()
