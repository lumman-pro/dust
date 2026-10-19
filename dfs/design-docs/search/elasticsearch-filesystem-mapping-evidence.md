# Elasticsearch filesystem metadata mapping: evidence for 8.16

The current integrated proposal and live ES checks are in the
[revised design](dfs-object-search-revised-design.md). This file records the initial source-only
investigation, not the final lexical mapping recommendation.

Research date: 2026-10-19. Scope: Elasticsearch behavior and existing Dust index conventions. This note does not derive the filesystem schema from the design document or inspect production data. The parent investigation establishes the authoritative DFS entities, database fields, permissions, and workload. Recommendations below are conditional on those findings. No Elasticsearch deployment or benchmark was run.

The target version reported by the infrastructure investigation is Elasticsearch 8.16.0. References use the 8.16 guide or the exact `v8.16.0` source tag; several unavailable guide pages were verified through the public GitHub contents API instead.

## Mapping primitives and their consequences

| Concern | Verified behavior | Recommendation for the filesystem projection |
| --- | --- | --- |
| IDs and enums | `keyword` supports exact matching. Even numeric identifiers can be mapped as keywords when their queries are equality-based. [8.16 keyword documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/keyword.html) | Preserve the authoritative identifier encoding. Use numbers for quantities or ordered values, not automatically for every identifier stored numerically in the database. |
| Ancestor ID lists | There is no separate array mapping. A field can contain multiple values of its mapped type; an empty array is treated as missing. [8.16 array source](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/array.asciidoc) | A `keyword` field handles an ancestor-ID set directly. A `term` filter implements membership. Store the immediate parent separately for direct-child listing. |
| Exact names | A plain keyword has no normalizer by default. `term` matches indexed terms; its optional case-insensitive mode in 8.16 is ASCII-only. [Keyword mapping](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/keyword.html), [term query](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-term-query.html) | Keep canonical name/path equality case-sensitive if that is the database rule. Put user-friendly case folding on a separate search representation. |
| Schema control | `dynamic: "strict"` rejects documents containing unmapped fields. It does not declare fields required. [Dynamic mapping](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/dynamic.html) | Use an explicit projection and strict mapping. Application validation must still enforce required fields, enum values, and scalar-versus-array cardinality. |
| Quantities | `long` is signed 64-bit; `unsigned_long` supports the full unsigned 64-bit range. Numeric coercion normally accepts strings and truncates fractions for integer types. [8.16 numeric source](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/numeric.asciidoc) | Check source ranges, especially Rust `u64` values, before choosing `long`. Consider `coerce: false` for signed integer quantities so invalid projection values fail visibly. |
| Object relationships | Normal object arrays flatten their fields and can match values from different array elements. `nested` preserves each element as a separate hidden document. [Nested mapping](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/nested.html) | Flat scalar ID lists do not require `nested`. Use it only for actual tuples whose relationships must survive querying, such as a list of grant records containing several jointly queried fields. |

**Hierarchy semantics are a design choice, not a mapping feature.** Specify whether an ancestor list excludes the object itself. A name such as `ancestor_ids` should mean proper ancestors; an inclusive set needs an explicit name or documented contract. Do not infer the immediate parent from the first or last indexed keyword value. Normal `_source` may preserve the submitted array, but membership filters do not establish an ordered tree. The serializer should emit a distinct parent field. These are recommendations based on the [array model](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/array.asciidoc).

Derived consequence: moving a subtree changes the materialized ancestors of its descendants. Renaming a directory preserves ID-based ancestry, but changes any materialized descendant paths. Storing both ancestry and full paths accepts both maintenance costs. Neither field supplies authorization semantics by itself.

## Name and path search

Choose mappings from the supported query operations:

- **Exact basename or path equality:** a raw `keyword` field, within a verified length bound. Optional normalized keyword multifields support a separately defined insensitive comparison. Normalizers emit one token; lowercasing is available without an ICU plugin. [8.16 normalizers](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-normalizers.html)
- **Word-oriented filename search:** an explicitly analyzed `text` representation. A standard analyzer changes tokenization and case, so a `term` query on that representation is not canonical filename equality. [8.16 term query](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-term-query.html)
- **Path subtree selection:** prefer ancestor-ID membership when ancestry is already materialized. `path_hierarchy` is an alternative for path-string queries: `/one/two/three` produces the cumulative prefixes `/one`, `/one/two`, and `/one/two/three`. It does not resolve an object ID or permission. [8.16 tokenizer source](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/analysis/tokenizers/pathhierarchy-tokenizer.asciidoc)
- **Glob or substring search:** establish real usage before adding n-grams or a `wildcard` field. Leading-wildcard queries can be expensive and are subject to `search.allow_expensive_queries`. [8.16 wildcard query](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-wildcard-query.html)

