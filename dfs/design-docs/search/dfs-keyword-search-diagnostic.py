"""Small, reproducible behavior checks, not a production relevance benchmark.

Requires the disposable ES 8.16.0 + analysis-icu instance named below.
Only the uniquely named diagnostic index on localhost:19217 is written.
"""

import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE_URL = "http://127.0.0.1:19217"
INDEX = "codex-dfs-keyword-diagnostic"
OUTPUT = Path(__file__).with_name("dfs-keyword-search-diagnostic-results.json")


def request(method, path, data=None, ndjson=False):
    payload = None if data is None else (
        data.encode() if ndjson else json.dumps(data).encode()
    )
    req = Request(
        BASE_URL + path,
        data=payload,
        method=method,
        headers={"Content-Type": "application/x-ndjson" if ndjson else "application/json"},
    )
    try:
        with urlopen(req, timeout=30) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"{method} {path}: {exc.read().decode()}") from exc


info = request("GET", "/")
assert info["cluster_name"] == "codex-dfs-search-analysis", info["cluster_name"]
assert info["version"]["number"] == "8.16.0", info["version"]

definition = {
    "settings": {
        "number_of_shards": 1,
        "number_of_replicas": 0,
        "analysis": {
            "normalizer": {
                "folded_name": {
                    "type": "custom", "filter": ["lowercase", "asciifolding"]
                }
            },
            "filter": {
                "filename_parts": {
                    "type": "word_delimiter_graph",
                    "split_on_numerics": False,
                    "preserve_original": False,
                    "stem_english_possessive": False,
                },
                "filename_prefixes": {
                    "type": "edge_ngram", "min_gram": 2,
                    "max_gram": 20, "preserve_original": True,
                },
            },
            "analyzer": {
                "lexical": {
                    "type": "custom", "tokenizer": "icu_tokenizer",
                    "filter": ["icu_folding"],
                },
                "lexical_en": {
                    "type": "custom", "tokenizer": "icu_tokenizer",
                    "filter": ["icu_folding", "lowercase", "kstem"],
                },
                "filename": {
                    "type": "custom", "tokenizer": "whitespace",
                    "filter": ["filename_parts", "icu_folding"],
                },
                "filename_edge": {
                    "type": "custom", "tokenizer": "whitespace",
                    "filter": ["filename_parts", "icu_folding", "filename_prefixes"],
                },
            },
        },
    },
    "mappings": {
        "dynamic": "strict",
        "properties": {
            "name": {
                "type": "text", "analyzer": "lexical", "copy_to": "search_text",
                "fields": {
                    "keyword": {"type": "keyword"},
                    "folded": {"type": "keyword", "normalizer": "folded_name"},
                    "parts": {"type": "text", "analyzer": "filename"},
                    "en": {"type": "text", "analyzer": "lexical_en"},
                    "edge": {
                        "type": "text", "analyzer": "filename_edge",
                        "search_analyzer": "filename", "norms": False,
                        "index_options": "docs",
                    },
                },
            },
            "content_text": {
                "type": "text", "analyzer": "lexical", "copy_to": "search_text",
                "index_options": "offsets",
                "fields": {"en": {"type": "text", "analyzer": "lexical_en"}},
            },
            "search_text": {"type": "text", "analyzer": "lexical"},
        },
    },
}
request("PUT", "/" + INDEX, definition)

docs = {
    "name_missing_body": {"name": "Quarterly budget"},
    "name_short_body": {"name": "Quarterly budget", "content_text": "notes " * 10},
    "name_long_body": {"name": "Quarterly budget", "content_text": "notes " * 10000},
    "body_only": {
        "name": "Committee minutes",
        "content_text": "The quarterly budget was approved by the board.",
    },
    "long_body_only": {
        "name": "Complete committee archive",
        "content_text": "notes " * 10000 + "The quarterly budget was approved by the board.",
    },
    "split_fields": {"name": "Quarterly", "content_text": "Budget approval meeting."},
    "split_filename_parts": {
        "name": "Q4_budget-final_v2.pdf", "content_text": "Board approval meeting."
    },
    "partial_query": {"name": "Quarterly plans", "content_text": "Headcount forecast."},
    "nonadjacent": {
        "name": "Finance report", "content_text": "The quarterly revised budget is ready."
    },
    "draft": {"name": "Quarterly budget draft", "content_text": "Draft for review."},
    "morphology": {
        "name": "Personnel requests", "content_text": "Employees requested increases."
    },
    "identifier": {"name": "RFC-1234 OAuth2 PKCE", "content_text": "Authentication guide."},
    "accented": {"name": "Réunion Équipe", "content_text": "Présentation du projet."},
    "long_word": {"name": "electroencephalographically derived signals"},
    "cjk": {"name": "東京 予算報告書", "content_text": "東京の予算について説明します。"},
}
for i in range(200):
    docs[f"background_{i:03}"] = {
        "name": f"Reference {i}", "content_text": "general reference material " * 100
    }
bulk = "".join(
    json.dumps({"index": {"_index": INDEX, "_id": doc_id}}) + "\n"
    + json.dumps(doc) + "\n"
    for doc_id, doc in docs.items()
)
indexed = request("POST", "/_bulk?refresh=true", bulk, ndjson=True)
assert not indexed["errors"], indexed


