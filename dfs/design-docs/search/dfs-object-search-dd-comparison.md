# DFS search mapping compared with the original DD

2026-10-19. **Status: comparison complete against the corrected mapping.**

Comparison against the [original DD at b37e616](https://github.com/dust-tt/dust/blob/b37e616c5926ed13112eb5d1e29538b6e45142ed/dfs/design-docs/SEARCH.md#fields), using the [active mapping](../../server/src/search/indices/objects_1.mappings.json) and [revised design](dfs-object-search-revised-design.md). The DD specified field representations, not executable mapping JSON. The current implementation provides schema/bootstrap, with projection and query compilation still outstanding.

| Original DD | Current mapping | Interpretation |
| --- | --- | --- |
| `tenant_id`, `object_id`, `kind`, `mime_type`: keywords | Same names/types | Retained. MIME remains normalized format metadata. |
| `ancestor_ids`: strict-ancestor keyword array | Same | Retained physical hierarchy, excluding self. |
| `root_id`: one highest accessible parent keyword | `read_grant_scope_ids`: keyword array | Replaced. Includes self through the closest read-DENY, inclusive. Can match direct grants at different eligible ancestors without one subject-dependent root. Current FDB permission checks remain required. |
| `name`: analyzed text plus exact keyword | `name` text, `name.parts` text, `name.keyword` keyword, `name.folded` normalized keyword, `name.token_count` numeric | Adds whole components plus CamelCase parts, case-independent queries, prefix acceleration, normalized equality, offsets, and future length features. |
| `text`: aggregated analyzed content | `content_text`: text, prefix acceleration, offsets, numeric `.token_count` | Renamed and expanded. Still one original-object result with its body, not block or extraction results. |
| `size`: `unsigned_long` bytes | `size_bytes`: `unsigned_long` | Unit-explicit rename only. |
| `atime`, `mtime`, `ctime`, `created`: optional `unsigned_long` milliseconds | `atime_ms`, `mtime_ms`, `ctime_ms`, `created_at_ms`: `unsigned_long` | Same source domain with clearer names. `atime_ms`/`ctime_ms` are source-only, with indexing and doc values disabled. Modification/creation remain searchable. |
| `xattrs`: escaped existence/value keywords, UTF-8 equality truncated at the term limit | `xattr_names`, `xattr_pair_hashes`: keyword arrays | Separate existence from proposed SHA-256 digests of complete key/raw-value pairs. Supports binary equality without deliberate truncation collisions. Projection encoding and final FDB verification remain to implement. |
| `schema_version`: document field, type unspecified | `_meta.schema_version: 1` | Moves rebuild compatibility to mapping metadata and the versioned index name. No per-document field. |
| Required tenant routing | `_routing.required: true` | Aligned. Use `routing=tenant_id` for document operations and searches, retaining tenant filters. |

**The original timestamps were already unsigned integers, not Elasticsearch dates.** Added `modified_at` and `created_at` are validated `date` projections for filters and future freshness features. They do not replace the raw values, and invalid/out-of-range dates must be omitted. `ctime_ms` is not creation time.

Additional fields:

- `stemmed.en` / `stemmed.fr` contain explicit text fields for `name`, `content_text`, and selected `attributes.title`, `description`, `tags`. Only reliably classified values populate them. Neutral fields always remain. Detection/calibration is still proposed.
- `attributes.title`/`description` are text. `attributes.tags` is normalized keyword plus `.text`. `owner_ids`/`source` are keywords and `source_modified_at` is a date. This optional producer-defined projection needs a registry, it is not established DB schema.
- `extension` and `content_status` are keywords. `is_deleted` is boolean. `attr_version`/`content_version` are source-only unsigned integers. Optional `text_source_object_id`/`text_source_content_version` retain source-only provenance.

There is no `file_type`, `projected_at`, `parent_id`, path, copied grant list, or catch-all field. Type aliases will compile to `kind`/`mime_type` filters. Query weights and compiler implementation remain deferred.

Operational differences: the DD disabled dynamic mapping. Current `dynamic: strict` explicitly rejects unknown fields. Tenant routing now follows the DD. The DD proposed 30-second refresh, while current settings use 5 seconds. Shard sizing and any future routing partition remain capacity decisions. All production cells use 3 primaries/1 replica. `cell-00000`/`cell-00001` require filesystem nodes, `cell-00002` has no workload constraint.

Separately, [later DD revision 54a60a2](https://github.com/dust-tt/dust/blob/54a60a2acf3a5368e486ed92553ba381d8b620a8/dfs/design-docs/SEARCH.md#extracted-text-storage) replaces extracted DFS objects with private generations. Reconcile the optional object-ID provenance fields with that newer lifecycle before implementing projection.
