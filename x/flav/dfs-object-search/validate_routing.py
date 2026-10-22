"""Verify the checked-in cell routing settings on disposable ES 8.16 + ICU.

Only diagnostic indices are created and deleted. This checks physical shard
selection and document operations, not search latency or storage capacity.
"""

import json
from collections import Counter
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:19217"
ROOT = Path(__file__).resolve().parent
DEFINITIONS = ROOT.parents[2] / "dfs/server/src/search/indices"
TENANT_SAMPLES = 256
DOCUMENT_SAMPLES = 512
INT_MAX = (1 << 31) - 1


def request(method, path, payload=None, ndjson=False):
    """@cc [owner:flvndvd,label:security] partition-probe-local-only
    Requests MUST target localhost:19217. Before mutating diagnostic indices,
    callers MUST verify the disposable cluster name and Elasticsearch version.
    """
    data = None if payload is None else (
        payload.encode() if ndjson else json.dumps(payload).encode()
    )
    content_type = "application/x-ndjson" if ndjson else "application/json"
    with urlopen(Request(BASE + path, data, {"Content-Type": content_type}, method=method), timeout=60) as response:
        return json.load(response)


def formula_shards(tenant_hash, primaries, routing_slots, partition):
    factor = routing_slots // primaries
    hashes = ((tenant_hash + offset + (1 << 31)) % (1 << 32) - (1 << 31)
              for offset in range(partition))
    return {value % routing_slots // factor for value in hashes}


def check_hash_classes(primaries, routing_slots, partition, expected):
    # Non-overflowing hashes repeat modulo routing_slots. Check each overflow separately.
    hashes = list(range(routing_slots)) + list(range(INT_MAX - partition + 2, INT_MAX + 1))
    counts = Counter(len(formula_shards(value, primaries, routing_slots, partition)) for value in hashes)
    assert set(counts) == {expected}, counts
    return {"normal_residue_classes": routing_slots, "overflow_hashes": partition - 1,
            "physical_fanout_histogram": dict(counts)}


info = request("GET", "/")
if info["cluster_name"] != "codex-dfs-search-analysis" or info["version"]["number"] != "8.16.0":
    raise SystemExit("This probe requires the disposable codex-dfs-search-analysis cluster on ES 8.16.0.")

invalid_index = "codex-dfs-partition-equal"
try:
    request("PUT", "/" + invalid_index, {"settings": {
        "number_of_shards": 10, "number_of_replicas": 0,
        "number_of_routing_shards": 10, "routing_partition_size": 10,
    }, "mappings": {"_routing": {"required": True}}})
except HTTPError as error:
    rejection = json.load(error)
    assert error.code == 400, rejection
    assert "routing partition size [10]" in rejection["error"]["reason"], rejection
else:
    request("DELETE", "/" + invalid_index)
    raise AssertionError("ES 8.16 unexpectedly accepted a partition equal to its routing slots")

mappings = json.loads((DEFINITIONS / "objects_1.mappings.json").read_text())
results = []
for cell in ["cell-00000", "cell-00001", "cell-00002"]:
    settings = json.loads((DEFINITIONS / f"objects_1.settings.{cell}.json").read_text())
    # The single-node probe has no workload label or place for replica copies.
    settings.pop("routing.allocation.require.workload", None)
    settings["number_of_replicas"] = 0
    primaries = settings["number_of_shards"]
    routing_slots = settings["number_of_routing_shards"]
    partition = settings["routing_partition_size"]
    formula = check_hash_classes(primaries, routing_slots, partition, expected=10)
    index = "codex-dfs-partition-" + cell
    request("PUT", "/" + index, {"settings": settings, "mappings": mappings})
    try:
        state = request("GET", "/_cluster/state/metadata/" + index + "?filter_path=metadata.indices.*.routing_num_shards")
        assert state["metadata"]["indices"][index]["routing_num_shards"] == routing_slots
        fanout = Counter()
        first_shards = None
        for number in range(TENANT_SAMPLES):
            tenant = "tenant-" + str(number)
            groups = request("GET", "/" + index + "/_search_shards?" + urlencode({"routing": tenant}))["shards"]
            shards = sorted(group[0]["shard"] for group in groups)
            assert len(shards) == 10, (cell, tenant, shards)
            if cell == "cell-00002":
                assert shards == list(range(primaries)), (tenant, shards)
            fanout[len(shards)] += 1
            if number == 0:
                first_shards = shards

        tenant = "tenant-0"
        lines = []
        for number in range(DOCUMENT_SAMPLES):
            lines.append(json.dumps({"index": {"_index": index, "_id": tenant + ":" + str(number), "routing": tenant}}))
            lines.append(json.dumps({"tenant_id": tenant, "object_id": str(number),
                                     "name": "Document " + str(number), "kind": "file", "is_deleted": False}))
        bulk = request("POST", "/_bulk?refresh=true", "\n".join(lines) + "\n", ndjson=True)
        assert not bulk["errors"], bulk

        placement = {}
        for shard in first_shards:
            response = request("GET", "/" + index + "/_count?" + urlencode({"preference": "_shards:" + str(shard)}))
            placement[str(shard)] = response["count"]
        assert sum(placement.values()) == DOCUMENT_SAMPLES, placement
        assert all(count > 0 for count in placement.values()), placement

        route = urlencode({"routing": tenant})
        query = {"query": {"term": {"tenant_id": tenant}}}
        assert request("POST", "/" + index + "/_count?" + route, query)["count"] == DOCUMENT_SAMPLES
        document_path = "/" + index + "/_doc/" + tenant + ":0?" + route
        assert request("GET", document_path)["_source"]["object_id"] == "0"
        updated = request("POST", "/" + index + "/_update/" + tenant + ":0?" + route, {"doc": {"name": "Updated"}})
        assert updated["result"] == "updated", updated
        assert request("GET", document_path)["_source"]["name"] == "Updated"
        assert request("DELETE", document_path + "&refresh=true")["result"] == "deleted"
        assert request("POST", "/" + index + "/_count?" + route, query)["count"] == DOCUMENT_SAMPLES - 1

        result = {"cell": cell, "primary_shards": primaries, "routing_shards": routing_slots,
                  "partition_size": partition, "tenant_samples": TENANT_SAMPLES,
                  "physical_fanout_histogram": dict(fanout), "formula_checks": formula,
                  "tenant_0_document_placement": placement, "document_operations": "passed"}
        results.append(result)
        print(json.dumps(result), flush=True)
    finally:
        request("DELETE", "/" + index)

output = ROOT / "artifacts/partition-routing-results.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"version": info["version"]["number"],
                              "equal_partition_rejection": rejection["error"]["reason"],
                              "results": results}, indent=2) + "\n")