`wildcard` is not an automatic filename default. Elastic recommends it for repeated wildcard/regexp searches over high-cardinality strings with leading wildcards, or over values longer than 32 KB. Exact full-value searches are slower than on `keyword`, and shared prefixes can increase storage relative to keyword. Benchmark the actual filename/path distribution. [8.16 keyword-family guidance](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/keyword.html)

### Long paths require an explicit policy

Lucene's maximum indexed term length is 32,766 **bytes**. `ignore_above` counts characters, applies separately to array elements, and drops an oversized value from indexing while retaining it in normal `_source`. Elastic suggests 8,191 characters as a conservative ceiling for arbitrary UTF-8. [8.16 `ignore_above`](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/ignore-above.html)

Recommendation: do not silently ignore an identifier or canonical path used for required lookup or permission filtering. First verify the database's byte-length limits. If full paths can exceed the term limit, omit their exact indexed representation, use a fixed-length digest with original-value verification when exact lookup is needed, or adopt a representation proven to support the required operation. An `ignore_above` guard can be acceptable for an optional search/sort multifield only if incomplete results for those values are an accepted product rule. This is a design inference, not an Elasticsearch guarantee.

`path_hierarchy` does not eliminate this issue: its longest emitted token can be the full path. Nor does a component-name limit establish a full-path limit. These conclusions follow from the [tokenizer output](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/analysis/tokenizers/pathhierarchy-tokenizer.asciidoc).

## Timestamps, quantities, and stored data

`date` stores millisecond resolution and defaults to `strict_date_optional_time||epoch_millis`. Numeric timestamps are therefore milliseconds unless another format is specified. [8.16 date mapping](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/date.html)

For source timestamps whose contract is unsigned 64-bit milliseconds, an `unsigned_long` field with an explicit `_ms` name preserves that domain. A `date` field stores a signed long and introduces date parsing; it is not a lossless substitute for every possible `u64` value. A separately generated server indexing timestamp can use `date` with a deliberately bounded domain. This is a recommendation based on the [8.16 numeric types](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/numeric.asciidoc) and [date representation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/date.html).

Recommendation: distinguish the source file's modification time, the metadata record's revision, and the time the projection was indexed. They answer different questions. A filesystem timestamp is not automatically a monotonic revision suitable for replay ordering. Preserve authoritative unit/range semantics rather than copying a generic `updated_at` convention.

Index only fields that serve a query, filter, sort, or aggregation. `doc_values` supports sorting and aggregations and defaults to enabled on supporting types. `index: false` alone still leaves keyword, numeric, and date fields queryable through slower doc-value access. A known field needed only in `_source` can disable both `index` and `doc_values`; a filter-only field may disable doc values after checking consumers. [8.16 doc values](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/doc-values.html)

## Dedicated node allocation

For the infrastructure-reported `node.attr.workload: filesystem`, the minimal production placement constraint is:

```json
{
  "index.routing.allocation.require.workload": "filesystem"
}
```

**Fact:** custom node attributes work through index allocation filters. `require` conditions must all match; exclusions must not match; inclusion filters accept matching alternatives. Other allocation constraints still apply, including the rule that primary and replica copies cannot share a node. [8.16 allocation-filtering source](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/index-modules/allocation/filtering.asciidoc)

**Recommendation:** use `require.workload` to express the hard ownership boundary and keep it out of local settings unless the local node has the attribute. A single-value `include.workload` can also select that value, but should not be confused with soft preference or fallback.

`_tier_preference` selects built-in tier roles such as `data_content` or `data_hot`; `filesystem` is not a tier. The generic `data` role cannot itself be named as a preferred tier. [8.16 tier allocation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/data-tier-shard-filtering.html)

A generic data node matches tier filtering. Therefore assigning `workload=filesystem` does not, by itself, prevent unrelated indices from placing shards on those nodes. The infrastructure's inverse exclusion strategy for other indices/templates must also be checked. Do not install a cluster-wide exclusion for filesystem nodes and expect an index-level requirement to override it: both levels constrain allocation. These are consequences of the [8.16 filtering rules](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/index-modules/allocation/filtering.asciidoc), not evidence that a particular deployed template is correct.

## Routing and capacity

Elasticsearch normally routes by `_id`. Custom routing directs a value to one shard; routing partitions can distribute that value over a subset of shards, trading reduced skew for more search fan-out. Custom routing must be supplied consistently to writes, gets, updates, and deletes; use `_routing.required` if adopting it. `_id` uniqueness is no longer guaranteed across different routing values. [8.16 routing documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/mapping-routing-field.html)

Recommendation: do not choose tenant routing merely because every query is tenant-scoped. Measure the largest tenant's documents, bytes, write rate, and query concurrency. One large tenant can concentrate traffic on one shard even with many dedicated nodes. Default ID routing is a reasonable baseline; tenant routing or partitioned routing needs workload evidence. Every query still needs the tenant filter: choosing a shard is not authorization.

