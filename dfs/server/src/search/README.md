# Object search index

DFS owns the `dfs.objects` search alias and its first physical index, `dfs.objects_1`.
The [design and validation evidence](../../../design-docs/search/dfs-object-search-revised-design.md)
explain the object projection, analysis, and intended query behavior.

The versioned JSON files in `indices/` are embedded in the Rust bootstrap command. All regions
share the same mapping and analysis. Local settings use one primary and no replica. Production
settings use three primaries, one replica, a five-second refresh, and require nodes labeled
`workload=filesystem`. These operational values still need validation against the real corpus.
Elasticsearch 8.16 with `analysis-icu` is required.

From `dfs/server`, preview the complete creation body without contacting Elasticsearch:

```sh
cargo run --bin elasticsearch_create_index -- --region local
```

Create the index and write alias on a local cluster:

```sh
ELASTICSEARCH_URL=http://127.0.0.1:9200 \
  cargo run --bin elasticsearch_create_index -- --region local --execute
```

For production, select `--region us-central1` or `--region europe-west1` and provide
`ELASTICSEARCH_URL`, `ELASTICSEARCH_USERNAME`, and `ELASTICSEARCH_PASSWORD`. Credentials are
optional for a local cluster with security disabled; username and password must be supplied
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
