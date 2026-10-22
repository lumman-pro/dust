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
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[2]
DEFINITIONS = REPO_ROOT / "dfs/server/src/search/indices"
BASE = "http://127.0.0.1:19217"
INDEX = "codex-dfs-object-search-v1"
ROUTING_INDEX = "codex-dfs-object-routing-v1"
ROUTING_ALIAS = "codex-dfs-object-routing"
RESULTS = ROOT / "artifacts/validation-results.json"
COMPATIBILITY_TEXT = "\ufdfa" * 1100


def request(method, path, payload=None, ndjson=False):
    """@cc [owner:flvndvd,label:cli,label:error-handling] mapping-probe-http-errors
    HTTP failures at this standalone diagnostic boundary MAY raise RuntimeError
    with the response body. Callers MAY catch those typed failures to inspect
    Elasticsearch rejections in the diagnostic results.
    """
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


def with_routing(path, tenant_id):
    if tenant_id is None:
        return path
    return path + ("&" if "?" in path else "?") + urlencode({"routing": tenant_id})


def recreate(index, definition):
    assert index.startswith("codex-dfs-"), index
    try:
        request("DELETE", "/" + index)
    except RuntimeError as error:
        if "index_not_found_exception" not in str(error):
            raise
    request("PUT", "/" + index, definition)


def bulk(index, documents):
    lines = []
    for key, source in documents.items():
        metadata = {"_index": index, "_id": key}
        if "tenant_id" in source:
            metadata["routing"] = source["tenant_id"]
        lines.extend([json.dumps({"index": metadata}), json.dumps(source, ensure_ascii=False)])
    payload = "\n".join(lines) + "\n"
    result = request("POST", "/_bulk?refresh=true", payload, ndjson=True)
    assert not result["errors"], result


# Representations of the same logical field compete. Their scores are not added.
# These weights are illustrative, not relevance-calibrated production constants.
GROUPS = [
    (4.0, ["name", "name.parts"], ["stemmed.en.name", "stemmed.fr.name"]),
    (3.0, ["attributes.title"], ["stemmed.en.attributes.title", "stemmed.fr.attributes.title"]),
    (2.0, ["attributes.tags.text"], ["stemmed.en.attributes.tags", "stemmed.fr.attributes.tags"]),
    (1.5, ["attributes.description"], ["stemmed.en.attributes.description", "stemmed.fr.attributes.description"]),
    (1.0, ["content_text"], ["stemmed.en.content_text", "stemmed.fr.content_text"]),
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
    "mime": "mime_type", "ext": "extension",
    "tag": "attributes.tags", "owner": "attributes.owner_ids",
    "source": "attributes.source", "filename": "name.folded"
}


