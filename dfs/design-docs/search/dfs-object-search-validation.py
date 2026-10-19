"""Reproduce the proposed DFS mapping's behavior on a disposable ES 8.16 + ICU.

This is an investigation harness, not an application query parser or a load test.
Only the named diagnostic cluster and indices on localhost:19217 are mutated.
The final JSON mapping/settings files, rather than a second embedded mapping, are used.
"""

import copy
import json
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).parent
BASE = "http://127.0.0.1:19217"
INDEX = "codex-dfs-object-search-v1"
RESULTS = ROOT / "dfs-object-search-validation-results.json"


def request(method, path, payload=None, ndjson=False):
    body = None if payload is None else (
        payload.encode() if ndjson else json.dumps(payload).encode()
    )
    req = Request(BASE + path, body, {
        "Content-Type": "application/x-ndjson" if ndjson else "application/json"
    }, method=method)
    try:
        with urlopen(req, timeout=60) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


def recreate(index, definition):
    assert index.startswith("codex-dfs-"), index
    try:
        request("DELETE", "/" + index)
    except RuntimeError as error:
        if "index_not_found_exception" not in str(error):
            raise
    request("PUT", "/" + index, definition)


def bulk(index, documents):
    payload = "".join(
        json.dumps({"index": {"_index": index, "_id": key}}) + "\n"
        + json.dumps(document, ensure_ascii=False) + "\n"
        for key, document in documents.items()
    )
    result = request("POST", "/_bulk?refresh=true", payload, ndjson=True)
    assert not result["errors"], result


# Representations of the same logical field compete; their scores are not added.
# These weights are illustrative, not relevance-calibrated production constants.
GROUPS = [
    (4.0, ["name", "name.parts"], ["name.en", "name.fr"]),
    (3.0, ["attributes.title"], ["attributes.title.en", "attributes.title.fr"]),
    (2.0, ["attributes.tags.text"], ["attributes.tags.en", "attributes.tags.fr"]),
    (1.5, ["attributes.description"], ["attributes.description.en", "attributes.description.fr"]),
    (1.0, ["content_text"], ["content_text.en", "content_text.fr"]),
]


def text_clause(text, phrase=False, active=False):
    logical_fields = []
    for weight, plain_fields, stemmed_fields in GROUPS:
        variants = []
        for field in plain_fields:
            clause = {"query": text, "boost": weight}
            clause["slop" if phrase else "operator"] = 0 if phrase else "and"
            variants.append({"match_phrase" if phrase else "match": {field: clause}})
        if not phrase:
            variants.extend({"match": {field: {
                "query": text, "operator": "and", "boost": weight * 0.65
            }}} for field in stemmed_fields)
        if active and not phrase:
            variants.extend({"constant_score": {
                "filter": {"match_bool_prefix": {field: {
                    "query": text, "operator": "and"
                }}}, "boost": weight * 0.25
            }} for field in plain_fields)
        logical_fields.append({"dis_max": {"queries": variants, "tie_breaker": 0.0}})
    return {"dis_max": {"queries": logical_fields, "tie_breaker": 0.1}}


# A bounded fixture parser for complete phrases and the listed modifiers. Production
# needs an actual grammar/AST, cursor-aware incomplete input, escapes, and limits.
LEXEME = re.compile(
    r'\s*(?P<negative>-)?(?:(?P<modifier>type|mime|ext|tag|owner|source|before|after|filename):)?'
    r'(?:"(?P<phrase>(?:\\.|[^"\\])*)"|(?P<word>[^\s"]+))'
)
MODIFIER_FIELDS = {
    "type": "file_type", "mime": "mime_type", "ext": "extension",
    "tag": "attributes.tags", "owner": "attributes.owner_ids",
    "source": "attributes.source", "filename": "name.folded"
}


