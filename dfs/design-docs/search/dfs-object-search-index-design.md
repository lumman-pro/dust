**Proposal: one search document per stored DFS object in `dfs.objects`.**

**Revision notice:** the lexical mapping, analyzers, and query recommendations below are superseded
by the [tested bilingual search design](dfs-object-search-revised-design.md). Storage, identity,
authorization, and publication analysis below remains supporting context. Use the JSON files linked
from the revised design for the current proposed mapping.

Reviewed on 2026-10-19. This is a design proposal, with a concrete mapping and candidate settings.
It does not create a production index or change application behavior. Source code establishes the
stored schema here. No production records, corpus statistics, or deployed cluster state were
inspected. Keyword behavior was checked in a disposable local Elasticsearch 8.16.0 instance.

The inputs are [infrastructure PR #1174 at `5331b86`](https://github.com/dust-tt/dust-infra/pull/1174),
[search proposal #35070 at `b37e616`](https://github.com/dust-tt/dust/pull/35070), and the checked-out
[DFS implementation at `7f5fba7`](https://github.com/dust-tt/dust/tree/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs).
The search PR changes design documents only. The implementation has advanced since its base,
including a separate `grants_version` and superuser semantics. The current Search RPC still returns
`UNSUPPORTED`. [Search implementation](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/api.rs#L424)

**Names and ownership.**

The `object` terminology and `dfs.objects` naming are agreed. Mapping and relevance choices below
remain proposals. The intended experience is full keyword search for people and LLMs, with a
Google Drive-like object search experience. The existing Search API is not a constraint on the
query semantics proposed here. The [full keyword-search analysis](dfs-full-keyword-search-design.md)
explains the retrieval design and its local evidence.

| Concept | Proposed name | Meaning |
| --- | --- | --- |
| Owning service | `dfs` | The Rust service that owns the FoundationDB filesystem. |
| Indexed collection / stable alias | `dfs.objects` | Stored files and directories, including the real tenant root. |
| First physical index | `dfs.objects_1` | Mapping generation 1. |
| Projection type | `ObjectSearchDocument` | Internal ES representation, separate from the RPC's `SearchAttr`. |
| Object identity | `object_id` | Existing UUIDv7, displayed as lowercase 32-digit hex. |
| Tenant identity | `tenant_id` | Existing DFS tenant string, preserved exactly. |
| Physical ancestry | `ancestor_ids` | All ancestors from tenant root to immediate parent, excluding the indexed object. |
| Read-grant eligibility | `read_grant_scope_ids` | Object IDs where a direct READ grant could authorize this object, including self and the closest read-DENY node. Defined below. |
| Extracted or native searchable text | `content_text` | Text belonging to the original object's search result. |
| Infrastructure placement | Per-cell settings | `cell-00000` / `cell-00001` require `workload=filesystem`. `cell-00002` uses its shared pool. |

`ObjectResource` is the common stored entity for files and directories. Keep `kind` as the field
that distinguishes `file` and `directory`. Reserve “node” for an explicitly named context such as
an ES data node or the existing core data-source nodes. Reserve `root_id` for the tenant's real root.
There is no per-object, user-independent “highest accessible parent” in storage.
[ObjectResource](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L152),
[TenantResource](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/tenant.rs#L51),
[ObjectId encoding](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/protocol/src/id.rs#L10)

The alias follows the existing owner/collection convention used by `front.agents`, `front.skills`,
and `core.data_sources_nodes`. DFS should own its mapping, serializer, and creation command. A future
implementation can place versioned JSON files under `dfs/server/src/search/indices/`. It should not
register this as a front-owned index. [Front registry](../../../front/lib/api/elasticsearch.ts),
[core index creation](../../../core/bin/elasticsearch/create_index.rs)

Use the same production alias in separate cell clusters. Each alias must target exactly one
FDB environment. If test and production share ES, give test a separate namespace such as
`dfs.test.objects`. FDB already separates environments, but its implementation currently hardcodes
the `test` namespace. Deployment configuration must resolve this explicitly.
[FDB namespace](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/keys.rs)

**What storage actually contains.**

The following keys are relative to the tenant's FDB subspace. These are implemented records, not
the future queue/extraction records proposed by #35070.

| FDB record | Stored value | Search projection |
| --- | --- | --- |
| `object/<objectId>` | Parent, basename, kind, size, optional access/modification/change times, attribute/content/grant versions | Identity, hierarchy inputs, name, kind, size, timestamps, freshness versions |
| `metadata/<objectId>` | Creation time, optional MIME string | `created_at_ms`, normalized `mime_type` |
| `metadata/<objectId>/xattr/<name>` | Original value bytes, including empty values | Exact key existence and exact key/value candidate filters |
| `child/<parentId>/<name>` | Child ID | Traversal and subtree rebuilding. No separate ES document |
| `block/<objectId>/<blockIndex>` | Up to 64 KiB of file bytes | Eligible text reconstructed from the logical file |
| `object-grant/<objectId>/...` | Local ALLOW and DENY rules | Read-inheritance boundaries. Authoritative permission checks stay in FDB |
| `grant-object/ALLOW/<subject>/<objectId>/<mode>` | Reverse ALLOW membership | Request-time set of direct read-grant locations |

The actual tuple encoding and metadata writes are in
[object.rs](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L284).
The implemented [storage overview](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/design-docs/STORAGE.md#objects-and-contents)
describes directory bindings and blocks. File reads zero-fill missing blocks and clip to logical
EOF, so concatenating only physically present blocks would produce the wrong content for sparse
files. [File read contract](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/file.rs#L193)

Virtual `root` and `shared` are access projections. `shared` has no object record. Index the real
tenant root once, with its stored empty basename. Never serialize a session's `Attr.mode` as a
shared permission field: it is computed for that session. `store_version` is also computed for a
read or mutation response. [Stat serialization](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object/stat.rs)

**The permission field needs a different model from the DD's scalar `root_id`.**

For ordinary sessions, the implementation walks root to object and computes
`permissions = (inherited & ~local_deny) | matching_local_allow`. A read DENY blocks inherited
read, but an ALLOW on that same object or a descendant can restore it.
[Permission implementation and contracts](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object/modes.rs#L41)

Consider this tree, with no DENY:

```text
tenant root        ALLOW engineering read
└── reports        ALLOW finance read
    └── budget.pdf
```

Engineering can read the file through the tenant root. Finance can read it through `reports`.
A scalar “highest accessible parent” differs between these users. Filtering one fixed scalar
against each user's direct grant locations loses one valid access path. Calling it an ACL scope
would require an additional scope model and rules for splitting scopes when grants change.

Proposed representation: build `read_grant_scope_ids` from the indexed object toward the tenant
root, stopping after including the closest ancestor-or-self carrying a DENY with the read bit.
Without such a DENY, include the tenant root. Include every object on that chain, even when it has
no ALLOW today. Otherwise adding a grant would require descendant rewrites. The DENY object is
included because its own ALLOW applies after its DENY.

For the example above, the set is `[tenant_root, reports, budget]`. With a read-DENY directory
inserted between root and reports, physical ancestors still include root, but read inheritance
becomes `[denied_directory, reports, budget]`.

At query time, resolve `read_grant_object_ids` from the tenant's reverse ALLOW index for the
session's exact subjects, retaining only modes with `mode & 4 != 0`. Intersect those IDs with
`read_grant_scope_ids` using `terms`. The current shared-listing helper also returns zero and
write-only grants, so it cannot be reused unchanged as a read-grant resolver.
[Reverse index writes](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L604),
[existing shared candidates](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object/shared.rs#L17)

This representation follows directly from the implemented read-bit recurrence. An exhaustive
model check covered 69,904 paths of one to four objects across all valid read/write ALLOW and DENY
bit combinations. Set intersection matched effective read in every case. This checks the algebra,
not a production indexer or concurrent revocation behavior.

Ordinary ALLOW changes update the request's grant set and need no descendant ES changes. Changes
to effective read-DENY boundaries or ancestry require rebuilding affected descendants. A DENY
affecting only write does not change the read chain. Superuser sessions skip this permission
prefilter while retaining tenant filtering and existence checks.

Always recheck current FDB permissions before releasing names or excerpts. Also recheck scope
and inherited search exclusion, if adopted: an ancestor move or exclusion can invalidate an ES
candidate without changing the candidate's own versions. This prefilter can have temporary false
negatives while hierarchy updates propagate. Final checks prevent stale candidates from being
disclosed. Never interpret an empty or truncated grant set as permission to omit the filter.

The number of direct grants per subject is not bounded by the 512-grants-per-object limit. Handle
grant sets exceeding Elasticsearch's default 65,536-term limit explicitly. Options include bounded
complete query decomposition or a bounded candidate/post-check fallback with truthful partial
results. Silently taking the first 65,536 IDs is incorrect.
[Terms limit](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-terms-query.html)

**Field choices.**

| Field | Mapping / meaning |
| --- | --- |
| `tenant_id`, `object_id` | Exact `keyword`. No case folding or normalizer |
| `ancestor_ids` | `keyword` array, all physical ancestors excluding self for recursive scope |
| `read_grant_scope_ids` | `keyword` array, eligible direct READ-grant object IDs including self, as above |
| `kind` | `keyword`, serialized as `file` or `directory`. Symlinks remain unsupported |
| `name` / `name.keyword` | Analyzed basename / exact case-sensitive basename and prefix filtering |
| `name.parts` | Filename components for separators and case transitions that ordinary text tokenization can miss |
| `name.folded` | Whole basename normalized with lowercase and ASCII folding, for a strong exact-name ranking signal |
| `name.edge` | Separate filename-token prefixes for interactive partial-name search |
| `mime_type` | `keyword`, normalized lowercase type/subtype without parameters. Omitted when absent |
| `size_bytes` | `unsigned_long`, original logical file size. Zero for directories |
| `mtime_ms` | `unsigned_long`, source modification time, supports the current range predicates |
| `atime_ms`, `ctime_ms`, `created_at_ms` | `unsigned_long`, kept in `_source` for the result projection |
| `xattr_names` | `keyword` array of exact present names, including binary and empty values |
| `xattr_pair_hashes` | `keyword` array of digests of complete name/value pairs |
| `content_text` | Analyzed text of the original file or its current extraction. Omitted when unavailable |
| `attr_version`, `content_version` | Original object's `u64` versions, retained in `_source` for freshness checks |
| `text_source_object_id`, `text_source_content_version` | Optional source-only provenance for the exact bytes used as text |
| `is_deleted` | `boolean`. Live records explicitly use false, retained tombstones use true |

The source stores `u64` sizes, versions, and Unix-millisecond timestamps. Keeping `*_ms` as
`unsigned_long` preserves its full accepted domain. `date` would introduce a signed-range
restriction that the current API does not impose. Preserve integer precision in serialization.
`ctime_ms` is attribute-change time. Creation time is the separate `created_at_ms`.
[Source types](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L152),
[version semantics](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/design-docs/VERSIONS.md),
[ES 8.16 numeric types](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/numeric.asciidoc)

The normalized MIME field is for filtering. Return the original stored MIME value and raw xattrs
from authorized FDB metadata when populating `SearchAttr.metadata`.

Do not copy arbitrary xattr names into dynamic mapping properties. The current API defines
byte-exact equality, while the DD changes that to truncated UTF-8 equality. Preserve the existing
semantics with `SHA-256(u32_be(name_utf8_length) || name_utf8 || raw_value)`, represented as
lowercase hex, plus the independent name-existence field. A present empty value has a digest.
An absent value does not. Hashing the pair preserves the relationship between name and value
without `nested` documents. Verify requested predicates against current FDB bytes before returning
hits, making hash collisions false candidates rather than false equality results.
[Existing search contract](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/design-docs/API.md#search)

This also handles the boundary where FDB permits 32,768 total xattr bytes but Lucene permits
32,766 bytes per keyword term. Truncating creates deliberate false equalities. `ignore_above`
silently loses matches. The bounded tenant IDs, UUID encodings, and basenames fit comfortably
without such truncation. Return raw xattr values from authorized FDB metadata when needed.
[Stored xattr validation](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L386),
[keyword limit](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/ignore-above.html)

Use ICU tokenization and folding for ordinary name/content search, with a separate filename-parts
representation. Exact basename and prefix predicates use `name.keyword`. The normalized and
token-prefix fields serve relevance and interactive search. The infrastructure template installs
`analysis-icu` for both node sets. Keep default BM25 initially.
[Infra template](https://github.com/dust-tt/dust-infra/blob/5331b869c113c69864c612ae4522e6209530584a/helm/infra/values/gcp/shared/elasticsearch.yaml.gotmpl),
[ICU folding](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-icu-folding)

**Lexical retrieval and ranking.**

Use independently scored filename and body fields, queried term by term. The recommended baseline
is a controlled `simple_query_string` inside a filtered `bool`, with all keywords required by
default and explicit phrases, alternatives, and exclusions. For example, `quarterly budget` can
match `quarterly` in the name and `budget` in the content. A quoted phrase must occur in one field.
With whitespace parsing enabled, different field analyzers can participate without requiring
the whole query to occur in a single field. The boosts below are illustrative, not tuned weights.
[8.16 query behavior and source evidence](dfs-search-ranking-evidence.md)

Do not use a scored catch-all as the initial backbone. In the local 215-object diagnostic, adding
10,000 unrelated body tokens to an unchanged filename cut its `copy_to` score to 5.7% and its
weighted `combined_fields` score to 16.6% of the short-body score. Independent field scoring left
the filename score unchanged. This demonstrates shared length normalization, not a production
relevance benchmark. A copied retrieval field remains an option if a measured query bottleneck
justifies it. Keep independent scoring and source-field highlighting if adopted.
[Diagnostic and interpretation](dfs-full-keyword-search-design.md#why-the-catch-all-is-not-the-default)

The local analyzer checks also showed that ICU alone misses `budget` in
`Q4_budget-final_v2.pdf`. Keep `name.parts` to retrieve filename components, alongside ordinary
`name` for multilingual segmentation. Keep original whole-name identity in `name.keyword` and
normalized whole-name matching in `name.folded`. Neither ordinary analysis nor filename splitting
preserves every meaningful technical symbol. `C++`/`C#` distinctions need additional targeted
normalization if required by the corpus.

Light stemming improves body recall, but requires a deliberate language profile. English KStem
recovered `employee request` against `Employees requested increases` in the diagnostic. Retain
unstemmed text for precise analyzed phrases and add supported-language stemmed alternatives to
candidate eligibility, not only to optional boosts. The concrete JSON below is the multilingual,
unstemmed baseline. Language-specific body representations must be chosen before finalizing that
extension. Keep stop-word policy explicit and preserve phrase positions.

Keep edge n-grams on `name.edge` for an explicit prefix mode. They are indexed prefixes, not
stemming, substring matching, or typo tolerance. The candidate 2–20 range preserves original
tokens: full longer words match, but intermediate prefixes beyond 20 do not. Whole-token body
search remains the default. Expanded prefix/stemmed branches must preserve all required phrases,
exclusions, and tenant/scope/permission predicates.
[Analysis tradeoffs](dfs-full-keyword-search-design.md#mapping-and-analysis)

Start with independently normalized BM25 plus whole-name and phrase signals. A bounded query
rescore can add expensive relevance signals after measuring candidate recall. Learned LTR needs
judgments and cannot recover candidates omitted by retrieval. The current stored data supplies
neither popularity nor per-user recent views. `atime_ms` is not updated automatically on reads.
PR #1174 reports ES 8.16.0 with Basic. Native LTR requires Enterprise model creation, while ordinary
query rescore is independent of that feature. The deployed license was not inspected.
[Ranking and licensing evidence](dfs-search-ranking-evidence.md)

**Concrete mapping for `objects_1.mappings.json`.**

Strict mapping rejects unknown fields. The serializer must additionally enforce required values,
valid enum values, ID formats, optionality, and array cardinality. Keep ordinary `_source` enabled.
Offsets on `content_text` support efficient unified highlighting with a modest indexing/storage
cost. Fields used only for freshness or provenance disable both indexing and doc values.
[Strict mapping](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/dynamic.html),
[offsets](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/index-options.html)

```json
{
  "dynamic": "strict",
  "_meta": { "schema_version": 1, "entity": "dfs_object" },
  "properties": {
    "tenant_id": { "type": "keyword" },
    "object_id": { "type": "keyword" },
    "ancestor_ids": { "type": "keyword" },
    "read_grant_scope_ids": { "type": "keyword" },
    "kind": { "type": "keyword" },
    "name": {
      "type": "text",
      "analyzer": "dfs_text",
      "fields": {
        "keyword": { "type": "keyword" },
        "folded": { "type": "keyword", "normalizer": "dfs_name_folded" },
        "parts": { "type": "text", "analyzer": "dfs_name_parts" },
        "edge": {
          "type": "text",
          "analyzer": "dfs_name_edge",
          "search_analyzer": "dfs_name_parts",
          "index_options": "docs",
          "norms": false
        }
      }
    },
    "mime_type": { "type": "keyword" },
    "size_bytes": { "type": "unsigned_long" },
    "mtime_ms": { "type": "unsigned_long" },
    "atime_ms": {
      "type": "unsigned_long", "index": false, "doc_values": false
    },
    "ctime_ms": {
      "type": "unsigned_long", "index": false, "doc_values": false
    },
    "created_at_ms": {
      "type": "unsigned_long", "index": false, "doc_values": false
    },
    "xattr_names": { "type": "keyword" },
    "xattr_pair_hashes": { "type": "keyword" },
    "content_text": {
      "type": "text", "analyzer": "dfs_text", "index_options": "offsets"
    },
    "attr_version": {
      "type": "unsigned_long", "index": false, "doc_values": false
    },
    "content_version": {
      "type": "unsigned_long", "index": false, "doc_values": false
    },
    "text_source_object_id": {
      "type": "keyword", "index": false, "doc_values": false
    },
    "text_source_content_version": {
      "type": "unsigned_long", "index": false, "doc_values": false
    },
    "is_deleted": { "type": "boolean" }
  }
}
```

No full textual pathname is materialized. A directory rename therefore changes its own document.
A move changes descendant ancestry. `ancestor_ids` supports strict-descendant search. To include
the scoped object itself, match either `ancestor_ids` or `object_id`, while retaining the separate
grant filter. These are useful filesystem scope operations independently of how a future API
exposes them.

**Index settings and allocation.**

The following historical candidate describes the dedicated pools in `cell-00000` and `cell-00001`,
not `cell-00002`. Use the current proposal and per-cell service definitions for deployment. These
values are benchmark inputs, not measured production sizing. Start comparisons with three and six primaries, one replica, and the actual tenant/text
distribution. A five-second refresh is an explicit initial freshness tradeoff. Measure it under
concurrent ingestion and search.

```json
{
  "number_of_shards": 3,
  "number_of_replicas": 1,
  "refresh_interval": "5s",
  "routing.allocation.require.workload": "filesystem",
  "analysis": {
    "normalizer": {
      "dfs_name_folded": {
        "type": "custom",
        "char_filter": [],
        "filter": ["lowercase", "asciifolding"]
      }
    },
    "filter": {
      "dfs_filename_parts": {
        "type": "word_delimiter_graph",
        "split_on_numerics": false,
        "preserve_original": false,
        "stem_english_possessive": false
      },
      "dfs_name_prefixes": {
        "type": "edge_ngram",
        "min_gram": 2,
        "max_gram": 20,
        "preserve_original": true
      }
    },
    "analyzer": {
      "dfs_text": {
        "type": "custom",
        "tokenizer": "icu_tokenizer",
        "filter": ["icu_folding"]
      },
      "dfs_name_edge": {
        "type": "custom",
        "tokenizer": "whitespace",
        "filter": ["dfs_filename_parts", "icu_folding", "dfs_name_prefixes"]
      },
      "dfs_name_parts": {
        "type": "custom",
        "tokenizer": "whitespace",
        "filter": ["dfs_filename_parts", "icu_folding"]
      }
    }
  }
}
```

This is the body of `settings`. The allocation setting's fully qualified name is
`index.routing.allocation.require.workload`. Regional files can initially share this candidate.
Local settings use one primary, zero replicas, the same analysis, and omit the workload constraint
unless the local node is explicitly labeled.

PR #1174 adds three data-only nodes in each of `cell-00000` and `cell-00001`, with `node.attr.workload=filesystem`
and zone awareness. It retains the existing ES endpoint. Its volumes are 300 Gi per node in US
and 250 Gi in EU. The node pool supplies capacity. The index's allocation filter selects that
capacity. Keep the existing zone awareness for primary/replica placement.
[Pool settings](https://github.com/dust-tt/dust-infra/blob/5331b869c113c69864c612ae4522e6209530584a/helm/infra/helmfile.yaml.gotmpl),
[node configuration](https://github.com/dust-tt/dust-infra/blob/5331b869c113c69864c612ae4522e6209530584a/helm/infra/values/gcp/shared/elasticsearch.yaml.gotmpl)

Before enabling allocation, every unrelated index and its template/creation path must exclude
`workload=filesystem`. The temporary cluster-wide filesystem exclusion from #1174 must then be
removed while preserving other exclusions. An index requirement cannot override that guard.
Leaving both in place makes the new index unallocatable. `_tier_preference` cannot express this
custom workload. This is a deployment dependency, not an action performed by this proposal.
[ES 8.16 allocation rules](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/index-modules/allocation/filtering.asciidoc)

Updated decision: require tenant routing from the first document. Set `_routing.required=true`
and use `routing=tenant_id` for every document operation, every bulk item, and tenant searches.
Keep the tenant filter and globally unique tenant/object document IDs. The current settings route
one tenant to one primary. Measure tenant skew before choosing a routing partition or changing
shard sizing. The [revised proposal](dfs-object-search-revised-design.md) records the active policy.
[8.16 routing](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/mapping-routing-field.html)

**Document identity, freshness, and publication order.**

Use `_id = base64url_no_pad(tenant_id UTF-8) + ":" + object_id_lowercase_hex`. This preserves the
existing tenant/object identity without delimiter ambiguity, is stable through renames, and is at
most 375 ASCII bytes given the current 256-byte tenant limit. Keep `object_id` as a separate
keyword for deterministic ordering. [Tenant bounds](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/protocol/proto/dfs.proto#L180),
[ES `_id` limit and sort restriction](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/mapping-id-field.html)

`attr_version` validates indexed name/metadata. `content_version` validates the original file's
content. They serve different checks and neither is an all-purpose publication sequence.
`grants_version` changes only on the object where a grant changes, so it does not summarize
inherited authorization and is omitted from the search projection. The index suffix and mapping
`_meta.schema_version` identify the schema. Avoid a redundant schema field on every document.

For native text, provenance points to the original object's ID/content version. For extraction,
it points to the text object's ID/content version, while the document's identity, metadata, and
`content_version` remain those of the original. A published extraction also needs an authoritative
association with the original content version. The mapping alone cannot establish this. A name
such as `dfs.search.source_object_id` on an extraction correctly names the original, whereas the
DD's `dfs.search.text_object_id = original.id` reverses what the name suggests. Extraction records
and this reserved xattr are still proposed work.

The asynchronous writer needs a durable, monotonic publication revision covering metadata,
content, ancestry, read boundaries, and deletion. Publish it using ES external versioning. It must
fit a nonnegative signed 64-bit value, so a full FDB versionstamp cannot be copied unchecked. Bind
each revision to a validated source snapshot and immutable payload, and reuse it on retries.
Assigning a higher revision after reading stale data would defeat the ordering guarantee.
[External versioning](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/docs-index_.html)

Retain deletion as a minimal document with `tenant_id`, `object_id`, and `is_deleted=true`,
protected by that same revision. Live searches explicitly filter `is_deleted=false`. Keep revisions
across object deletion/recreation and keep tombstones until
all older writers, retries, and rebuilds are fenced out. A hard delete alone forgets its version
after ES's default 60-second delete retention and can allow a delayed old write to recreate it.
These records/revisions require implementation in the durable publication path. They are not
already supplied by the object versions. [Delete retention](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/docs-delete.html)

**Query shape.**

The strings below stand for already validated tenant/object IDs. This is a completed keyword
query, without a rescore step. The internal candidate batch is separate from the requested result
limit. Fetch further candidates within an explicit request budget when permission or freshness
checks reject hits. The two-term example requires both words, allowing them to occur in different
fields. An explicit any-term option or visible partial-match fallback can relax coverage.

```json
{
  "size": 100,
  "track_total_hits": false,
  "_source": { "excludes": ["content_text"] },
  "query": {
    "bool": {
      "filter": [
        { "term": { "tenant_id": "authenticated-tenant" } },
        { "term": { "is_deleted": false } },
        { "terms": { "read_grant_scope_ids": ["direct-read-grant-object-id"] } },
        {
          "bool": {
            "should": [
              { "term": { "ancestor_ids": "authorized-scope-directory-id" } },
              { "term": { "object_id": "authorized-scope-directory-id" } }
            ],
            "minimum_should_match": 1
          }
        }
      ],
      "must": [
        {
          "simple_query_string": {
            "query": "quarterly budget",
            "fields": ["name^2", "name.parts^4", "content_text"],
            "default_operator": "and",
            "flags": "AND|OR|NOT|PHRASE|PRECEDENCE|WHITESPACE|ESCAPE"
          }
        }
      ],
      "should": [
        { "match_phrase": { "name": { "query": "quarterly budget", "boost": 4 } } },
        { "match_phrase": { "name.parts": { "query": "quarterly budget", "boost": 4 } } },
        { "match_phrase": { "content_text": { "query": "quarterly budget", "boost": 2 } } },
        { "term": { "name.folded": { "value": "quarterly budget", "boost": 16 } } }
      ]
    }
  },
  "sort": [{ "_score": "desc" }, { "object_id": "asc" }],
  "highlight": {
    "highlight_query": { "match": { "content_text": "quarterly budget" } },
    "fields": {
      "content_text": { "type": "unified", "fragment_size": 512, "number_of_fragments": 1 }
    }
  }
}
```

The example uses plain positive terms. For operator-bearing input, derive phrase/equality boosts
and highlighting from the positive clauses of the parsed query. Do not feed the raw operator string
to a phrase or exact-name boost. Whole-name equality is a preference, not a guaranteed ordering
rule under these illustrative numeric boosts.

For interactive prefix mode, admit a prefix alternative for the unfinished positive term in the
parsed query, using `name.edge`. Preserve the other required terms, all phrase/exclusion clauses,
and all hard filters. Merely adding an optional prefix clause under a mandatory whole-token query
would exclude prefix-only hits. Replacing the complete query with a loose prefix OR could discard
its Boolean meaning. Define whether the product supports a final-token prefix or prefix matching
on every positive term, and test the chosen behavior explicitly.

If adding Elasticsearch `rescore`, remove the explicit `object_id` secondary sort: 8.16 rescore
supports only descending score ordering. Decide pagination accordingly and keep its window fixed
across pages. A window of 500 means up to 500 candidates per shard, not 500 globally. Native LTR
additionally requires `window_size >= from + size`.
[Rescore constraints](dfs-search-ranking-evidence.md)

Use `match_all` for an explicit filter-only browse. Field-restricted searches can select the
appropriate lexical fields. Content searches return files. Exact name and name-prefix predicates
target `name.keyword`. Subtree scope targets `ancestor_ids`, with an `object_id` alternative when
including the selected object. Modification predicates target `mtime_ms`. Size/MIME predicates
select files. Combine independent metadata predicates with AND.
Enforce an application excerpt budget after highlighting. `fragment_size` is not a strict output
length guarantee. Names, snippets, and metadata are emitted only after current authorization and
the relevant source-version/predicate checks. Pagination, total counts, result limits, and query
budgets are explicit product/operational decisions, not inherited from the previous Search API.

**Remaining measurements and implementation requirements.**

Before selecting production shards/routing, measure per-tenant object count, indexable text bytes,
largest files, tree depth, direct-grant counts per session, and mixed search/import/update load.
Include replica recovery and a simultaneous old/new index during rebuild in disk sizing. Three
nodes establish the deployment shape, not a capacity result.

Define a bounded maximum text payload and explicit behavior for oversized or unsupported files
before concatenating content. The current file domain permits large and sparse files. An unbounded
whole-file buffer is unsafe. Preserve metadata search while making incomplete content indexing
observable. Binary content requires extraction and freshness tracking. An ES text field does not
perform extraction. Passage indexing remains a separate decision if corpus measurements show
that one text field per object is unsuitable.

The mapping needs an atomic FDB mutation/outbox path, coherent multi-transaction content reads,
durable subtree work, revision-protected publication, and authoritative result checks. Index
creation and backfill should remain separate: create the next physical index without moving the
serving alias, catch up its consumer, then atomically switch the alias and retire old writers.
The existing front/core creation commands attach aliases immediately and therefore are examples
of naming/file layout rather than a complete live-rebuild procedure.
[Alias operations](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/indices-aliases.html)

Validation for this proposal: source review, the permission-algebra check described above, JSON
syntax/field consistency checks, and synthetic keyword/analyzer checks on local ES 8.16.0 + ICU.
The concrete mapping/settings/query also passed a local smoke check with one primary, zero
replicas, and the production workload allocation filter omitted.
No judged production relevance evaluation, throughput benchmark, or production-data inspection
was performed. Additional evidence is in [the mapping note](elasticsearch-filesystem-mapping-evidence.md),
[the retrieval/ranking note](dfs-search-ranking-evidence.md), and
[the full keyword-search design](dfs-full-keyword-search-design.md).