# These aliases exercise query-side grouping. The application will own the full registry.
TYPE_MIME_TYPES = {
    "pdf": ["application/pdf"],
    "spreadsheet": [
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
}


def compile_query(text, interactive=False, read_grant_ids=("grant-a",), scope_id=None):
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
    grants = list(read_grant_ids)
    read_filter = {"bool": {"should": [
        {"terms": {"object_id": grants}},
        {"terms": {"read_grant_ancestor_ids": grants}},
    ], "minimum_should_match": 1}} if grants else {"match_none": {}}
    filters = [
        {"term": {"tenant_id": "tenant-a"}},
        {"term": {"is_deleted": False}},
        read_filter,
    ]
    if scope_id is not None:
        filters.append({"bool": {"should": [
            {"term": {"ancestor_ids": scope_id}},
            {"term": {"object_id": scope_id}},
        ], "minimum_should_match": 1}})
    required, prohibited = [], []
    for token in terms:
        modifier = token["modifier"]
        value = token["text"]
        if modifier:
            if modifier in ("before", "after"):
                query = {"range": {"modified_at": {
                    "lt" if modifier == "before" else "gte": value + "T00:00:00Z"
                }}}
            elif modifier == "type":
                if value == "folder":
                    query = {"term": {"kind": "directory"}}
                else:
                    query = {"bool": {"filter": [
                        {"term": {"kind": "file"}},
                        {"terms": {"mime_type": TYPE_MIME_TYPES[value]}},
                    ]}}
            else:
                query = {"term": {MODIFIER_FIELDS[modifier]: value}}
            (prohibited if token["negative"] else filters).append(query)
        else:
            active = (interactive and token["end"] == len(text)
                      and not token["quoted"] and not token["negative"])
            query = text_clause(value, phrase=token["quoted"], active=active)
            (prohibited if token["negative"] else required).append(query)
    return {"bool": {"filter": filters, "must": required, "must_not": prohibited}}


def search(text, interactive=False, index=INDEX, query=None, routing="tenant-a", **extra):
    body = {"query": query or compile_query(text, interactive), "size": 100,
            "track_total_hits": True, "_source": ["name", "kind", "mime_type"], **extra}
    return request("POST", with_routing("/" + index + "/_search", routing), body)


def document(name, content=None, **extra):
    result = {"tenant_id": "tenant-a", "object_id": name,
              "is_deleted": False,
              "kind": "file", "name": name,
              "mime_type": "application/pdf", "extension": "pdf",
              "modified_at": "2026-10-01T00:00:00Z", **extra}
    if content is not None:
        result["content_text"] = content
    return result


info = request("GET", "/")
assert info["cluster_name"] == "codex-dfs-search-analysis", info
assert info["version"]["number"] == "8.16.0", info
settings = json.loads((DEFINITIONS / "objects_1.settings.local.json").read_text())
mappings = json.loads((DEFINITIONS / "objects_1.mappings.json").read_text())
recreate(INDEX, {"settings": settings, "mappings": mappings})

documents = {
    "name_prefix": document("Reports.pdf", "Budget approved."),
    "body_prefix": document("Minutes.txt", "Reports from the committee.", mime_type="text/plain"),
    "attribute_prefix": document("Reference", attributes={"title": "Reports from France"}),
    "name_components": document("Q4_Reports-final_v2.pdf", "Forecast approved."),
    "camel": document("AnnualReports.pdf", "Budget"),
    "acronym_joined": document("MySQL.pdf"),
    "acronym_spaced": document("my sql.pdf"),
    "unicode_expansion": document("Unicode extraction", COMPATIBILITY_TEXT,
                                  stemmed={"en": {"content_text": COMPATIBILITY_TEXT},
                                           "fr": {"content_text": COMPATIBILITY_TEXT}}),
    "compatibility_offsets": document("Compatibility.pdf", "Before ﬁnancial notes after."),
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
    "composite_wrong_type": document("Annual reports.pdf", "Budget notes.", mime_type="text/plain"),
    "composite_wrong_form": document("Annual report.pdf", "Budget notes."),
    "large_timestamp": document("Distant timestamp", mtime_ms=18446744073709551615, modified_at=None),
    "filter_pdf": document("Forecast.pdf", "Budget", attributes={"tags": ["Réseau sécurité"], "owner_ids": ["alice-id"], "source": "gdrive"}),
    "filter_false_extension": document("Forecast.pdf", "Budget", mime_type="text/plain"),
    "filter_pdf_not_text": document("Forecast", "Budget approval"),
    "filter_type_word": document("PDF budget.txt", "Budget", mime_type="text/plain"),
    "filter_other_owner": document("Forecast.pdf", "Budget", attributes={"owner_ids": ["bob-id"]}),
    "wrong_tenant": document("Reports.pdf", "Budget", tenant_id="tenant-b"),
    "no_permission": document("Reports.pdf", "Budget", ancestor_ids=["root", "grant-b"],
                              read_grant_ancestor_ids=["grant-b"]),
    "deleted": document("Reports.pdf", "Budget", is_deleted=True),
    "draft": document("Reports draft.pdf", "Budget"),
    "old": document("Older archive", "Budget", modified_at="2025-01-01T00:00:00Z"),
    "long_prefix": document("electroencephalographically.pdf"),
    "long_body_prefix": document("Medical notes", "electroencephalographically"),
    "cjk": document("東京 予算報告書"),
    "supplementary": document("𠮷report"),
    "exact_name": document("Literal-v1.2.PDF"),
    "nonexact_name": document("Literal v1 2 PDF"),
    "folder": document("Budget reports.pdf", kind="directory"),
    "unknown_mime_pdf": document("Unknown format.pdf", "Budget", mime_type=None),
    "spreadsheet_xls": document("Workbook.xls", mime_type="application/vnd.ms-excel", extension="xls"),
    "spreadsheet_xlsx": document("Workbook.xlsx",
                                mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                extension="xlsx"),
    "length_short": document("Quasar budget", "unrelated"),
    "length_long": document("Quasar budget", "unrelated " * 10000),
}
# Language assignments are explicit fixtures, not predictions from a detector. This
# harness tests the ES projection. Detector accuracy and confidence policy are separate.
FIELD_LANGUAGES = {
    "name_prefix": {"name": "en"},
    "name_components": {"name": "en"},
    "camel": {"name": "en"},
    "english_stem": {"name": "en", "content_text": "en"},
    "english_irregular_suffix": {"name": "en"},
    "english_running": {"name": "en"},
    "french_stem": {"name": "fr", "content_text": "fr"},
    "french_plural": {"name": "fr"},
    "french_elision": {"content_text": "fr"},
    "bilingual": {"name": "en", "content_text": "fr"},
    "metadata_stem": {"attributes.description": "en"},
    "metadata_french_stem": {"attributes.title": "fr"},
}
for object_id, fields in FIELD_LANGUAGES.items():
    for field, language in fields.items():
        source = documents[object_id]
        target = source.setdefault("stemmed", {}).setdefault(language, {})
        parts = field.split(".")
        for part in parts[:-1]:
            source = source[part]
            target = target.setdefault(part, {})
        target[parts[-1]] = source[parts[-1]]

documents.update({
    "english_only_news": document("English bulletin", "News from the newsroom.",
                                  stemmed={"en": {"content_text": "News from the newsroom."}}),
    "unknown_language": document("Journaux.pdf"),
    "report_annee": document("report année 2026"),
    "mixed_body": document("Bilingual bulletin", "Employees requested equipment. Les journaux des sociétés.",
                           stemmed={"en": {"content_text": ["Employees requested equipment."]},
                                    "fr": {"content_text": ["Les journaux des sociétés."]}}),
    "scope_x": document("Scope example", "Hierarchy permission fixture.",
                        ancestor_ids=["foo", "bar", "folder123"],
                        read_grant_ancestor_ids=["bar", "folder123"]),
    "scope_other_tenant": document("Scope other tenant", tenant_id="tenant-b",
                        ancestor_ids=["foo", "bar", "folder123"],
                        read_grant_ancestor_ids=["bar", "folder123"]),
    "self_read_deny": document("Isolated document", ancestor_ids=["foo", "bar", "folder123"],
                               read_grant_ancestor_ids=[]),
    "tenant_root": document("Tenant root", kind="directory", ancestor_ids=[],
                            read_grant_ancestor_ids=[]),
})
for i in range(80):
    documents[f"background_{i}"] = document(f"Reference {i}", "General reference material " * 30)
for object_id, source in documents.items():
    source["object_id"] = object_id
    source.setdefault("ancestor_ids", ["root", "grant-a"])
    source.setdefault("read_grant_ancestor_ids", source["ancestor_ids"])
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
      absent=["filter_false_extension", "filter_type_word", "unknown_mime_pdf", "folder"])