def compile_query(text, interactive=False):
    terms = []
    end = 0
    for match in LEXEME.finditer(text):
        assert not text[end:match.start()].strip(), text
        quoted = match.group("phrase") is not None
        raw = match.group("phrase") if quoted else match.group("word")
        value = json.loads('"' + raw + '"') if quoted else raw
        terms.append({"text": value, "quoted": quoted,
                      "negative": bool(match.group("negative")),
                      "modifier": match.group("modifier"), "end": match.end()})
        end = match.end()
    assert not text[end:].strip(), text
    filters = [
        {"term": {"tenant_id": "tenant-a"}},
        {"term": {"is_deleted": False}},
        {"terms": {"read_inheritance_ids": ["grant-a"]}},
    ]
    required, prohibited = [], []
    for token in terms:
        modifier = token["modifier"]
        value = token["text"]
        if modifier:
            if modifier in ("before", "after"):
                query = {"range": {"modified_at": {
                    "lt" if modifier == "before" else "gte": value + "T00:00:00Z"
                }}}
            elif modifier == "type" and value == "folder":
                query = {"term": {"kind": "directory"}}
            else:
                query = {"term": {MODIFIER_FIELDS[modifier]: value}}
            (prohibited if token["negative"] else filters).append(query)
        else:
            active = (interactive and token["end"] == len(text)
                      and not token["quoted"] and not token["negative"])
            query = text_clause(value, phrase=token["quoted"], active=active)
            (prohibited if token["negative"] else required).append(query)
    return {"bool": {"filter": filters, "must": required, "must_not": prohibited}}


def search(text, interactive=False, index=INDEX, query=None, **extra):
    body = {"query": query or compile_query(text, interactive), "size": 100,
            "track_total_hits": True, "_source": ["name", "file_type"], **extra}
    return request("POST", "/" + index + "/_search", body)


def document(name, content=None, **extra):
    result = {"tenant_id": "tenant-a", "object_id": name,
              "read_inheritance_ids": ["grant-a"], "is_deleted": False,
              "kind": "file", "name": name, "file_type": "pdf",
              "mime_type": "application/pdf", "extension": "pdf",
              "modified_at": "2026-10-01T00:00:00Z", **extra}
    if content is not None:
        result["content_text"] = content
    return result


info = request("GET", "/")
assert info["cluster_name"] == "codex-dfs-search-analysis", info
assert info["version"]["number"] == "8.16.0", info
settings = json.loads((ROOT / "dfs.objects_1.settings.proposed.json").read_text())
settings.pop("routing.allocation.require.workload")
settings.update({"number_of_shards": 1, "number_of_replicas": 0})
mappings = json.loads((ROOT / "dfs.objects_1.mappings.proposed.json").read_text())
recreate(INDEX, {"settings": settings, "mappings": mappings})