def search(query):
    response = request("POST", "/" + INDEX + "/_search", {
        "size": 30, "track_total_hits": True, "_source": False, "query": query
    })
    assert not response["timed_out"], response
    assert response["_shards"]["failed"] == 0, response
    return {
        "total": response["hits"]["total"]["value"],
        "hits": [{"id": hit["_id"], "score": hit["_score"]} for hit in response["hits"]["hits"]],
    }


FLAGS = "AND|OR|NOT|PHRASE|PRECEDENCE|WHITESPACE|ESCAPE"


def simple(query, fields=None):
    return {"simple_query_string": {
        "query": query, "fields": fields or ["name^4", "content_text"],
        "default_operator": "and", "flags": FLAGS,
    }}


def combined(query, operator="and"):
    return {"combined_fields": {
        "query": query, "fields": ["name^4", "content_text"], "operator": operator,
    }}


queries = {
    "copy_to_and": {"match": {"search_text": {"query": "quarterly budget", "operator": "and"}}},
    "combined_and": combined("quarterly budget"),
    "best_fields_and": {"multi_match": {
        "query": "quarterly budget", "fields": ["name^4", "content_text"],
        "type": "best_fields", "operator": "and",
    }},
    "best_fields_or": {"multi_match": {
        "query": "quarterly budget", "fields": ["name^4", "content_text"],
        "type": "best_fields", "operator": "or",
    }},
    "cross_fields_and": {"multi_match": {
        "query": "quarterly budget", "fields": ["name^4", "content_text"],
        "type": "cross_fields", "operator": "and",
    }},
    "simple_and": simple("quarterly budget"),
    "simple_mixed_analyzers_and": simple("budget board", ["name.parts^4", "content_text"]),
    "simple_default_field_name_boost": simple("quarterly budget", ["name^4", "content_text"]),
    "combined_plus_name": {"bool": {
        "must": [combined("quarterly budget")],
        "should": [{"match": {"name": {"query": "quarterly budget", "operator": "and", "boost": 4}}}],
    }},
    "literal_phrase": simple('"quarterly budget"'),
    "phrase_and_exclusion": simple('"quarterly budget" -draft'),
    "required_with_explicit_or": simple("quarterly (budget | plans)"),
    "punctuation_name_icu": simple("budget", ["name"]),
    "punctuation_name_parts": simple("budget", ["name.parts"]),
    "hyphenated_identifier": simple("RFC-1234", ["name.parts"]),
    "stemmed_content": simple("employee request", ["content_text.en"]),
    "unstemmed_content": simple("employee request", ["content_text"]),
    "ordinary_partial_token": simple("budg", ["name.parts", "content_text"]),
    "filename_prefix": {"match": {"name.edge": {"query": "budg", "operator": "and"}}},
    "prefix_longer_than_max_gram": {"match": {"name.edge": "electroencephalographi"}},
    "full_long_word": {"match": {"name.edge": "electroencephalographically"}},
    "accent_folding": simple("reunion equipe", ["name.parts"]),
    "body_only_keyword": simple("approved", ["name.parts^4", "content_text"]),
    "pure_exclusion": simple("-draft"),
}
results = {
    "environment": {"version": info["version"], "documents": len(docs), "shards": 1},
    "queries": {name: search(query) for name, query in queries.items()},
    "analysis": {},
}
samples = [
    "Q4_budget-final_v2.pdf", "RFC-1234 OAuth2 PKCE", "CamelCaseReport.pdf",
    "Réunion Équipe", "東京 予算報告書", "C++ C# .NET", "employees requested increases",
]
for analyzer in ["lexical", "filename", "lexical_en", "filename_edge"]:
    results["analysis"][analyzer] = {}
    for sample in samples:
        response = request("POST", "/" + INDEX + "/_analyze", {
            "analyzer": analyzer, "text": sample
        })
        results["analysis"][analyzer][sample] = [token["token"] for token in response["tokens"]]


def hit_ids(test_name):
    return {hit["id"] for hit in results["queries"][test_name]["hits"]}


assert "split_fields" in hit_ids("simple_and")
assert "split_fields" in hit_ids("combined_and")
assert "split_fields" not in hit_ids("best_fields_and")
assert "split_filename_parts" in hit_ids("simple_mixed_analyzers_and")
assert "split_fields" not in hit_ids("literal_phrase")
assert "draft" not in hit_ids("phrase_and_exclusion")
assert "partial_query" in hit_ids("required_with_explicit_or")
assert "morphology" in hit_ids("stemmed_content")
assert "morphology" not in hit_ids("unstemmed_content")
assert results["queries"]["ordinary_partial_token"]["total"] == 0
assert "split_filename_parts" in hit_ids("filename_prefix")
assert "long_word" not in hit_ids("prefix_longer_than_max_gram")
assert "long_word" in hit_ids("full_long_word")

paired_ids = ["name_missing_body", "name_short_body", "name_long_body"]
results["paired_filename_scores"] = {}
for name in ["copy_to_and", "combined_and", "best_fields_and", "cross_fields_and", "simple_and", "combined_plus_name"]:
    scores = {hit["id"]: hit["score"] for hit in results["queries"][name]["hits"]}
    results["paired_filename_scores"][name] = {doc_id: scores[doc_id] for doc_id in paired_ids}

OUTPUT.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({
    "version": info["version"]["number"], "documents": len(docs),
    "checks": "passed", "results": str(OUTPUT),
    "paired_filename_scores": results["paired_filename_scores"],
}, indent=2))
