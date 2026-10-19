# Full keyword search for DFS objects

**Revision notice:** use the [tested bilingual search design](dfs-object-search-revised-design.md)
for the current mapping and query recommendation. This note preserves earlier experiments and the
UAX/filename analysis; its optional-prefix and KStem suggestions are no longer the proposed baseline.

Design date: 2026-10-19. Target: Elasticsearch 8.16.0 with `analysis-icu`, an alias named
`dfs.objects`, and one search result per original DFS object. The desired experience is searching
files by their name, their contents, and explicit metadata filters. Query semantics are designed
here independently of the previous Search API and the PR's design document.

**Recommendation: independently scored lexical fields, a term-centric keyword query, and explicit
phrase/Boolean semantics.** Use `simple_query_string` with controlled operators inside a filtered
`bool` query as the first implementation. Keep filename and body scores separate. Add useful
first-stage name/phrase signals; introduce expensive reranking only when evaluation justifies it.
A catch-all field and learned LTR are optional optimizations, not prerequisites for full search.

## What the search should do

| Input or operation | Proposed behavior |
| --- | --- |
| `quarterly budget` | Both keywords must match the same object, anywhere in its searchable name or body. A name match is stronger, but a body-only match is eligible. |
| `"quarterly budget"` | Adjacent analyzed words in one field. A phrase cannot start in the filename and end in the body. |
| `quarterly (budget \| forecast)` | Require `quarterly` and one explicit alternative. |
| `"quarterly budget" -draft` | Require the phrase and exclude objects matching the negative term. |
| Type, date, folder, tenant, permission predicates | Structured hard filters outside every text-query branch. |
| Empty query or only filters | An explicit browse operation with a suitable deterministic sort. |
| Incomplete input while typing | An explicit prefix-query mode, using filename prefixes alongside appropriate completed terms. |

The default conjunction is a proposed product choice: every supplied keyword has a predictable
effect. An explicit any-term mode can relax that. Do not silently turn a failed phrase/exclusion
query into broad OR. If a UI offers partial matches after zero results, make that relaxation
visible; an LLM can explicitly request another query or any-term matching.

People and LLMs should reach the same query semantics. A text box can expose a small documented
syntax; structured tool arguments can express terms, phrases, exclusions, and filters without
forcing an LLM to escape punctuation. The server compiles both into equivalent clauses.

`simple_query_string` is fault tolerant and supports the operators above. Set explicit fields,
`default_operator=and`, and `AND|OR|NOT|PHRASE|PRECEDENCE|WHITESPACE|ESCAPE`; do not use its default
all-operators/all-fields behavior. The literal API syntax uses `|`, not the English word `OR`.
Define escaping for literal `+`, `-`, quotes, and parentheses. A pure negative query behaves like
filtered browsing with exclusions and should use a deliberate sort/pagination policy. The
parser's tolerance for malformed syntax is a UX choice to validate, not a guarantee that it
understands the user's intent.
[8.16 keyword parser](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-simple-query-string-query.html)

## Why the catch-all is not the default

We compared the mechanisms directly in a disposable ES 8.16.0 instance with ICU and a 215-object
diagnostic corpus. Three objects had the identical filename `Quarterly budget`, with either no
body, ten unrelated words, or 10,000 unrelated words. The table compares each method's score for
the long-body object with its own score for the short-body object:

| Retrieval/scoring method | Long-body / short-body filename score | Consequence |
| --- | ---: | --- |
| `copy_to` into `search_text` | 0.057 | Body length heavily changes a filename-only match. |
| `combined_fields` with `name^4` and body | 0.166 | Field boosting still leaves shared length normalization. |
| Independently scored fields through `simple_query_string` | 1.000 | Unrelated body length leaves the filename score unchanged. |

These are within-query comparisons, not a comparison of absolute scores between different
algorithms. The example demonstrates a mechanism; it does not establish production relevance,
weights, latency, or expected corpus-wide improvement.