documents = {
    "name_prefix": document("Reports.pdf", "Budget approved."),
    "body_prefix": document("Minutes.txt", "Reports from the committee.", file_type="txt", mime_type="text/plain"),
    "attribute_prefix": document("Reference", attributes={"title": "Reports from France"}),
    "name_components": document("Q4_Reports-final_v2.pdf", "Forecast approved."),
    "camel": document("AnnualReports.pdf"),
    "singular": document("Report.pdf"),
    "cross_fields": document("A.pdf", "B"),
    "only_a": document("A"),
    "only_b": document("B"),
    "cross_prefix": document("Budget.pdf", "Reports for the board."),
    "cross_metadata": document("Budget", attributes={"description": "Reports for the board"}),
    "reverse_cross_prefix": document("Reports.pdf", "Budget notes"),
    "exact_phrase": document("Annual reports.pdf"),
    "exact_body_phrase": document("Board notes", "The annual reports were delivered."),
    "inexact_inflection": document("Annual report.pdf"),
    "inexact_order": document("Reports annual.pdf"),
    "inexact_gap": document("Annual revised reports.pdf"),
    "inexact_split": document("Annual", "Reports"),
    "inexact_value_boundary": document("Notes", attributes={"description": ["annual", "reports"]}),
    "stop_words": document("State of the art.pdf"),
    "missing_stop_words": document("State art.pdf"),
    "english_stem": document("Employees.pdf", "Requested better equipment."),
    "english_irregular_suffix": document("Ponies.txt"),
    "english_running": document("Running.pdf"),
    "french_stem": document("Journaux.pdf", "Les sociétés investissent."),
    "french_plural": document("Chevaux.pdf"),
    "french_elision": document("French notes", "L’avion est prêt."),
    "french_no_article": document("French record", "Avion est prêt."),
    "english_apostrophe": document("Biography", "O’Reilly describes John's work. Don't panic."),
    "bilingual": document("Reports.pdf", "Les journaux des sociétés."),
    "accent": document("Réunion Équipe.pdf", "Présentation"),
    "decomposed_accent": document("Cafe\u0301.pdf", attributes={"tags": ["Re\u0301seau"]}),
    "metadata_stem": document("Actions", attributes={"description": "Employees requested equipment"}),
    "metadata_french_stem": document("Documents", attributes={"title": "Les journaux des sociétés"}),
    "tag_prefix": document("Tagged item", attributes={"tags": ["Reports"]}),
    "composite": document("Annual reports.pdf", "Budget notes."),
    "composite_wrong_type": document("Annual reports.pdf", "Budget notes.", file_type="txt", mime_type="text/plain"),
    "composite_wrong_form": document("Annual report.pdf", "Budget notes."),
    "large_timestamp": document("Distant timestamp", mtime_ms=18446744073709551615, modified_at=None),
    "filter_pdf": document("Forecast.pdf", "Budget", attributes={"tags": ["Réseau sécurité"], "owner_ids": ["alice-id"], "source": "gdrive"}),
    "filter_false_extension": document("Forecast.pdf", "Budget", file_type="txt", mime_type="text/plain"),
    "filter_pdf_not_text": document("Forecast", "Budget approval"),
    "filter_type_word": document("PDF budget.txt", "Budget", file_type="txt", mime_type="text/plain"),
    "filter_other_owner": document("Forecast.pdf", "Budget", attributes={"owner_ids": ["bob-id"]}),
    "wrong_tenant": document("Reports.pdf", "Budget", tenant_id="tenant-b"),
    "no_permission": document("Reports.pdf", "Budget", read_inheritance_ids=["grant-b"]),
    "deleted": document("Reports.pdf", "Budget", is_deleted=True),
    "draft": document("Reports draft.pdf", "Budget"),
    "old": document("Older archive", "Budget", modified_at="2025-01-01T00:00:00Z"),
    "long_prefix": document("electroencephalographically.pdf"),
    "long_body_prefix": document("Medical notes", "electroencephalographically"),
    "cjk": document("東京 予算報告書"),
    "supplementary": document("𠮷report"),
    "exact_name": document("Literal-v1.2.PDF"),
    "nonexact_name": document("Literal v1 2 PDF"),
    "folder": document("Reports.pdf", kind="directory", file_type="folder"),
    "length_short": document("Quasar budget", "unrelated"),
    "length_long": document("Quasar budget", "unrelated " * 10000),
}
for i in range(80):
    documents[f"background_{i}"] = document(f"Reference {i}", "General reference material " * 30)
bulk(INDEX, documents)

checks = []


def check(label, text, present=(), absent=(), interactive=False, exact=None):
    result = search(text, interactive)
    ids = [hit["_id"] for hit in result["hits"]["hits"]]
    ok = set(present).issubset(ids) and not set(absent).intersection(ids)
    if exact is not None:
        ok = ok and set(ids) == set(exact)
    checks.append({"label": label, "input": text, "interactive": interactive,
                   "expected_present": list(present), "expected_absent": list(absent),
                   "expected_exact": exact, "hits": ids, "passed": ok})


check("prefix matches filename, content, and selected xattr", "repo", interactive=True,
      present=["name_prefix", "body_prefix", "attribute_prefix", "name_components", "camel", "tag_prefix"],
      absent=["wrong_tenant", "no_permission", "deleted", "only_a"])
