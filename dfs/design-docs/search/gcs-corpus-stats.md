# GCS corpus statistics

`gcs_corpus_stats.py` counts live GCS objects and their stored bytes by MIME type, storage role, and workspace or core project. It only lists metadata. It does not download content, query a database, or change GCS.

Run from the repository root with Python 3.10+. Authentication uses Application Default Credentials, such as `gcloud auth application-default login`, or the machine's existing workload identity. The caller needs `storage.objects.list` on the bucket.

```sh
python3 -m venv /tmp/dfs-gcs-stats-venv
/tmp/dfs-gcs-stats-venv/bin/python -m pip install 'google-cloud-storage>=3,<4'

/tmp/dfs-gcs-stats-venv/bin/python dfs/design-docs/search/gcs_corpus_stats.py \
  --bucket YOUR_PRIVATE_UPLOADS_BUCKET \
  --layout private-uploads \
  --prefix files/w/ --prefix w/ \
  --output-dir /tmp/dfs-private-uploads-stats

/tmp/dfs-gcs-stats-venv/bin/python dfs/design-docs/search/gcs_corpus_stats.py \
  --bucket YOUR_DATA_SOURCES_BUCKET \
  --layout data-sources \
  --output-dir /tmp/dfs-data-source-stats
```

Use the bucket names configured by `DUST_PRIVATE_UPLOADS_BUCKET` and `DUST_DATA_SOURCES_BUCKET` in the cell being measured. For one workspace, use `--prefix files/w/WORKSPACE_ID/ --prefix w/WORKSPACE_ID/`. For one core data source, use `--prefix CORE_PROJECT_ID/DATA_SOURCE_INTERNAL_ID/`. Prefixes are literal and must not overlap. Omitting them scans the entire bucket. Use a different output directory for each run. `--project` selects the client project, and `--billing-project` supports Requester Pays buckets.

Alternatively, `uv run dfs/design-docs/search/gcs_corpus_stats.py ...` installs the dependency from the script's inline metadata.

The output directory contains:

| File | What to plot |
| --- | --- |
| `by-content-type.csv` | `object_count` and `stored_bytes` by `storage_role`, `content_type`, `content_category`, and `content_encoding` |
| `by-role.csv` | Text, binary, and unknown counts and bytes within each storage role |
| `by-scope.csv` | Workspace or core project distribution, separated by role and category |
| `summary.json` | Scan scope, completion status, total counts and bytes, and category totals |

CSV rows include `bucket` and `largest_object_bytes`. Counts and bytes are integers. Sum across MIME types within the desired role to obtain total text volume. Filter `content_type=application/pdf` for PDF counts and bytes. The grand total measures storage objects, which can include several representations of one application file.

The roles follow existing storage layouts:

| Role | Objects |
| --- | --- |
| `canonical_original` | `files/w/{workspace}/{fileId}/original` |
| `canonical_processed` | Extraction, transcription, image processing, or other derived output at the corresponding `/processed` path |
| `mounted_file` | Conversation, pod, or user files under `w/{workspace}/.../files/`, including copies of canonical files and files written directly to a mount |
| `mounted_processed_candidate` | Mounted filenames matching the application's `.processed` naming convention. This is a naming heuristic |
| `core_document_envelope` | Versioned `{project}/{dataSource}/{documentHash}/{created}_{contentHash}.json` blobs |
| `core_legacy_text`, `core_document_id` | Legacy `content.txt` and `document_id.txt` blobs, reported separately |

Conversation metadata, Frame publications and persistent files, sandbox state, and unrecognized paths have separate roles. Use `--layout generic` for another bucket, where all objects have the `unclassified` role.

**Interpretation:** MIME comes only from GCS `contentType`, lowercased with parameters removed. Missing or invalid MIME is `unknown`. Generic octet streams retain their MIME but have category `unknown`. No original type is guessed from internal paths. `text` includes `text/*`, JSON, XML, known textual application types, and Dust Frame sources. Other declared MIME types are grouped as `binary`. These are metadata classifications, not content verification.

**Sizing:** `stored_bytes` includes compression and container overhead as stored. `content_encoding` exposes declared compression. Core JSON includes `full_text` and `sections`, so its size is not the UTF-8 size of extracted text. A core JSON blob does not reveal the original file's MIME type. `extracted_text_bytes` stays null, and no PDF-to-text expansion ratio is assumed. Text/plain processed objects provide observed extracted or transcribed storage volume, but are not joined to their originals.

**Completeness:** The script consumes every list page, keeps only aggregate groups, and uses the SDK's retries. Zero-byte names ending in `/` are counted as directory markers outside the file totals. Historical GCS generations and soft-deleted objects are excluded. Core application versions remain distinct live GCS objects. Orphaned uploads and current application membership cannot be resolved without the database. A running bucket is not an atomic snapshot. `summary.json` becomes `complete` only after the full scan and CSV writes succeed. Errors leave it `incomplete` and exit nonzero.

Offline verification:

```sh
/tmp/dfs-gcs-stats-venv/bin/python -m unittest discover \
  -s dfs/design-docs/search -p test_gcs_corpus_stats.py
```

Layout sources: [FileResource paths](../../../front/lib/resources/file_resource.ts), [mount paths](../../../front/types/mount_path.ts), [GCS filesystem paths](../../../front/lib/api/file_system/backends/gcs_file_system_backend.ts), and [core document storage](../../../core/src/data_sources/file_storage_document.rs). GCS behavior: [paginated object listings](https://cloud.google.com/storage/docs/json_api/v1/objects/list) and [object size metadata](https://cloud.google.com/storage/docs/json_api/v1/objects).