Lucene 9.12, bundled with ES 8.16, confirms the reason: `combined_fields` combines weighted term
frequencies and weighted lengths of all participating fields present on a document. A missing or
long unrelated body therefore influences a name-only match. A `name^4` field boost is not an
independent name score. `copy_to` also shares the combined field's length statistics.
[Exact source evidence](dfs-search-ranking-evidence.md)

Independently scored fields also let filename and natural-language body analysis differ. With
whitespace parsing enabled, `simple_query_string` builds alternatives across the selected fields
for each query term, then joins required term groups. Its default field combination sums matching
field scores. Quoted phrases are matched within individual fields. In the diagnostic, it found
both a query split between name and body and a query split between a specially analyzed filename
and ordinary body text. A whole-query `multi_match best_fields AND` missed the split-field object.
[Diagnostic results](dfs-keyword-search-diagnostic-results.json),
[reproduction script](dfs-keyword-search-diagnostic.py)

`copy_to` remains worth benchmarking if querying many fields becomes a measured bottleneck. It
copies values for reanalysis, preserves the original fields, and does not add the destination to
`_source`. Keeping both original and catch-all inverted representations adds indexing work and
postings, particularly for the body. No source or test here proves a fixed storage multiplier.
If a catch-all is later used for eligibility, keep independent name/body scoring and highlight
the original fields. Do not copy IDs, ACLs, arbitrary xattrs, or MIME strings into lexical text.
[8.16 copy-to behavior](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/copy-to.html)

## Mapping and analysis

| Field | Purpose |
| --- | --- |
| `name` | Ordinary ICU-tokenized, case/accent-folded text; retains multilingual segmentation. |
| `name.parts` | Additional filename components, splitting underscores, punctuation, and case transitions while keeping units such as `Q4` and `v2` intact. |
| `name.keyword` | Original whole basename for exact identity/filter semantics. |
| `name.folded` | Normalized whole basename for a strong equality-ranking signal. |
| `name.edge` | Optional indexed token prefixes for an interactive prefix mode. Never the only searchable representation of a name. |
| `content_text` | Ordinary full text with BM25, term positions, and offsets for excerpts. |
| Language-specific body representation | Light stemming for supported languages, alongside the unstemmed representation. Select the supported language profile before freezing this part of the mapping. |
| Tenant, hierarchy, permissions, MIME, dates, sizes, xattrs | Typed exact/range filters, with authoritative authorization and freshness checks before returning a result. |

The [concrete index proposal](dfs-object-search-index-design.md) supplies the language-independent
baseline. Preserve ordinary `_source`; return compact result fields and excerpts rather than the
full body. Use a proper `text` field with positions and norms, because phrase and relevance scoring
are required. Offsets support unified highlighting; storing full term vectors is not a prerequisite.
[Text fields](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/text.html),
[highlighting](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/highlighting.html)

Actual analyzer checks found that ICU alone tokenizes `Q4_budget-final_v2.pdf` into `q4_budget`,
`final_v2`, and `pdf`: a `budget` query misses it. The separate filename-components analyzer found
`q4`, `budget`, `final`, `v2`, and `pdf`, and also split `CamelCaseReport.pdf`. However, it segmented
Japanese less finely than ICU. This supports retaining both representations rather than replacing
all multilingual analysis with filename splitting. The fields are cheap relative to an additional
full-body representation, but their relative boosts still need evaluation.