check("completed fragment is not silently a prefix", "repo", exact=[])
check("quoted word has no prefix or stemming", '"report"', present=["singular"],
      absent=["name_prefix", "name_components", "english_running"])
check("quoted plural remains plural", '"reports"', present=["name_prefix"], absent=["singular"])
check("quoted phrase is adjacent, ordered, and unstemmed", '"annual reports"',
      present=["exact_phrase", "exact_body_phrase", "camel"],
      absent=["inexact_inflection", "inexact_order", "inexact_gap", "inexact_split", "inexact_value_boundary"])
check("quote stays exact during autocomplete", '"annual reports"', interactive=True,
      present=["exact_phrase"], absent=["inexact_inflection", "inexact_gap", "inexact_split"])
check("retain stop words in exact phrase", '"state of the art"',
      present=["stop_words"], absent=["missing_stop_words"])
check("required terms span filename and body", "A B", present=["cross_fields"], absent=["only_a", "only_b"])
check("cross-field final prefix", "budget repo", interactive=True,
      present=["cross_prefix", "reverse_cross_prefix", "cross_metadata"], absent=["only_a"])
check("cross-field and metadata stemming", "employee request", present=["english_stem", "metadata_stem"])
check("filename stemming after component splitting", "report", present=["name_prefix", "name_components", "camel"])
check("English pony/ponies", "pony", present=["english_irregular_suffix"])
check("English run/running", "run", present=["english_running"])
check("French journal/journaux and société/sociétés", "journal société", present=["french_stem", "bilingual", "metadata_french_stem"])
check("French cheval/chevaux", "cheval", present=["french_plural"])
check("French elision", "avion", present=["french_elision"])
check("French prefix after apostrophe", "avio", interactive=True, present=["french_elision", "french_no_article"])
check("quoted French article remains required", '"l’avion est"', present=["french_elision"], absent=["french_no_article"])
check("English prefix after apostrophe", "reill", interactive=True, present=["english_apostrophe"])
check("quoted apostrophe normalization", '"O\'Reilly describes"', present=["english_apostrophe"])
check("composed and decomposed keyword normalization", 'filename:"CAFÉ.pdf"', exact=["decomposed_accent"])
check("composed and decomposed selected tag", 'tag:"réseau"', exact=["decomposed_accent"])
check("mixed-language cross-field conjunction", "report société", present=["bilingual"])
check("accent and case normalization", "REUNION equipe", present=["accent"])
check("quoted accented name", '"reunion equipe"', present=["accent"])
check("type is a hard filter, not lexical text", "budget type:pdf", present=["filter_pdf", "filter_pdf_not_text"],
      absent=["filter_false_extension", "filter_type_word"])
check("modifier at cursor does not prefix an earlier word", "budget repo type:pdf", interactive=True, exact=[])
check("filter and prefix together at cursor", "type:pdf budget repo", interactive=True,
      present=["cross_prefix", "reverse_cross_prefix"], absent=["filter_false_extension", "filter_type_word"])
check("quoted phrase plus type filter plus cross-field prefix", 'type:pdf "annual reports" budg', interactive=True,
      present=["composite"], absent=["composite_wrong_type", "composite_wrong_form", "inexact_split"])
check("normalized exact selected xattr", 'tag:"reseau securite"', exact=["filter_pdf"])
check("compound exact xattr filters", "owner:alice-id source:gdrive type:pdf", exact=["filter_pdf"])
check("date is typed range", "budget before:2026-01-01", exact=["old"])
check("negative query and active prefix", "-draft repo", interactive=True,
      present=["name_prefix"], absent=["draft", "wrong_tenant", "deleted", "no_permission"])