check("a type alias groups multiple MIME values", "type:spreadsheet",
      exact=["spreadsheet_xls", "spreadsheet_xlsx"])
check("exact MIME selects one member of a type category", "mime:application/vnd.ms-excel",
      exact=["spreadsheet_xls"])
check("extension matching remains available when MIME is unknown", 'filename:"Unknown format.pdf" ext:pdf',
      exact=["unknown_mime_pdf"])
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

# Whole filename components survive alongside CamelCase parts. Query casing must
# not invent boundaries or change which names match after the word is committed.
for label, template, interactive in [
    ("completed filename conjunction ignores casing", "{} budget", False),
    ("filename before active prefix ignores casing", "{} budg", True),
    ("quoted filename component ignores casing", '"{}"', False),
]:
    results = []
    for spelling in ["AnnualReports", "annualreports", "ANNUALREPORTS"]:
        query = template.format(spelling)
        hits = search(query, interactive)["hits"]["hits"]
        results.append({"query": query, "hits": {hit["_id"]: hit["_score"] for hit in hits}})
    checks.append({"label": label, "interactive": interactive, "results": results,
                   "passed": all(set(result["hits"]) == {"camel"}
                                 and result["hits"] == results[0]["hits"] for result in results)})
for spelling in ["MySQL", "mysql"]:
    check("query casing does not split an acronym into separate words", spelling,
          exact=["acronym_joined"])

