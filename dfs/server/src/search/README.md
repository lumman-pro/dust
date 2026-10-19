# Object search index

DFS owns the `dfs.objects` search alias and its first physical index, `dfs.objects_1`.
The [design and validation evidence](../../../design-docs/search/dfs-object-search-revised-design.md)
explain the object projection, analysis, and intended query behavior.

Neutral name, content, and selected attribute fields always retain the original searchable text.
Only classified text populates the explicit `stemmed.en` / `stemmed.fr` fields. Language detection
and confidence policy belong to the projection work. This command does not run a detector.
`ancestor_ids` stores all physical ancestors, excluding the object itself. `read_grant_scope_ids`
stores the object IDs where a direct READ grant could authorize the object, including itself and
ancestors through the closest read-DENY, inclusive. Without a read-DENY, it includes all ancestors
plus self. Subtree filters use `ancestor_ids`, with an `object_id` alternative when including the
selected object. Current read grants select candidates, then DFS must recheck permission once per
distinct object before returning its title or content.

`kind` is `file` or `directory`. `mime_type` retains the normalized format. Friendly type aliases
such as `type:pdf` or `type:spreadsheet` belong to application query compilation and resolve to
filters on those fields. They do not require a separate indexed category.

The versioned JSON files in `indices/` are embedded in the Rust bootstrap command. All cells
share the same mapping and analysis. Local settings use one primary and no replica. Production
settings use three primaries, one replica, and a five-second refresh. Each cell has its own settings
file: `cell-00000` and `cell-00001` require nodes labeled `workload=filesystem`. `cell-00002` uses
the shared pool without a workload allocation constraint. These operational values still need
validation against the real corpus.
Elasticsearch 8.16 with `analysis-icu` is required.

From `dfs/server`, preview the complete creation body without contacting Elasticsearch:

```sh
cargo run --bin elasticsearch_create_index -- --cell local
```

Create the index and write alias on a local cluster:

```sh
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
  cargo run --bin elasticsearch_create_index -- --cell local --execute
```

For production, select `--cell cell-00000`, `--cell cell-00001`, or `--cell cell-00002`
(or set `CELL`) and provide
`ELASTICSEARCH_URL`, `ELASTICSEARCH_USERNAME`, and `ELASTICSEARCH_PASSWORD`. Credentials are
optional for a local cluster with security disabled. Username and password must be supplied
together. `ELASTICSEARCH_CA_CERT` may point to a PEM CA certificate for a private cluster.
TLS certificate and hostname verification remain enabled.

Bootstrap checks that both names are unused, then creates the index and write alias in one
request. An existing index or alias is an error. A failed or unacknowledged operation may already
have created the index, so inspect cluster state before retrying. The command does not migrate,
delete, replace, or automatically retry an existing setup. Incompatible schema changes require a
new physical index version and an explicit migration.

Run the bootstrap tests with `cargo test --test search`. The linked research harness exercises
the actual JSON definitions against its isolated ES 8.16 + ICU cluster, including prefix, phrase,
English/French stemming, and matches across fields.

This initial implementation provides schema and bootstrap tooling. The object projection,
durable indexing work, extraction lifecycle, authorization rechecks, and search query
lexer/parser/compiler remain application work. The DFS server does not create indices at startup.
