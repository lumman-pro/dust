# DFS object search: proposed mapping and query design

2026-10-19. Target: Elasticsearch 8.16.0 / Lucene 9.12.0 with `analysis-icu`.
This revision supersedes the earlier analysis/query recommendations in
[the first proposal](dfs-object-search-index-design.md) and
[the keyword-only note](dfs-full-keyword-search-design.md).

**Final status: research complete; index and mapping proposal ready for implementation review.**
The proposed JSON has passed the executable checks below. Remaining rollout work is to implement
the projection and query compiler, register the producer xattributes, and validate relevance,
capacity, and operational settings on a representative production corpus.

**Recommendation:** one `dfs.objects` alias, backed initially by `dfs.objects_1`, with one ES
document per original DFS object. Retain distinct filename, extracted-content, and selected
attribute fields. Index an unstemmed representation for phrases and prefixes, plus separate
English/French representations for inflection matching. Use `index_prefixes` to accelerate
completion, and compile the expression into required word/phrase groups whose alternatives can
match different fields. Keep typed metadata and timestamps available for later LTR.

| Index proposal | Value |
| --- | --- |
| Search alias | `dfs.objects` |
| Initial physical index | `dfs.objects_1` |
| Indexed entity | One original DFS object, including its extracted text |
| Mapping | `dynamic: strict`; independent name/content/attribute fields with unstemmed, English, and French representations |
| Node allocation | `index.routing.allocation.require.workload: filesystem` |
| Initial operational settings | 3 primary shards, 1 replica, `5s` refresh; provisional pending capacity validation |

The complete, executable proposal is in the [mapping](dfs.objects_1.mappings.proposed.json) and
[settings](dfs.objects_1.settings.proposed.json). The [verification harness](dfs-object-search-validation.py)
loaded those exact files into a disposable ES 8.16 instance, changing only shard/replica counts and
removing the production allocation constraint. [Results](dfs-object-search-validation-results.json):
**46 checks passed on 138 synthetic objects**, plus a separate comparison of five prefix/indexing
configurations. This establishes mechanics; it is not a production relevance or capacity benchmark.

**The requested behavior determines the query structure.** The following examples use case/accent
normalization. Quotes mean consecutive, ordered, unstemmed analyzed tokens at zero slop. They do
not mean byte-for-byte equality, and they never enable prefix expansion.

| Input | Behavior |
| --- | --- |
| `repo`, while typing | Finds `Reports.pdf`, `AnnualReports.pdf`, reports in extracted content, and reports in selected textual attributes. |
| `budget repo`, while typing | Requires budget and a matching interpretation of repo. Budget may be in the name while reports is in the content, or conversely. |
| `A B` | Requires both clauses on the same object; each can be satisfied by a different searchable field. |
| `"annual reports"` | Matches adjacent annual + reports in one field/value. Does not match annual report, annual revised reports, or annual in the name and reports in the body. |
| `"report"` | Does not match reports merely through stemming or prefixing. |
| `employee request` | Can match Employees in the filename and requested in content. |
| `journal société` | Can match Journaux in the filename and sociétés in content. |
| `type:pdf "annual reports" budg`, while typing | Requires the PDF type, the exact analyzed phrase, and budget/budgeting/etc. through the active prefix. |
| `tag:"Réseau sécurité"` | Equality on the normalized whole tag, not a phrase query over arbitrary metadata. |
| `filename:"Literal-v1.2.PDF"` | Equality on the normalized complete basename; punctuation remains significant. Raw identity is also available on `name.keyword`. |

The typing state matters. Only the active positive, unquoted word gets a prefix alternative;
completed words retain whole-word and stemmed matching. A trailing space commits that word.
The active word also retains whole-word/stemmed alternatives, so typing a complete inflected word
can already find its related forms; only the prefix branch bypasses stemming.
Submission should preserve the visible completion interpretation rather than making selected
results disappear. A completed-search operation can explicitly disable prefix expansion; LLM
clients can select that behavior or use quotes. A modifier value has its own completion UI and
does not become a body prefix. These are proposed behaviors, independent of the existing DFS
Search RPC.