# This source expanded beyond Lucene's byte limit when folding ran only after
# tokenization. Exercise every body representation, even artificial classifications.
for field in ["content_text", "stemmed.en.content_text", "stemmed.fr.content_text"]:
    query = {"bool": {"filter": [{"term": {"object_id": "unicode_expansion"}}],
                      "must": [{"match": {field: "الله"}}]}}
    hits = search("", query=query)["hits"]["hits"]
    checks.append({"label": "Unicode compatibility expansion remains searchable", "field": field,
                   "source_utf8_bytes": len(COMPATIBILITY_TEXT.encode()),
                   "hits": [hit["_id"] for hit in hits],
                   "passed": [hit["_id"] for hit in hits] == ["unicode_expansion"]})
unicode_source = request("GET", with_routing("/" + INDEX + "/_doc/unicode_expansion", "tenant-a"))["_source"]
checks.append({"label": "Unicode normalization preserves the original extracted source",
               "passed": unicode_source["content_text"] == COMPATIBILITY_TEXT})
compatibility_highlight = search("financial", highlight={"fields": {"content_text": {}}})
checks.append({"label": "compatibility normalization keeps highlight offsets in original text",
               "passed": any(hit["_id"] == "compatibility_offsets"
                             and hit.get("highlight", {}).get("content_text")
                             == ["Before <em>ﬁnancial</em> notes after."]
                             for hit in compatibility_highlight["hits"]["hits"])})


check("incomplete French word matches without language detection", "report an", interactive=True, present=["report_annee"])
check("quoted incomplete French word is not a prefix", '"report an"', absent=["report_annee"])
check("unclassified text keeps prefix recall", "journ", interactive=True, present=["unknown_language"])
check("unclassified text is not automatically stemmed", "journal", absent=["unknown_language"])
check("English text does not acquire French stems", "new", absent=["english_only_news"])
check("mixed body can satisfy English and French stems in separate classified spans",
      "employee journal", present=["mixed_body"])
check("quotes can span language segment boundaries in the neutral full text",
      '"equipment Les journaux"', present=["mixed_body"])
for language, expected in [("en", True), ("fr", False)]:
    query = {"bool": {"filter": [{"term": {"object_id": "english_only_news"}},
                                  {"exists": {"field": f"stemmed.{language}.content_text"}}]}}
    found = search("", query=query)["hits"]["total"]["value"] > 0
    checks.append({"label": f"English fixture only populates the requested {language} representation",
                   "passed": found == expected})

# The caller supplies current direct READ-grant object IDs. This tests ES membership
# and scope filters, not a grant resolver, permission recheck, or indexing workflow.
for label, grants, scope, expected in [
    ("a grant below DENY restores access under an ancestor scope", ["folder123"], "foo", ["scope_x"]),
    ("a grant above DENY is excluded", ["foo"], "foo", []),
    ("ALLOW on the DENY node can restore read", ["bar"], "foo", ["scope_x"]),
    ("an ALLOW on the object itself can restore read", ["scope_x"], "foo", ["scope_x"]),
    ("read grant ancestors accept any matching grant ID", ["unrelated", "folder123"], "foo", ["scope_x"]),
    ("a different physical subtree excludes an otherwise readable object", ["folder123"], "elsewhere", []),
    ("inclusive scope explicitly includes the object itself", ["folder123"], "scope_x", ["scope_x"]),
    ("selecting the object itself does not bypass its read-DENY boundary", ["foo"], "scope_x", []),
    ("adding an ALLOW changes the query without reindexing", ["folder123"], "foo", ["scope_x"]),
    ("revoking the only ALLOW changes the query without reindexing", [], "foo", []),
    ("read-DENY on self excludes every ancestor grant", ["folder123"], "self_read_deny", []),
    ("direct READ grant survives an empty ancestor list after read-DENY", ["self_read_deny"], "foo", ["self_read_deny"]),
    ("direct READ grant can find a root with no ancestors", ["tenant_root"], "tenant_root", ["tenant_root"]),
    ("a root with no ancestors still requires a READ grant", [], "tenant_root", []),
]:
    query = compile_query("", read_grant_ids=grants, scope_id=scope)
    hits = search("", query=query)["hits"]["hits"]
    ids = [hit["_id"] for hit in hits]
    checks.append({"label": label, "grant_ids": grants, "scope_id": scope,
                   "expected_exact": expected, "hits": ids, "passed": set(ids) == set(expected)})