The candidate filename-components chain uses `whitespace`, `word_delimiter_graph` with numeric
splitting and original preservation disabled, then ICU folding. Keep the exact basename separately.
Do not enable graph-producing concatenation/original-preservation options without checking phrase
positions and index-time flattening requirements.
[Word delimiter graph](https://www.elastic.co/docs/reference/text-analysis/analysis-word-delimiter-graph-tokenfilter)

A follow-up check ran `StandardTokenizer` and `UAX29URLEmailTokenizer` directly from the Lucene
jars bundled with the cached ES 8.16.0 image, with lowercase filtering and no running server.
`uax_url_email` keeps URLs and emails intact; it is not an extension-removal rule. Both tokenizers
produced these filename terms:

| Input | Tokens |
| --- | --- |
| `report.pdf` | `report.pdf` |
| `report2.pdf` | `report2`, `pdf` |
| `report_2026.pdf` | `report_2026`, `pdf` |
| `quarterly budget.pdf` | `quarterly`, `budget.pdf` |
| `archive.tar.gz` | `archive.tar.gz` |

For `https://files.example.com/Quarterly-budget.pdf`, UAX URL/email preserved the complete URL,
where standard emitted `https`, `files.example.com`, `quarterly`, and `budget.pdf`. It also
preserved `jane.smith@example.com` as one email token. Thus it avoids some token fragmentation,
but filename extension behavior is not uniform. Attaching an extension to the word also means a
whole-token `report` query cannot match `report.pdf` through that representation alone. Edge
n-grams can expose its prefixes without standalone `pdf` grams; a subsequent word-delimiter
filter would split the extension again.
[Tokenizer semantics](https://www.elastic.co/docs/reference/text-analysis/analysis-uaxurlemail-tokenizer)

If extension terms should be excluded from filename relevance, normalize known file suffixes
explicitly before filename-component analysis, retaining the original full basename and an
extension/MIME filter. This requires a deliberate rule for files versus directories, dotfiles,
compound suffixes, and names such as `Release v1.2`; removing everything after any last dot is not
an adequate generic rule. The concrete baseline still includes extension components and should
be revised if this extension policy is adopted.

**Light stemming is useful; edge n-grams do a different job.** In the diagnostic, a plain query
`employee request` missed `Employees requested increases`; an English KStem representation found
it. This is morphological recall. KStem is English-specific; choose language-specific analysis
for a multilingual corpus and always retain an unstemmed path. Exact analyzed phrases should
use that path. A stemmed alternative intended to improve recall must participate in eligibility;
adding it only as an optional boost under a mandatory unstemmed query cannot retrieve new matches.
[KStem](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-kstem-tokenfilter.html)

Do not remove stop words globally in the initial mapping: phrase behavior, names, short acronyms,
and different languages need a deliberate policy. Query-time domain synonyms may be useful when
supported by evidence. The proposed whitespace parser processes separate unquoted input terms;
multiword synonym rules require a compatible query-construction path and are not automatically
handled across those parser boundaries.

Prefix grams should initially be confined to names. Generate them at index time and analyze the
query normally. They support `budg` → `budget`; they do not implement stemming, arbitrary substring
matching, or typo correction. The candidate range 2–20 plus original tokens is illustrative:
complete longer words match, but intermediate prefixes longer than 20 do not. We verified both
behaviors. Full-body prefixes should be added only if explicit product requirements and cost
measurements justify them, not as the default full-text analyzer.
[Edge n-grams](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-edgengram-tokenfilter.html)

Consider bounded typo tolerance as a separate fallback, initially on names and sufficiently long
words. Do not apply fuzzy expansion to every body term or stack fuzziness indiscriminately on
prefix grams. Technical punctuation also needs corpus-specific checks: both candidate analyzers
reduced `C++` and `C#` to `c`. Unstemmed phrase matching still works on analyzed tokens, not literal
bytes. If distinguishing these terms is important, add tested protected-term normalization or a
suitable identifier representation; the generic ICU baseline does not solve it.

## Ranking, content coverage, and result units

First-stage ranking should already combine independently normalized filename/body BM25 with
strong whole-name equality, filename phrase matching, and a moderate body phrase/proximity signal.
Use metadata as hard constraints when requested. Treat recency as a small, evaluated preference
when appropriate; a recently imported object is not necessarily a more relevant source. No
personalization/popularity signal is implied by the current stored data.

Do not boost the complete raw query string as a phrase/equality expression when it contains
operators. Derive phrase and name signals from the positive terms or phrase clauses in the parsed
query. Preserve every exclusion and required phrase around all fallback/expansion branches.

The result remains an object: one file can have many 64 KiB storage blocks, and an extracted text
object can supply the original file's searchable body. Neither fact requires a search hit per
storage block. Whole-file BM25 still penalizes long bodies for content-only queries; this is a
separate issue from filename/body score coupling. Evaluate body length normalization on short
notes, large PDFs, and long imported documents. If results require passage-level relevance, add
content-based passages and aggregate back to the object; avoid selecting 64 KiB as a retrieval
unit simply because storage uses it.

Full content search depends on extraction coverage. Define supported formats, extraction failures,
stale text handling, large-file limits, and any deliberate truncation explicitly. A file with no
searchable extraction should remain findable by name/metadata, but its content is not searchable.
Do not present partial extraction as complete indexing. Authorization must cover both eligibility
and returned excerpts.

Start without learned LTR. Fixed lexical scores are a complete baseline for this workload; an
optional query rescore can add expensive phrase signals over a measured candidate window. Learned
LTR needs judgments and consistent features, and cannot recover excluded candidates. Native LTR
in 8.16 requires Enterprise model creation; the infrastructure PR's rendered configuration reports
Basic. Ordinary query rescore is independent of that feature. A plugin/external reranker is a
separate deployment option, not a reason to shape the initial text mapping around a catch-all.
[Ranking/licensing evidence](dfs-search-ranking-evidence.md)

Ordinary lexical search can paginate using a point-in-time view and score/object-ID ordering.
ES 8.16 rescore rejects an explicit secondary sort, so adding it requires a deliberate pagination
strategy. Its candidate window is per shard; with three shards, a window of 500 may rerank 1,500
objects. Count authorization/freshness rejections when evaluating end-to-end candidate recall.

## What is established, and what needs corpus evaluation

Established locally on ES 8.16.0: query-term matching across fields and different analyzers;
field-local phrases; exclusion/Boolean behavior; independent filename scores; filename splitting;
English stemming; accent folding; prefix versus full-token matching; and long-prefix limits.
The exact mapping/settings/sample query from the main proposal were also loaded successfully,
using local allocation settings (one primary, zero replicas, no workload filter). Five test objects
confirmed expected lexical/filter matches, body excerpts, and preservation of maximum `u64` values.
[Mapping/query validation](dfs-keyword-proposal-validation.json)

The diagnostic is intentionally small and synthetic. It does not measure production relevance,
multi-shard behavior, real access-control filtering, throughput, or memory requirements.

Evaluate a representative set of human and LLM keyword queries against the real corpus, with
judged relevant objects. Include name lookup, body-only evidence, cross-field terms, phrases,
identifiers, languages, short/long files, folders, prefixes, and filters. Measure filename MRR,
general-search nDCG@10, candidate Recall@K, zero-result rate, and latency under concurrent indexing.
Measure index size and ingestion CPU for each extra body representation. These results should
choose boosts, stemming profiles, any term relaxation, body-length normalization, prefix limits,
and whether a reranker or passages add value. They should not decide whether basic phrases and
keyword coverage work: those semantics can be specified and tested now.

## Reproducing the mechanics diagnostic

Use a fresh disposable instance; the script deliberately refuses another cluster/version and
creates its own named index. The tested container command was:

```sh
docker run --detach --rm --pull=never \
  --name codex-dfs-search-analysis-20261019 --memory=2g --cpus=2 \
  -p 127.0.0.1:19217:9200 -e 'ES_JAVA_OPTS=-Xms512m -Xmx512m' \
  docker.elastic.co/elasticsearch/elasticsearch:8.16.0 \
  bash -c 'bin/elasticsearch-plugin install --batch analysis-icu && exec bin/elasticsearch -Ediscovery.type=single-node -Expack.security.enabled=false -Expack.ml.enabled=false -Ecluster.name=codex-dfs-search-analysis -Enode.name=analysis'
```

Pull that image first if it is not cached. Once the node is ready, run
`python3 research/dfs-keyword-search-diagnostic.py` from `front`. Stop the named container afterward;
`--rm` removes its ephemeral index data. No existing development indices are used by the script.
