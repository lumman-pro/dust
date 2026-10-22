# Tenant routing and shard counts

Checked against Elasticsearch 8.16.0 on 2026-10-21. These settings are implemented
in the draft PR. Routing and document operations are verified. Capacity tests remain.

| Cell | Primary shards `S` | Virtual routing slots `R` | Partition size `P` | Physical shards per tenant |
| --- | ---: | ---: | ---: | ---: |
| `cell-00000` | 100 | 100 | 10 | 10 |
| `cell-00001` | 100 | 100 | 10 | 10 |
| `cell-00002` | 10 | 50 | 49 | All 10 |

All three cells have one replica per primary. The large cells therefore have
200 shard copies each, and the small cell has 20. The settings live beside the
[mapping](../../../dfs/server/src/search/indices/objects_1.mappings.json).

Use `routing=tenant_id` for writes, reads, updates, deletes, and searches in every
cell. Keep a compound tenant/object `_id`, required `_routing`, and a `tenant_id`
query filter. Routing chooses shards but does not isolate tenants. Different
tenants can share the same shards. Partitioned indices require routing and prohibit
join fields, which fits this mapping.
[Routing documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/mapping-routing-field.html#routing-index-partition).

## Why the routing slot count matters

Set `number_of_routing_shards` explicitly. In ES 8.16, `routing_partition_size`
counts virtual routing slots. Several slots can map to the same physical shard.
With `F = R / S`, the tagged implementation uses these formulas:

```text
document shard = floorMod(int32(hash(tenant_id) + floorMod(hash(_id), P)), R) / F
search shards = distinct(floorMod(int32(hash(tenant_id) + i), R) / F, i = 0..P-1)
```

Division is integer division, and `int32` preserves signed 32-bit overflow.
The tenant hash chooses the partition, and the document ID hash chooses a slot
within it. Search visits each distinct physical shard in that partition.
[Hash conversion](https://github.com/elastic/elasticsearch/blob/v8.16.0/server/src/main/java/org/elasticsearch/cluster/routing/IndexRouting.java#L130-L138),
[partition calculation](https://github.com/elastic/elasticsearch/blob/v8.16.0/server/src/main/java/org/elasticsearch/cluster/routing/IndexRouting.java#L239-L253).

Leaving `R` at its default can give a much smaller physical spread than expected.
For ten primaries, ES defaults to 640 routing slots. Setting only `P=10` then
reaches one or two physical shards. A live check with 256 tenant keys found
222 reaching one shard and 34 reaching two.
[Default calculation](https://github.com/elastic/elasticsearch/blob/v8.16.0/server/src/main/java/org/elasticsearch/cluster/metadata/MetadataCreateIndexService.java#L1658-L1678).

For the large cells, `S=R=100` gives one slot per physical shard. A partition of
ten therefore gives ten physical shards per tenant. There is no reserved split
to more primaries with `R=S`. Growing beyond 100 primaries would need a new index
and reindexing. Ten shards also remain the limit for one tenant, shared with other
tenants. Ten shards do not guarantee ten distinct nodes.
[Index settings](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/index-modules.html#_static_index_settings),
[routing calculation](https://github.com/elastic/elasticsearch/blob/v8.16.0/server/src/main/java/org/elasticsearch/cluster/routing/IndexRouting.java#L239-L253).

## Why the small cell uses 50 slots and a partition of 49

The requested behavior is tenant routing across all ten physical shards.
ES 8.16 rejects `S=R=P=10` because the partition must be smaller than the routing
slot count. Using `S=10, R=50, P=49` gives five slots per physical shard.
A partition covering 49 of those 50 slots reaches every physical shard.

Normally, one shard receives four slots and the other nine receive five each.
For uniformly distributed document hashes, their expected shares are about
8.2% and 10.2%. Signed overflow can make those shares less even, but every shard
remains reachable. The probe checks all 50 normal residue classes and all
48 possible overflow cases, covering every signed 32-bit tenant hash.

The 8.16 settings reference and implementation allow `P<R` with `R` a multiple
of `S`. The routing guide instead says `P<S`. The implemented layout follows the
tagged validation and has passed a live ES 8.16 check.
[Settings reference](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/index-modules.html#_static_index_settings),
[partition validation](https://github.com/elastic/elasticsearch/blob/v8.16.0/server/src/main/java/org/elasticsearch/cluster/metadata/IndexMetadata.java#L2265-L2277),
[routing guide](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/mapping-routing-field.html#routing-index-partition).

## What the live check proves

[validate_routing.py](validate_routing.py) loads the actual settings and mapping.
For its disposable single-node cluster, it removes the workload label requirement
and sets replicas to zero. It checks the following for each production cell:

- 256 tenant keys each search ten physical shards.
- In the small cell, each tenant reaches the complete set of shard IDs, 0 through 9.
- 512 documents for one tenant occupy all ten selected shards.
- Routed count, get, update, and delete operations find the expected documents.
- Exhaustive routing residue and signed-overflow checks give the same fanout.

The large-cell document counts ranged from 39 to 62 per selected shard.
The small-cell counts ranged from 41 to 60. These are small deterministic samples,
not balance or performance guarantees. The probe also verifies that `10/10/10`
is rejected. Results are written to ignored `artifacts/partition-routing-results.json`.
Rerun it before changing these settings or the ES version used to create the index.

## Storage target and remaining measurements

The 6–12 month target is 100 GB per primary, with benchmarks at 120 GB.
Across 100 balanced primaries, that means 10–12 TB of primary index data, or
20–24 TB with one replica, before keeping free disk space. Elastic recommends
10–50 GB as a starting range. Our larger target needs representative search and
recovery measurements. Infrequent updates reduce write load but do not remove
query or recovery costs.
[Sizing guidance](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/size-your-shards.html).

The supplied bucket estimates are 20 TB for `cell-00000` and 29 TB for `cell-00001`.
They include stored files and copies, not just live searchable text. They cannot
be converted directly into ES bytes. Measure live objects, extracted text, and
actual index size with this mapping before estimating required storage.

The pool defined by [infra PR #1174](https://github.com/dust-tt/dust-infra/pull/1174)
has three filesystem data nodes per large cell. Data disks total 900 GiB in
`cell-00000` and 750 GiB in `cell-00001`. With one replica, that leaves at most
450 GiB and 375 GiB for primary data before free space and recovery headroom.
Disk capacity must grow during import. Adding primary shards does not add disk.

Before a large import, measure the largest tenants, concurrent search latency,
prefix queries, heap, disk usage, and node-loss recovery. Routing tests establish
where documents go. They do not establish safe shard size or production capacity.