# Strict ancestry excludes self even when that object is readable and included by
# the inclusive scope query above.
strict_scope_query = {"bool": {"filter": [
    compile_query("", read_grant_ids=["folder123"]),
    {"term": {"ancestor_ids": "scope_x"}},
]}}
strict_scope_hits = search("", query=strict_scope_query)["hits"]["hits"]
checks.append({"label": "strict ancestry excludes the scoped object itself",
               "query": strict_scope_query, "hits": [hit["_id"] for hit in strict_scope_hits],
               "passed": not strict_scope_hits})

analyzers = {}
for value in ["Reports.pdf", "Q4_Reports-final_v2.pdf", "AnnualReports.pdf", "archive.tar.gz",
              ".gitignore", "v1.2", "東京 予算報告書", "C++ C#", "L’avion des sociétés",
              "ponies running reports", "journaux chevaux", "𠮷report"]:
    analyzers[value] = {}
    for analyzer in ["dfs_text", "dfs_text_en", "dfs_text_fr", "dfs_filename", "dfs_filename_parts",
                     "dfs_filename_en", "dfs_filename_parts_en", "dfs_filename_fr", "dfs_filename_parts_fr"]:
        analyzed = request("POST", "/" + INDEX + "/_analyze", {"text": value, "analyzer": analyzer})
        analyzers[value][analyzer] = [{key: token[key] for key in ["token", "position", "start_offset", "end_offset"]}
                                      for token in analyzed["tokens"]]


for value in ["L'AVION", "L’AVION", "l'avion", "l’avion"]:
    analyzed = request("POST", "/" + INDEX + "/_analyze", {"text": value, "analyzer": "dfs_text_fr"})
    tokens = [token["token"] for token in analyzed["tokens"]]
    checks.append({"label": "built-in French elision handles uppercase and supported apostrophes",
                   "input": value, "tokens": tokens, "passed": tokens == ["avion"]})

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