Three nodes do not establish the right primary-shard count. Elastic recommends benchmarking production-like data, hardware, queries, and ingestion. Its 10–50 GB shard range and below-200-million-documents guidance are starting points, not a sizing result for this index. Include replicas, backfill peaks, and node-failure recovery in capacity planning. [8.16 shard sizing](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/size-your-shards.html)

If permissions use a request-supplied list of IDs, the default `terms` query limit is 65,536 values, including values resolved with terms lookup. Model large accessible-object or grant sets before treating that query shape as unbounded. [8.16 terms query](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-terms-query.html)

## Identity, replay, and deletion

Use a deterministic ID derived from the authoritative identity and its namespace. A path is usually a poor identity when objects survive renames. `_id` is limited to 512 bytes and cannot be used directly for sorting or aggregations; retain a separate keyword identity field if it is a cursor tiebreaker. [8.16 `_id`](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/mapping-id-field.html)

A stable `_id` deduplicates writes but does not prevent old events from overwriting newer metadata. `version_type: external` accepts only a strictly greater source version; it is designed for asynchronous database indexing arriving out of order. Equal-version retries conflict. `external_gte` permits equal versions and carries an explicit warning about potential data loss. Both require a compatible nonnegative long version, not an arbitrary database token. [8.16 index versioning](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/docs-index_.html)

Recommendation: establish an authoritative monotonic revision covering all projected fields, with a deterministic snapshot for that revision. Do not substitute ingestion time, wall-clock modification time, or an unchecked FDB versionstamp. If the source provides no usable revision, define serialization or reconciliation semantics explicitly before claiming replay safety.

**Deletion is a separate problem.** Elasticsearch retains a deleted document's version for `index.gc_deletes`, 60 seconds by default. After that retention expires, its deletion version cannot reject arbitrarily delayed old writes. [8.16 delete API](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/docs-delete.html)

Recommendation: use durable tombstones or another source-driven replay barrier that outlives the maximum event/rebuild delay. Increasing `gc_deletes` alone is not a proof against unbounded replay. Rereading the source helps but still needs a rule for an older in-flight writer racing with deletion. Define deleted-object ID reuse as well.

`delete_by_query` operates on a snapshot, uses internal versions, can encounter concurrent-write conflicts, and does not roll back successful deletes when later work fails. It is not an atomic subtree operation or a durable ban on future stale writes. [8.16 delete by query](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/docs-delete-by-query.html)

## Dust conventions to reuse, with ownership kept explicit

- [Front's registry](../../../front/lib/api/elasticsearch.ts) uses `INDEX_REGISTRY`, pairing each index directory with a current version. Its aliases include `front.agents`, `front.skills`, and `front.user_search`. [The creation script](../../../front/scripts/create_elasticsearch_index.ts) reads versioned mappings plus regional settings, creates `front.<name>_<version>`, then adds `front.<name>` as a write alias.
- [Core's creation tool](../../../core/bin/elasticsearch/create_index.rs) mirrors the shape with `core.<name>_<version>` and `core.<name>`. [Its registry](../../../core/src/search_stores/search_store.rs) is `INDEX_VERSIONS`. This supports an owner namespace plus entity collection, not forcing a DFS-owned index under `front` or `core`.
- [Core's node mapping](../../../core/src/search_stores/indices/data_sources_nodes_4.mappings.json) already combines strict mappings, keyword node identity, separate `parents` and `parent_id` fields, and `text`/keyword title multifields. [Its production settings](../../../core/src/search_stores/indices/data_sources_nodes_4.settings.us-central1.json) contain ICU and edge n-gram analysis. These are precedents, not evidence that those names, analyzers, shard counts, or a full-path field fit the new DFS workload.

Recommendation: keep one stable alias and versioned concrete indices, owned by the service responsible for the projection. Backfill and catch up a new version before exposing it. The current creation scripts attach aliases immediately after creating the index; that alone is not a complete live-migration procedure. Elasticsearch supports atomic alias changes, but the application must arrange ingestion continuity and remove the old read target at cutover. [8.16 alias API](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/indices-aliases.html)

## Remaining decisions

Apply these rules to the authoritative database/workload findings: the indexed entity's identity and cardinality; canonical path/name semantics and byte limits; timestamp units and ranges; metadata versus content revisions; source versions and durable deletion records; required exact/prefix/glob/full-text operations; ancestor inclusion and root conventions; permissions semantics; tenant skew; and acceptable search freshness. The combined design must state those decisions before selecting final field names, mappings, and settings.

Version caveats: current Elastic documentation contains features absent from 8.16, including newer routing behavior. Use the pinned 8.16 references above. Synthetic `_source` for a general-purpose index is still technical preview in 8.16 and can sort/deduplicate keyword arrays, so ordinary `_source` is the conservative baseline. [8.16 keyword synthetic-source behavior](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/keyword.html)
