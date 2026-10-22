"""Offline inventory checks using the real SDK with a fake HTTP transport."""

import contextlib
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import requests
from google.auth.credentials import AnonymousCredentials
from google.api_core.exceptions import Forbidden
from google.cloud import storage

import gcs_corpus_stats as inventory


class ListTransport:
    is_mtls = False

    def __init__(self, pages):
        self.pages = iter(pages)
        self.page_tokens = []
        self.prefixes = []

    def request(self, method, url, **kwargs):
        parsed = urlsplit(url)
        if method != "GET" or parsed.path != "/storage/v1/b/test-bucket/o":
            raise AssertionError("Only the object listing endpoint may be called")
        query = parse_qs(parsed.query)
        if query.get("fields") != [inventory.LIST_FIELDS]:
            raise AssertionError("The listing must request only inventory metadata")
        self.page_tokens.append(query.get("pageToken", [None])[0])
        self.prefixes.append(query.get("prefix", [""])[0])
        payload = next(self.pages)
        response = requests.Response()
        response.request = requests.Request(method, url).prepare()
        response.status_code = payload.get("error", {}).get("code", 200)
        response.headers["Content-Type"] = "application/json"
        response._content = json.dumps(payload).encode()
        return response

    def close(self):
        pass


class InventoryTests(unittest.TestCase):
    def test_originals_processed_outputs_and_mounted_files_are_separate(self):
        result = inventory.Inventory("private-uploads")
        for name, size, mime in [
            ("files/w/ws/file1/original", 1000, "Application/PDF"),
            ("files/w/ws/file1/processed", 100, "text/plain; charset=utf-8"),
            ("w/ws/pods/p/files/report.pdf", 900, "application/pdf"),
            ("w/ws/pods/p/files/report.processed.txt", 100, "text/plain"),
            ("files/w/ws/misleading.pdf/original", 20, None),
        ]:
            result.add(name, size, mime, None)
        self.assertEqual(result.totals.object_count, 5)
        self.assertEqual(result.totals.stored_bytes, 2120)
        self.assertEqual(result.by_category["text"].stored_bytes, 200)
        self.assertEqual(result.by_category["binary"].stored_bytes, 1900)
        self.assertEqual(result.by_category["unknown"].stored_bytes, 20)
        self.assertEqual(result.by_role[("canonical_original", "binary")].stored_bytes, 1000)
        self.assertEqual(result.by_role[("canonical_processed", "text")].stored_bytes, 100)
        self.assertEqual(result.by_role[("mounted_file", "binary")].stored_bytes, 900)
        self.assertEqual(
            result.by_role[("mounted_processed_candidate", "text")].stored_bytes, 100,
        )
        self.assertEqual(result.by_scope[("workspace", "ws", "canonical_original", "unknown")].object_count, 1)

    def test_core_envelopes_keep_document_versions_and_metadata_separate(self):
        result = inventory.Inventory("data-sources")
        for name, size, mime in [
            ("project/ds/hash/1700_contenthash.json", 200, "application/json"),
            ("project/ds/hash/1701_newhash.json", 300, "application/json"),
            ("project/ds/hash/contenthash/content.txt", 50, "text/plain"),
            ("project/ds/hash/document_id.txt", 10, "text/plain"),
        ]:
            result.add(name, size, mime, None)
        self.assertEqual(result.by_role[("core_document_envelope", "text")].object_count, 2)
        self.assertEqual(result.by_role[("core_document_envelope", "text")].stored_bytes, 500)
        self.assertEqual(result.by_role[("core_legacy_text", "text")].stored_bytes, 50)
        self.assertEqual(result.by_role[("core_document_id", "text")].stored_bytes, 10)
        self.assertEqual(result.by_scope[("core_project", "project", "core_document_envelope", "text")].stored_bytes, 500)

    def test_directory_markers_unknown_types_and_content_encoding_are_visible(self):
        result = inventory.Inventory("generic")
        result.add("folder/", 0, None, None)
        result.add("folder/empty.txt", 0, "text/plain", None)
        result.add("folder/data.json.gz", 50, "Application/JSON; charset=UTF-8", "gzip")
        result.add("folder/missing.pdf", 60, None, None)
        result.add("folder/generic.txt", 70, "application/octet-stream", None)
        result.add("folder/invalid.txt", 80, "bad content type", None)
        result.add("folder/nonempty/", 1, "text/plain", None)
        self.assertEqual(result.directory_markers, 1)
        self.assertEqual(result.totals.object_count, 6)
        self.assertEqual(result.by_category["unknown"].stored_bytes, 210)
        self.assertEqual(result.by_content_type[("unclassified", "application/json", "text", "gzip")].stored_bytes, 50)
        self.assertEqual(result.by_content_type[("unclassified", "text/plain", "text", "identity")].object_count, 2)

    def test_full_pagination_including_an_empty_page_uses_only_listing(self):
        transport = ListTransport([
            {"items": [{"name": "files/w/ws/f/original", "size": "100", "contentType": "application/pdf"}], "nextPageToken": "second"},
            {"nextPageToken": "third"},
            {"items": [{"name": "files/w/ws/f/processed", "size": "30", "contentType": "text/plain"}]},
        ])
        with storage.Client(project="unit-tests", credentials=AnonymousCredentials(), _http=transport) as client:
            result = inventory.scan(client.bucket("test-bucket"), "private-uploads", ["files/w/"], 1)
        self.assertEqual(transport.page_tokens, [None, "second", "third"])
        self.assertEqual(result.pages, 3)
        self.assertEqual(result.totals.object_count, 2)
        self.assertEqual(result.totals.stored_bytes, 130)
        self.assertEqual(result.by_role[("canonical_original", "binary")].stored_bytes, 100)
        self.assertEqual(result.by_role[("canonical_processed", "text")].stored_bytes, 30)

    def test_reports_preserve_large_integer_bytes_and_do_not_claim_extracted_size(self):
        result = inventory.Inventory("private-uploads")
        size = 2**53 + 1
        result.add("files/w/ws/f/original", size, "application/pdf", None)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            inventory.write_report(output_dir, {"bucket": "test-bucket", "status": "incomplete"}, result)
            summary = json.loads((output_dir / "summary.json").read_text())
            with (output_dir / "by-content-type.csv").open(newline="") as handle:
                rows = list(csv.DictReader(handle))
        self.assertEqual(summary["status"], "complete")
        self.assertEqual(summary["totals"]["stored_bytes"], size)
        self.assertIsNone(summary["extracted_text_bytes"])
        self.assertIsNone(summary["unique_application_files"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["stored_bytes"], str(size))
        self.assertEqual(rows[0]["object_count"], "1")
        self.assertEqual(rows[0]["content_type"], "application/pdf")

    def test_overlapping_prefixes_fail_before_any_listing(self):
        for prefixes in [["w/", "w/ws/"], ["files/w/", "files/w/"], ["", "w/"]]:
            with self.subTest(prefixes=prefixes), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    inventory.parse_args([
                        "--bucket", "test-bucket", "--layout", "private-uploads",
                        "--output-dir", "/tmp/unused-inventory-test",
                        *[arg for prefix in prefixes for arg in ("--prefix", prefix)],
                    ])
            self.assertEqual(raised.exception.code, 2)

    def test_missing_size_stops_the_scan_instead_of_counting_zero(self):
        transport = ListTransport([{"items": [{"name": "files/w/ws/f/original"}]}])
        with storage.Client(project="unit-tests", credentials=AnonymousCredentials(), _http=transport) as client:
            with self.assertRaisesRegex(ValueError, "name/size"):
                inventory.scan(client.bucket("test-bucket"), "private-uploads", ["files/w/"], 1)

    def test_failed_listing_can_be_retried_and_completed_results_are_preserved(self):
        transport = ListTransport([
            {"items": [{"name": "files/w/ws/f/original", "size": "100"}], "nextPageToken": "second"},
            {"error": {"code": 403, "message": "fixture access denied"}},
        ])
        client = storage.Client(project="unit-tests", credentials=AnonymousCredentials(), _http=transport)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "new-report"
            with patch.object(storage, "Client", return_value=client):
                with self.assertRaises(Forbidden):
                    inventory.main([
                        "--bucket", "test-bucket", "--layout", "private-uploads",
                        "--output-dir", str(output_dir),
                    ])
            summary = json.loads((output_dir / "summary.json").read_text())
            self.assertEqual(summary["status"], "incomplete")
            self.assertNotIn("totals", summary)
            self.assertEqual(list(output_dir.glob("*.csv")), [])
            retry_transport = ListTransport([
                {"items": [{"name": "files/w/ws/f/original", "size": "100", "contentType": "application/pdf"}]},
            ])
            retry_client = storage.Client(
                project="unit-tests", credentials=AnonymousCredentials(), _http=retry_transport,
            )
            arguments = [
                "--bucket", "test-bucket", "--layout", "private-uploads",
                "--output-dir", str(output_dir),
            ]
            with patch.object(storage, "Client", return_value=retry_client):
                inventory.main(arguments)
            completed = json.loads((output_dir / "summary.json").read_text())
            self.assertEqual(completed["status"], "complete")
            self.assertEqual(completed["totals"]["stored_bytes"], 100)
            reports = {
                path.name: path.read_bytes() for path in output_dir.iterdir()
                if path.name != ".scan.lock"
            }
            with patch.object(storage, "Client") as client_factory:
                with self.assertRaisesRegex(ValueError, "choose a new --output-dir"):
                    inventory.main(arguments)
                client_factory.assert_not_called()
            self.assertEqual(reports, {
                path.name: path.read_bytes() for path in output_dir.iterdir()
                if path.name != ".scan.lock"
            })

    def test_workspace_scan_lists_only_the_exact_workspace_prefix(self):
        transport = ListTransport([
            {"items": [{"name": "w/ws/pods/p/files/report.pdf", "size": "100", "contentType": "application/pdf"}]},
        ])
        client = storage.Client(project="unit-tests", credentials=AnonymousCredentials(), _http=transport)
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "workspace-report"
            with patch.object(storage, "Client", return_value=client):
                inventory.main([
                    "--bucket", "test-bucket", "--layout", "private-uploads",
                    "--workspace-id", "ws", "--output-dir", str(output_dir),
                ])
            summary = json.loads((output_dir / "summary.json").read_text())
        self.assertEqual(transport.prefixes, ["w/ws/"])
        self.assertEqual(summary["prefixes"], transport.prefixes)
        self.assertEqual(summary["totals"]["object_count"], 1)

    def test_invalid_workspace_scopes_are_rejected(self):
        for layout, scope in [
            ("private-uploads", ["--workspace-id", "ws", "--prefix", "w/ws/"]),
            ("private-uploads", ["--workspace-id", "w/ws"]),
            ("private-uploads", ["--workspace-id", ""]),
            ("data-sources", ["--workspace-id", "ws"]),
        ]:
            with self.subTest(layout=layout, scope=scope):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        inventory.parse_args([
                            "--bucket", "test-bucket", "--layout", layout,
                            "--output-dir", "/tmp/unused-inventory-test", *scope,
                        ])
                self.assertEqual(raised.exception.code, 2)

    def test_placeholder_bucket_fails_without_creating_output_or_a_client(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "new-report"
            with patch.object(storage, "Client") as client_factory:
                with contextlib.redirect_stderr(io.StringIO()) as errors:
                    with self.assertRaises(SystemExit) as raised:
                        inventory.main([
                            "--bucket", "YOUR_PRIVATE_UPLOADS_BUCKET", "--layout", "private-uploads",
                            "--output-dir", str(output_dir),
                        ])
                client_factory.assert_not_called()
            self.assertEqual(raised.exception.code, 2)
            self.assertIn("placeholder", errors.getvalue())
            self.assertFalse(output_dir.exists())

    def test_output_directory_retries_legacy_markers_but_protects_partial_and_active_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            marker = output_dir / "summary.json"
            marker.write_text(json.dumps({"schema_version": 1, "status": "incomplete"}))
            with inventory.report_directory(output_dir):
                with self.assertRaisesRegex(ValueError, "another scan"):
                    with inventory.report_directory(output_dir):
                        self.fail("the second scan must not start")
            self.assertEqual(json.loads(marker.read_text())["status"], "incomplete")
            partial = output_dir / "by-content-type.csv"
            partial.write_text("unfinished report")
            with self.assertRaisesRegex(ValueError, "choose a new --output-dir"):
                with inventory.report_directory(output_dir):
                    self.fail("partial reports must not be overwritten")
            self.assertEqual(partial.read_text(), "unfinished report")
            self.assertEqual(json.loads(marker.read_text())["status"], "incomplete")


if __name__ == "__main__":
    unittest.main()