# Classified segments have their own offsets. Highlight them in their own fields,
# rather than merging segment offsets into the full neutral content_text.
highlight = search("journal", highlight={"fields": {
    "name": {"matched_fields": ["name.parts"]},
    "stemmed.en.name": {}, "stemmed.fr.name": {},
    "content_text": {}, "stemmed.en.content_text": {}, "stemmed.fr.content_text": {}
}})
prefix_highlight = search("repo", interactive=True, highlight={"fields": {
    "name": {"matched_fields": ["name.parts", "name._index_prefix", "name.parts._index_prefix"]},
    "content_text": {"matched_fields": ["content_text._index_prefix"]}
}})
checks.append({"label": "stemmed content hit highlights its own classified text", "passed": any(
    hit["_id"] == "bilingual" and "stemmed.fr.content_text" in hit.get("highlight", {})
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
large_timestamp = request("GET", with_routing("/" + INDEX + "/_doc/large_timestamp", "tenant-a"))
checks.append({"label": "a non-date u64 timestamp does not prevent indexing the object",
               "passed": large_timestamp["_source"]["mtime_ms"] == 18446744073709551615
               and large_timestamp["_source"]["modified_at"] is None})

# Three primaries make routing observable. The text corpus remains on one primary
# so its existing relevance probes keep the same statistics.
routing_settings = copy.deepcopy(settings)
routing_settings["number_of_shards"] = 3
recreate(ROUTING_INDEX, {"settings": routing_settings, "mappings": mappings,
                         "aliases": {ROUTING_ALIAS: {"is_write_index": True}}})
routing_tenants = ["tenant-a", "tenant-b", "tenant-c", "tenant-d"]
routing_documents = {
    tenant + ":object": document("Routed report", object_id="object", tenant_id=tenant)
    for tenant in routing_tenants
}
bulk(ROUTING_ALIAS, routing_documents)

tenant_shards = {}
for tenant in routing_tenants:
    shard_groups = request("GET", with_routing("/" + ROUTING_ALIAS + "/_search_shards", tenant))["shards"]
    tenant_shards[tenant] = [group[0]["shard"] for group in shard_groups]
checks.append({"label": "tenant routing targets one of three primary shards",
               "tenant_shards": tenant_shards,
               "passed": all(len(shards) == 1 for shards in tenant_shards.values())})

# Four tenants on three primaries guarantee a collision. Routing cannot replace
# the tenant filter even when every write uses the correct tenant ID.
colliding_tenants = next(
    [tenant for tenant, shards in tenant_shards.items() if shards == selected]
    for selected in tenant_shards.values()
    if sum(shards == selected for shards in tenant_shards.values()) > 1
)
tenant = colliding_tenants[0]
unfiltered = search("", index=ROUTING_ALIAS, routing=tenant, query={"match_all": {}})
filtered = search("", index=ROUTING_ALIAS, routing=tenant, query={"term": {"tenant_id": tenant}})
unfiltered_ids = {hit["_id"] for hit in unfiltered["hits"]["hits"]}
filtered_ids = {hit["_id"] for hit in filtered["hits"]["hits"]}
checks.append({"label": "tenant filter isolates tenants sharing a routed shard", "routing": tenant,
               "without_tenant_filter": sorted(unfiltered_ids), "with_tenant_filter": sorted(filtered_ids),
               "passed": unfiltered_ids == {value + ":object" for value in colliding_tenants}
               and filtered_ids == {tenant + ":object"}})

object_path = "/" + ROUTING_ALIAS + "/_doc/" + tenant + ":object"
update_path = "/" + ROUTING_ALIAS + "/_update/" + tenant + ":object"
for operation, method, path, payload in [
    ("index", "PUT", "/" + ROUTING_ALIAS + "/_doc/missing-route", document("Missing route")),
    ("get", "GET", object_path, None),
    ("update", "POST", update_path, {"doc": {"name": "Missing route"}}),
    ("delete", "DELETE", object_path, None),
]:
    error_type = None
    try:
        request(method, path, payload)
    except RuntimeError as error:
        error_type = json.loads(str(error))["error"]["type"]
    checks.append({"label": "document operation rejects missing routing", "operation": operation,
                   "error_type": error_type, "passed": error_type == "routing_missing_exception"})

missing_routing_bulk = request("POST", "/_bulk", "\n".join([
    json.dumps({"index": {"_index": ROUTING_ALIAS, "_id": "missing-bulk-route"}}),
    json.dumps(document("Missing bulk route")), "",
]), ndjson=True)
bulk_error = missing_routing_bulk["items"][0]["index"].get("error", {}).get("type")
checks.append({"label": "bulk items reject missing routing", "error_type": bulk_error,
               "passed": missing_routing_bulk["errors"] and bulk_error == "routing_missing_exception"})

before = request("GET", with_routing(object_path, tenant))
updated = request("POST", with_routing(update_path, tenant), {"doc": {"name": "Updated routed report"}})
after = request("GET", with_routing(object_path, tenant))
deleted = request("DELETE", with_routing(object_path, tenant))
checks.append({"label": "routed bulk write get update and delete use the same tenant ID", "routing": tenant,
               "passed": before["_routing"] == tenant and before["_source"]["tenant_id"] == tenant
               and before["_source"]["name"] == "Routed report" and updated["result"] == "updated"
               and after["_source"]["name"] == "Updated routed report" and deleted["result"] == "deleted"})

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
        hits = search("", index=index, query=query, routing=None)["hits"]
        searches[fragment] = {"total": hits["total"]["value"], "long_found": any(h["_id"] == "long" for h in hits["hits"])}
    comparison[variant] = {"usage": usage[index], "queries": searches}

output = {"elasticsearch": info["version"], "document_count": len(documents),
          "mapping_source": "dfs/server/src/search/indices/objects_1.mappings.json",
          "settings_source": "dfs/server/src/search/indices/objects_1.settings.local.json",
          "language_assignments": "explicit fixtures, not detector predictions",
          "routing_validation": {"shards": 3, "document_count": len(routing_documents),
                                 "tenant_shards": tenant_shards},
          "checks": checks, "analyzers": analyzers, "prefix_rewrites": rewrites,
          "expensive_query_gate": prefix_gate, "stem_highlights": highlight["hits"]["hits"],
          "prefix_highlights": prefix_highlight["hits"]["hits"],
          "future_ranking_feature_values": feature_values["hits"]["hits"],
          "prefix_mechanism_comparison": comparison,
          "compiled_example": {"input": 'type:pdf "annual reports" budg', "routing": "tenant-a",
                               "query": compile_query('type:pdf "annual reports" budg', True)}}
RESULTS.parent.mkdir(parents=True, exist_ok=True)
RESULTS.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
failed = [check for check in checks if not check["passed"]]
print(json.dumps({"documents": len(documents), "checks": len(checks), "failed": failed,
                  "results": str(RESULTS)}, ensure_ascii=False, indent=2))
if failed:
    raise SystemExit(1)