**The storage model supports one object result.** DFS stores a basename, kind, parent, object ID,
unsigned sizes/timestamps/versions, optional MIME type, and a map of xattribute names to arbitrary
bytes. File blocks are 64 KiB storage units. They are not search objects or semantic passages.
Extracted text is projected into the original object's `content_text`; a private extraction object
must not create a second result. The source does not currently establish a general owner/tag/
description xattribute schema. The optional attribute fields below are a proposed search
projection, populated only when a producer/registry defines the corresponding source keys.
[Stored object/metadata types](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L152),
[extraction proposal](https://github.com/dust-tt/dust/pull/35070).

**Use explicit representations of each logical field.** Multi-fields index the same source value
separately without duplicating that value in `_source`. Each representation has its own options;
they do not inherit the parent's analyzer. The full JSON uses flat sibling multi-fields because
ES 8.16 rejects a multi-field containing another multi-field.
[8.16 multi-fields](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/multi-fields.html).

| Field family | Mapping and purpose |
| --- | --- |
| `name` | Unstemmed ICU text, positions/offsets, prefix acceleration. Supports ordinary multilingual names. |
| `name.parts` | Unstemmed filename components, positions/offsets, prefix acceleration. Splits punctuation, underscores, and case transitions. |
| `name.en`, `name.fr` | The component analyzer followed by English/French stemming. A stemmer applied directly to the ICU token Reports.pdf would not create report. |
| `name.keyword`, `name.folded` | Original complete basename and ICU-normalized complete basename. Identity, equality, and later exact-name ranking features. |
| `content_text`, `.en`, `.fr` | Entire available extracted/native text, with independent unstemmed, English, and French analysis. Prefixes only on the unstemmed root. |
| `attributes.title`, `attributes.description` | Optional selected text attributes, with the same root/en/fr structure. Title can receive its own weight and LTR feature. |
| `attributes.tags` | Normalized keyword array for exact filtering, plus sibling `.text`, `.en`, `.fr` fields for unqualified lexical search. |
| `mime_type`, `file_type`, `extension`, `kind` | Separate keywords with explicit meanings; not copied into natural-language text. |
| `attributes.owner_ids`, `attributes.source` | Exact keywords; IDs are not stemmed or accent-folded. |
| `modified_at`, `created_at`, `attributes.source_modified_at` | Validated date values with doc values for filters and future freshness features. |
| `name.token_count`, `content_text.token_count` | Numeric doc values for future length features. Not precomputed relevance scores. |
| Tenant, ancestry, permission, deletion, provenance fields | Preserve the object projection's scope, authorization prefilter, extraction/version provenance, and tombstones. |

`dynamic: strict` prevents arbitrary xattribute names from creating mappings. Selected keywords
must be validated/bounded in the projection before indexing, including their encoded byte length;
do not let a malformed or oversized optional tag reject the complete object. Unsupported binary
xattributes are not coerced into prose. `xattr_names` and `xattr_pair_hashes` remain available for
explicit raw existence/equality predicates independently of friendly modifiers.

**Analysis is explicit and separates morphology from typing.**

| Analyzer | Pipeline |
| --- | --- |
| `dfs_text` | Map straight/curly apostrophes to spaces → ICU tokenizer → ICU folding. No stemming or stop-word removal. |
| `dfs_filename` | Whitespace tokenizer → word_delimiter_graph → ICU folding. Case splitting happens before folding; numeric splitting is disabled. |
| `dfs_text_en` | ICU tokenizer → English possessive normalization → ICU folding → Porter2. |
| `dfs_text_fr` | ICU tokenizer → French elision → ICU folding → light_french. |
| `dfs_filename_en/fr` | Filename components → ICU folding → the corresponding stemmer. |
| `dfs_folded` | Keyword normalization with ICU folding. Used consistently for friendly full-name/tag equality. |

The filename component filter does not concatenate or preserve extra originals in the same token
stream; the root/keyword fields already retain them. This avoids unnecessary graphs for phrase
and prefix analysis. It retains Q4/v2 as units while making Reports in Q4_Reports-final_v2.pdf
searchable. The ordinary ICU root remains necessary for segmentation such as Japanese.
[Word-delimiter guidance](https://www.elastic.co/docs/reference/text-analysis/analysis-word-delimiter-graph-tokenfilter).

Porter2 is deliberately broader than the earlier KStem suggestion. The live probe and Lucene
dictionary show that KStem keeps running unchanged; the proposed English alternate maps running
and run together. French uses light_french with prose elision, and the tests cover journaux/journal,
chevaux/cheval, and sociétés/société. Stemming is not translation or complete linguistic
lemmatization. The source review explains the algorithm choices.
[Stemmer evidence](dfs-search-as-you-type-evidence.md),
[supported stemmers](https://www.elastic.co/docs/reference/text-analysis/analysis-stemmer-tokenfilter).

Apostrophe boundaries in the unstemmed root solve an actual completion gap: avio can match l’avion,
and reill can match O’Reilly. The quoted sequence "l’avion est" still requires l + avion + est and
does not match "avion est". The replacement keeps character lengths unchanged. French elision
remains confined to the French stemmed alternate. NFC/NFD accents and friendly keyword
normalization are tested, not assumed equivalent to lowercase + ASCII folding.

**Do not delete filename extensions in this baseline.** Keep Reports.pdf, archive.tar.gz, dotfiles,
and version-like names intact in source and keyword fields. Component analysis makes report/pdf
and archive/tar/gz available; metadata defines type filtering. This solves word recall without an
extension allowlist embedded in the name analyzer. A future observed ranking problem from common
suffix tokens can be addressed separately with a carefully defined stem/basename projection.
`uax_url_email` does not reliably identify or remove file extensions, as the earlier
[Lucene probe](dfs-full-keyword-search-design.md) demonstrated.

Quotes are exact at the analyzed-token level. For example, filename punctuation/CamelCase may
become word boundaries. Generic analysis also conflates some symbolic terms such as C++ and C#;
the diagnostic records that limitation. Byte-exact whole-name lookup uses the keyword field.
If literal symbol-sensitive phrases inside content are required, add a deliberate identifier/
literal analysis policy and acceptance cases; do not advertise ordinary phrase queries as
byte-exact substring search.

**Keep English and French in one index.** The proposed multi-fields analyze each value through
both language chains. This covers unlabeled/mixed-language files and allows an English name and
French body to match the same object without result merging. Group language alternatives under
`dis_max`, so a token unchanged by both stemmers does not get two independent ranking bonuses.

There is a real cost: two extra analyzed body representations and possible cross-language stem
collisions. A document-level language filter does not remove those indexed postings. If reliable
language classification becomes available, explicit language-specific body fields populated from
classified text can reduce the cost; mixed documents need segment-level treatment to retain
minority-language recall. That is an alternative projection, not a requirement for separate
indexes. The single-index design remains suitable.
[Elastic's mixed-language alternatives](https://www.elastic.co/guide/en/elasticsearch/guide/current/mixed-lang-fields.html)
(historical conceptual guidance; mapping syntax verified separately on 8.16).

**Use `index_prefixes` as an accelerator on the unstemmed fields.** The proposed starting ranges
are 1–10 for names/title and 1–5 for body/description/tags. They are tuning inputs, not measured
production optima. The internal prefix representation shares the root's analyzed tokens, while
the public root retains ordinary full terms and positions.

Query an active clause with analyzed `match_bool_prefix` against the public root/parts fields.
An in-range fragment rewrites to an indexed prefix term; a longer fragment falls back to a normal
prefix query on the full-term dictionary. The maximum therefore limits acceleration, not recall.
The actual rewrite for repo was ConstantScore(content_text._index_prefix:repo), and the 22-character
electroencephalographic prefix still matched electroencephalographically.
[Prefix mapping](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/index-prefixes),
[pinned implementation analysis](dfs-search-as-you-type-evidence.md).

The fallback needs `search.allow_expensive_queries` enabled. The harness verifies that short
optimized queries work when it is disabled but long fallback queries fail. Do not silently drop
the prefix in that situation. Check the target cluster setting and bound generated query size/
request time before rollout. `min_chars: 1` also avoids an ES 8.16 lower-bound mismatch between
UTF-16 length and Unicode code-point length; supplementary-character completion is tested.

`search_as_you_type` is a credible alternative, especially for short-title adjacent-word/order
signals. It adds shingle representations that this candidate query does not require. It does not
make whole-query bool_prefix AND become term-centric across name/body, nor does it independently
solve stemming/exact-phrase semantics. A manually indexed edge-ngram field also works with an
explicit fallback, but preserve_original alone leaves intermediate long prefixes missing.
[Search-as-you-type source](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/search-as-you-type.asciidoc),
[edge-ngram limits](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-edgengram-tokenfilter.html).

The separate 201-document synthetic comparison measured these configurations. All use the same
source corpus; these are as-configured storage figures, not equal-gram-range efficiency ratios
or a forecast for real extraction data. The main mapping's offsets and attribute fields add
further costs beyond this minimal comparison.

| Configuration | Inverted-index bytes | Long intermediate prefix found? |
| --- | ---: | --- |
| Plain unstemmed text | 59,194 | Yes, dictionary prefix query |
| Unstemmed + index_prefixes 1–5 | 109,142 | Yes, fallback |
| Same + English/French alternates | 226,414 | Yes, fallback |
| Unstemmed + manual edge field 1–20, preserve_original | 364,458 | No with match on that edge field |
| search_as_you_type with 2/3-word shingles | 619,841 | Yes, fallback |

**Compile text into required groups, with filters outside them.** For the combined example:

```text
FILTER tenant, current-readable scope, not-deleted, file_type=pdf
AND PHRASE("annual reports", in any one unstemmed field/value)
AND (
  WORD_OR_STEM("budg", in name OR content OR selected attributes)
  OR PREFIX("budg", in unstemmed name OR content OR selected attributes)
)
```

Every plain clause gets its own required group. Within that group, `dis_max` combines alternative
representations of the same logical field, then field-specific matches compete/contribute with
independent BM25 statistics. The active prefix is an eligibility alternative in its group, not
merely an optional boost beneath a mandatory full-word query. The harness gives prefix-only
matches a small constant contribution, avoiding prefix-term rarity dominating ranking. Closed
quoted groups contain only match_phrase/slop=0 on unstemmed fields. Array position gaps prevent
a quoted phrase from being assembled across separate tags/description values.

Do not send the whole expression to multi_match best_fields/bool_prefix with AND: that can require
both words inside one field. Do not pass user modifier names through as arbitrary ES field names.
Parse a small expression grammar, preserve phrase and cursor state, resolve known modifiers, and
compile the resulting structure. A token may analyze to several components; the initial policy
keeps those components within its syntactic clause. Full multiword-synonym expansion would need
query-graph work; it is not implicitly supported by splitting whitespace. The Python parser is
a complete-input fixture harness, not the production parser implementation.
[Boolean query semantics](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/query-dsl-bool-query.html),
[multi-field query evidence](dfs-search-ranking-evidence.md).

A copy_to candidate field remains a legitimate optimization: if used only in a filter, its BM25
length normalization does not affect ranking. Here it would add another indexed body, impose a
common analysis choice, and still require original fields for phrases/features. With a small
explicit set of searchable field families, independent alternatives are the cleaner initial
design. Likewise, combined_fields can be useful under a shared analysis strategy, but mixing its
length statistics is not the desired filename score. The live test confirms that adding 10,000
unrelated body tokens leaves a filename-only score unchanged with the proposed query.

**Modifiers are a typed projection of metadata, not analysis rules.** Maintain a small registry
that specifies source key(s), byte decoding, cardinality, normalization, ES destination, and
supported operators. Producers may use xattributes for most of this metadata; DFS MIME and kind
already have native fields. Unrecognized/binary/internal xattributes do not enter lexical search.

| Modifier | Destination/semantics |
| --- | --- |
| `type:pdf` | term filter on file_type=pdf, derived from normalized MIME. Known authoritative MIME takes precedence over a disagreeing filename suffix. |
| `type:folder` | kind=directory. |
| `mime:application/pdf` | Exact normalized MIME type/subtype. |
| `ext:pdf` | Explicit extension metadata; separate from MIME-derived type. |
| `tag:"Réseau sécurité"` | Exact normalized whole tag, resolved from registered xattribute(s). |
| `owner:<id>`, `source:gdrive` | Exact registered metadata, with a user/alias-resolution layer if needed. |
| `before:2026-01-01`, `after:2026-01-01` | Typed modified_at range; define UTC/date-zone boundaries consistently. |

For missing/generic MIME, any fallback from a recognized extension to file_type must be specified
in that same registry; it is not guessed by an analyzer. Dotfiles, version suffixes, compound
extensions, and directories have explicit extension-extraction rules. The diagnostic verifies
that a .pdf filename with a known text/plain type does not pass type:pdf. Optional attribute
projections are absent when no registered producer value exists; do not invent owners or sources.

**Prepare for LTR by retaining data and independent features, not by adding a model now.** Preserve
name/body/attribute BM25 features, whole-name equality, phrase/order matches, prefix-versus-word
match indicators, token counts, type/extraction state, and source/object modification timestamps.
These query-dependent match features should be computed for the query, not stored as stale
document scores. A future feature builder/reranker can consume the same parsed query and candidate
objects while the retrieval/filtering stage stays stable. The current mapping/query adds no
freshness boost or LTR model.

`mtime_ms` is an unsigned source value. `modified_at` is its validated date projection, omitted
when it is outside the supported date domain. The diagnostic indexes the maximum u64 with no
derived date successfully. Preserve source_modified_at separately when a connector supplies it;
do not equate indexing time with content freshness. Use a fixed query-time reference and an
explicit missing/future-time policy when deriving age features. DFS reads do not update atime,
so it is not a popularity or last-viewed signal.
[DFS timestamp semantics](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/design-docs/VERSIONS.md).

LTR can only rerank retrieved candidates. Evaluate recall@K as well as top-page relevance, and
later retain candidate/features/query-version data for judged or interaction-based training.
Keep reranking behind an explicit boundary rather than promising that arbitrary existing
search_after/sort pagination will work unchanged. Native ES 8.16 rescore operates per shard,
has sort/window constraints, and native LTR model configuration requires Enterprise; the infra
proposal shows Basic. The mapping is also usable by an application reranker or another selected
implementation. These are future integration choices, not a request to add LTR today.
[Pinned LTR/rescore evidence](dfs-search-ranking-evidence.md).

**Scope and rollout remain object-aware.** Tenant, ancestry, read-inheritance, and tombstone
filters wrap every lexical path. Search must recheck current DFS authorization before exposing
names/excerpts. Attribute/extraction changes must publish a consistent complete projection;
stale extraction text must not survive a content-version change. The earlier source-grounded
[projection/permission analysis](dfs-object-search-index-design.md) remains relevant for these
facts, independently of its superseded lexical proposal.

The settings route the index to workload=filesystem, matching the dedicated pool proposal.
Three primaries, one replica, and five-second refresh are provisional operational settings.
Capacity tests must use realistic extracted sizes, language mix, vocabulary, short-prefix traffic,
refresh/indexing rates, concurrent queries, and reindex headroom before deployment. The local
fixture does not establish p95 latency, final boosts, shard count, production ACL correctness,
extraction completeness, or acceptable relevance on real queries.