check("long filename prefix exceeds configured acceleration", "electroencephalograph", interactive=True, present=["long_prefix"])
check("long content prefix exceeds configured acceleration", "electroencephalographic", interactive=True, present=["long_body_prefix"])
check("ordinary CJK segmentation retained", "報告書", present=["cjk"])
check("supplementary character prefix", "𠮷", interactive=True, present=["supplementary"])
check("whole filename equality preserves punctuation", 'filename:"literal-v1.2.pdf"', exact=["exact_name"])
check("directory kind modifier", "type:folder", exact=["folder"])
check("literal PDF suffix remains searchable", '"pdf"', present=["name_prefix", "name_components"])
check("trailing whitespace commits the active word", "repo ", interactive=True, exact=[])

analyzers = {}
for value in ["Reports.pdf", "Q4_Reports-final_v2.pdf", "AnnualReports.pdf", "archive.tar.gz",
              ".gitignore", "v1.2", "東京 予算報告書", "C++ C#", "L’avion des sociétés",
              "ponies running reports", "journaux chevaux", "𠮷report"]:
    analyzers[value] = {}
    for analyzer in ["dfs_text", "dfs_filename", "dfs_filename_en", "dfs_filename_fr", "dfs_text_en", "dfs_text_fr"]:
        analyzed = request("POST", "/" + INDEX + "/_analyze", {"text": value, "analyzer": analyzer})
        analyzers[value][analyzer] = [{key: token[key] for key in ["token", "position", "start_offset", "end_offset"]}
                                      for token in analyzed["tokens"]]

rewrites = {}
for field, text in [("name.parts", "repo"), ("content_text", "repo"),
                    ("content_text", "electroencephalographic"), ("name.parts", "𠮷")]:
    rewrites[field + ":" + text] = request("POST", "/" + INDEX + "/_validate/query?rewrite=true", {
        "query": {"match_bool_prefix": {field: {"query": text, "operator": "and"}}}
    })

length_hits = search("quasar")["hits"]["hits"]
length_scores = {hit["_id"]: hit["_score"] for hit in length_hits if hit["_id"].startswith("length_")}
checks.append({"label": "unrelated body length does not change filename score",
               "scores": length_scores, "passed": length_scores["length_short"] == length_scores["length_long"]})

highlight = search("journal", highlight={"fields": {
    "name": {"matched_fields": ["name.parts", "name.en", "name.fr"]},
    "content_text": {"matched_fields": ["content_text.en", "content_text.fr"]}
}})
prefix_highlight = search("repo", interactive=True, highlight={"fields": {
    "name": {"matched_fields": ["name.parts", "name._index_prefix", "name.parts._index_prefix"]},
    "content_text": {"matched_fields": ["content_text._index_prefix"]}
}})
checks.append({"label": "stemmed content hit highlights original text", "passed": any(
    hit["_id"] == "bilingual" and "content_text" in hit.get("highlight", {})
    for hit in highlight["hits"]["hits"]
)})
checks.append({"label": "prefix hit highlights filename", "passed": any(
    hit["_id"] == "name_prefix" and "name" in hit.get("highlight", {})
    for hit in prefix_highlight["hits"]["hits"]
)})

feature_values = search("quasar", fields=["modified_at", "name.token_count", "content_text.token_count"])
checks.append({"label": "query-time ranking features are available without source parsing",
               "passed": all("modified_at" in hit["fields"] and "name.token_count" in hit["fields"]
                             and "content_text.token_count" in hit["fields"] for hit in feature_values["hits"]["hits"])})
large_timestamp = request("GET", "/" + INDEX + "/_doc/large_timestamp")
checks.append({"label": "a non-date u64 timestamp does not prevent indexing the object",
               "passed": large_timestamp["_source"]["mtime_ms"] == 18446744073709551615
               and large_timestamp["_source"]["modified_at"] is None})

prefix_gate = {}
try:
    request("PUT", "/_cluster/settings", {"transient": {"search.allow_expensive_queries": False}})
    for fragment in ["repo", "electroencephalographic"]:
        try:
            result = search(fragment, interactive=True)
            prefix_gate[fragment] = {"allowed": True, "hits": [hit["_id"] for hit in result["hits"]["hits"]]}
        except RuntimeError as error:
            prefix_gate[fragment] = {"allowed": False, "error": str(error)}
finally:
    request("PUT", "/_cluster/settings", {"transient": {"search.allow_expensive_queries": None}})

# Mechanism comparison: same source and unstemmed base analyzer, not a capacity forecast.
comparison = {}
for variant in ["plain", "prefixes", "bilingual_prefixes", "edge", "search_as_you_type"]:
    index = "codex-dfs-prefix-" + variant
    variant_settings = copy.deepcopy(settings)
    text_map = {"type": "text", "analyzer": "dfs_text"}
    if variant in ("prefixes", "bilingual_prefixes"):
        text_map["index_prefixes"] = {"min_chars": 1, "max_chars": 5}
        if variant == "bilingual_prefixes":
            text_map["fields"] = {"en": {"type": "text", "analyzer": "dfs_text_en"},
                                  "fr": {"type": "text", "analyzer": "dfs_text_fr"}}
    elif variant == "edge":
        variant_settings["analysis"]["filter"]["probe_edge"] = {
            "type": "edge_ngram", "min_gram": 1, "max_gram": 20, "preserve_original": True}
        variant_settings["analysis"]["analyzer"]["probe_edge"] = {
            "type": "custom", "tokenizer": "icu_tokenizer", "filter": ["icu_folding", "probe_edge"]}
        text_map["fields"] = {"prefix": {"type": "text", "analyzer": "probe_edge", "search_analyzer": "dfs_text"}}
    elif variant == "search_as_you_type":
        text_map = {"type": "search_as_you_type", "analyzer": "dfs_text", "max_shingle_size": 3}
    recreate(index, {"settings": variant_settings, "mappings": {"properties": {"text": text_map}}})
    corpus = {str(i): {"text": ("Annual reports describe the quarterly budgets. Les journaux présentent les sociétés. "
                                + " ".join(f"document{i}paragraph{j}" for j in range(25)) + " ") * 3}
              for i in range(200)}
    corpus["long"] = {"text": "electroencephalographically"}
    bulk(index, corpus)
    request("POST", "/" + index + "/_flush")
    usage = request("POST", "/" + index + "/_disk_usage?run_expensive_tasks=true")
    searches = {}
    for fragment in ["repo", "electroencephalographic"]:
        query = ({"match": {"text.prefix": fragment}} if variant == "edge"
                 else {"match_bool_prefix": {"text": fragment}})
        hits = search("", index=index, query=query)["hits"]
        searches[fragment] = {"total": hits["total"]["value"], "long_found": any(h["_id"] == "long" for h in hits["hits"])}
    comparison[variant] = {"usage": usage[index], "queries": searches}

output = {"elasticsearch": info["version"], "document_count": len(documents),
          "mapping_source": "dfs.objects_1.mappings.proposed.json",
          "settings_source": "dfs.objects_1.settings.proposed.json",
          "local_settings_changes": {"removed_allocation_require": True, "shards": 1, "replicas": 0},
          "checks": checks, "analyzers": analyzers, "prefix_rewrites": rewrites,
          "expensive_query_gate": prefix_gate, "stem_highlights": highlight["hits"]["hits"],
          "prefix_highlights": prefix_highlight["hits"]["hits"],
          "future_ranking_feature_values": feature_values["hits"]["hits"],
          "prefix_mechanism_comparison": comparison,
          "compiled_example": {"input": 'type:pdf "annual reports" budg',
                               "query": compile_query('type:pdf "annual reports" budg', True)}}
RESULTS.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
failed = [check for check in checks if not check["passed"]]
print(json.dumps({"documents": len(documents), "checks": len(checks), "failed": failed,
                  "results": str(RESULTS)}, ensure_ascii=False, indent=2))
if failed:
    raise SystemExit(1)
