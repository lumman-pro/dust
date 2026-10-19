# DFS object search: proposed mapping and query design

2026-10-19. Target: Elasticsearch 8.16.0 / Lucene 9.12.0 with `analysis-icu`.
This revision supersedes the earlier analysis/query recommendations in
[the first proposal](dfs-object-search-index-design.md) and
[the keyword-only note](dfs-full-keyword-search-design.md).

**Status: index definition and bootstrap implemented. Cell, language, and permission projections revised.**
The [DFS search module](../../server/src/search.rs) embeds versioned mappings and per-cell settings.
Its [bootstrap command](../../server/src/search/README.md) previews the creation request or creates
the index and write alias together. Remaining work is the object projection and durable indexing,
extraction lifecycle, detector selection/calibration, authorization rechecks, application
lexer/parser/query compiler, and producer xattribute registry. Relevance, capacity, and operational
settings still require validation on a representative production corpus.

**Recommendation:** one `dfs.objects` alias, backed initially by `dfs.objects_1`, with one ES
document per original DFS object. Retain distinct filename, extracted-content, and selected
attribute fields. Always index unstemmed text for phrases and prefixes. Populate explicit
English/French fields only with text classified for that language. Use `index_prefixes` to accelerate
completion, and compile expressions into required word/phrase groups whose alternatives can match
different fields. Keep typed metadata and timestamps available for later LTR.

| Index proposal | Value |
| --- | --- |
| Search alias | `dfs.objects` |
| Initial physical index | `dfs.objects_1` |
| Indexed entity | One original DFS object, including its extracted text |
| Mapping | `dynamic: strict`. Neutral name/content/attribute fields plus explicitly populated `stemmed.en` / `stemmed.fr` text |
| Node allocation | `cell-00000` / `cell-00001`: require `workload=filesystem`. `cell-00002`: shared pool, no workload constraint |
| Initial operational settings | 3 primary shards, 1 replica, `5s` refresh. Provisional pending capacity validation |

The active, executable definition is in the [mapping](../../server/src/search/indices/objects_1.mappings.json)
and settings for [cell-00000](../../server/src/search/indices/objects_1.settings.cell-00000.json),
[cell-00001](../../server/src/search/indices/objects_1.settings.cell-00001.json), and
[cell-00002](../../server/src/search/indices/objects_1.settings.cell-00002.json). The
earlier analyzer examples remain alongside this note for reference. The
[verification harness](dfs-object-search-validation.py)
loaded the active mapping and `cell-00000` settings into a disposable ES 8.16 instance, changing
only shard/replica counts and removing the production allocation constraint.
[Results](dfs-object-search-validation-results.json): **73 checks passed on 147 synthetic objects**,
plus a separate comparison of five prefix/indexing configurations. This establishes mechanics. It is not a production relevance or capacity benchmark.

All five [Rust bootstrap tests](../../server/tests/search.rs) passed, covering creation, preflight
and acknowledgement failures, cell allocation, offline preview, and rejection of regional selectors.
Live validation used the compiled command to preview every cell/local profile and create the index
on an unlabelled ES node using `cell-00002`. Writes through the alias and the example's independent
scope/access filters worked. A repeated bootstrap failed without replacing the index or losing data.
Cell selection uses `--cell` / `CELL` exclusively. Formatting, Clippy, and code-contract checks passed.
These checks do not implement a production detector, grant resolver, indexing workflow, or permission
recheck.

**The requested behavior determines the query structure.** The following examples use case/accent
normalization. Quotes mean consecutive, ordered, unstemmed analyzed tokens at zero slop. They do
not mean byte-for-byte equality, and they never enable prefix expansion.

| Input | Behavior |
| --- | --- |
| `repo`, while typing | Finds `Reports.pdf`, `AnnualReports.pdf`, reports in extracted content, and reports in selected textual attributes. |
| `budget repo`, while typing | Requires budget and a matching interpretation of repo. Budget may be in the name while reports is in the content, or conversely. |
| `A B` | Requires both clauses on the same object. Each can be satisfied by a different searchable field. |
| `"annual reports"` | Matches adjacent annual + reports in one field/value. Does not match annual report, annual revised reports, or annual in the name and reports in the body. |
| `"report"` | Does not match reports merely through stemming or prefixing. |
| `employee request` | Can match Employees in the filename and requested in content when the relevant text is accepted for English stemming. |
| `journal société` | Can match Journaux in the filename and sociétés in content when the relevant text is accepted for French stemming. |
| `type:pdf "annual reports" budg`, while typing | Requires the PDF type, the exact analyzed phrase, and budget/budgeting/etc. through the active prefix. |
| `tag:"Réseau sécurité"` | Equality on the normalized whole tag, not a phrase query over arbitrary metadata. |
| `filename:"Literal-v1.2.PDF"` | Equality on the normalized complete basename. Punctuation remains significant. Raw identity is also available on `name.keyword`. |

The typing state matters. Only the active positive, unquoted word gets a prefix alternative.
Completed words retain whole-word and stemmed matching. A trailing space commits that word.
The active word also retains whole-word/stemmed alternatives, so typing a complete inflected word
can already find its related forms. Only the prefix branch bypasses stemming.
Submission should preserve the visible completion interpretation rather than making selected
results disappear. A completed-search operation can explicitly disable prefix expansion. LLM
clients can select that behavior or use quotes. A modifier value has its own completion UI and
does not become a body prefix. These are proposed behaviors, independent of the existing DFS
Search RPC.

**The storage model supports one object result.** DFS stores a basename, kind, parent, object ID,
unsigned sizes/timestamps/versions, optional MIME type, and a map of xattribute names to arbitrary
bytes. File blocks are 64 KiB storage units. They are not search objects or semantic passages.
Extracted text is projected into the original object's `content_text`. A private extraction object
must not create a second result. The source does not currently establish a general owner/tag/
description xattribute schema. The optional attribute fields below are a proposed search
projection, populated only when a producer/registry defines the corresponding source keys.
[Stored object/metadata types](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/server/src/storage/resources/object.rs#L152),
[extraction proposal](https://github.com/dust-tt/dust/pull/35070).

**Use explicit representations of each logical field.** Multi-fields always analyze the same
source value, so they cannot selectively enable English or French analysis after detection. The
language variants are real source fields under `stemmed.en` and `stemmed.fr`. The projection supplies
original text only to its accepted language field. Ordinary multi-fields remain for neutral filename
components, keyword equality, tags, and token counts. Explicit language fields duplicate selected
text in `_source`. Measure this storage tradeoff with real extracted sizes.
[8.16 multi-fields](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/multi-fields.html).

| Field family | Mapping and purpose |
| --- | --- |
| `name` | Unstemmed ICU text, positions/offsets, prefix acceleration. Supports ordinary multilingual names. |
| `name.parts` | Unstemmed filename components, positions/offsets, prefix acceleration. Splits punctuation, underscores, and case transitions. |
| `stemmed.en.name`, `stemmed.fr.name` | Optional classified filename text, with component analysis followed by the selected stemmer. Unknown names have neither field. |
| `name.keyword`, `name.folded` | Original complete basename and ICU-normalized complete basename. Identity, equality, and later exact-name ranking features. |
| `content_text` | Complete extracted/native text, unstemmed, with phrase positions and prefix acceleration. Always retained regardless of language classification. |
| `stemmed.en.content_text`, `stemmed.fr.content_text` | Text accepted for that language: the whole field when appropriate, or independently classified segments in a mixed body. |
| `attributes.title`, `attributes.description` | Selected unstemmed text attributes. Optional language projections live under `stemmed.en.attributes` / `stemmed.fr.attributes`. Each field retains its own score. |
| `attributes.tags` | Normalized keyword array for filtering plus neutral `.text` for lexical search. Only reliably classified tag values populate `stemmed.en.attributes.tags` / `stemmed.fr.attributes.tags`. |
| `kind` | Keyword containing `file` or `directory`. |
| `mime_type` | Normalized MIME type/subtype. Friendly type categories compile to filters on this field. |
| `extension` | Explicit filename-extension keyword for `ext:` filters. |
| `attributes.owner_ids`, `attributes.source` | Exact keywords. IDs are not stemmed or accent-folded. |
| `modified_at`, `created_at`, `attributes.source_modified_at` | Validated date values with doc values for filters and future freshness features. |
| `name.token_count`, `content_text.token_count` | Numeric doc values for future length features. Not precomputed relevance scores. |
| `ancestor_ids` | All physical ancestors, excluding self. Recursive scope also checks `object_id` when including the selected object. |
| `read_grant_scope_ids` | Object IDs where a direct READ grant could authorize this object, including self and the closest read-DENY node. Independent of current grants. |
| Tenant, deletion, provenance fields | Tenant isolation, tombstones, and extraction/version provenance. |

`dynamic: strict` prevents arbitrary xattribute names from creating mappings. Selected keywords
must be validated/bounded in the projection before indexing, including their encoded byte length.
Do not let a malformed or oversized optional tag reject the complete object. Unsupported binary
xattributes are not coerced into prose. `xattr_names` and `xattr_pair_hashes` remain available for
explicit raw existence/equality predicates independently of friendly modifiers.

**Analysis is explicit and separates morphology from typing.**

| Analyzer | Pipeline |
| --- | --- |
| `dfs_text` | Map straight/curly apostrophes to spaces → ICU tokenizer → ICU folding. No stemming or stop-word removal. |
| `dfs_filename` | Whitespace tokenizer → word_delimiter_graph → ICU folding. Case splitting happens before folding. Numeric splitting is disabled. |
| `dfs_text_en` | ICU tokenizer → English possessive normalization → ICU folding → Porter2. |
| `dfs_text_fr` | ICU tokenizer → built-in `elision` → ICU folding → light_french. |
| `dfs_filename_en/fr` | Filename components → ICU folding → the corresponding stemmer. |
| `dfs_folded` | Keyword normalization with ICU folding. Used consistently for friendly full-name/tag equality. |

The filename component filter does not concatenate or preserve extra originals in the same token
stream. The root/keyword fields already retain them. This avoids unnecessary graphs for phrase
and prefix analysis. It retains Q4/v2 as units while making Reports in Q4_Reports-final_v2.pdf
searchable. The ordinary ICU root remains necessary for segmentation such as Japanese.
[Word-delimiter guidance](https://www.elastic.co/docs/reference/text-analysis/analysis-word-delimiter-graph-tokenfilter).

Porter2 is deliberately broader than the earlier KStem suggestion. The live probe and Lucene
dictionary show that KStem keeps running unchanged. The proposed English alternate maps running
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
and archive/tar/gz available. Metadata defines type filtering. This solves word recall without an
extension allowlist embedded in the name analyzer. A future observed ranking problem from common
suffix tokens can be addressed separately with a carefully defined stem/basename projection.
`uax_url_email` does not reliably identify or remove file extensions, as the earlier
[Lucene probe](dfs-full-keyword-search-design.md) demonstrated.

Quotes are exact at the analyzed-token level. For example, filename punctuation/CamelCase may
become word boundaries. Generic analysis also conflates some symbolic terms such as C++ and C#.
The diagnostic records that limitation. Byte-exact whole-name lookup uses the keyword field.
If literal symbol-sensitive phrases inside content are required, add a deliberate identifier/
literal analysis policy and acceptance cases. Do not advertise ordinary phrase queries as
byte-exact substring search.

**Keep English and French in one index, and select analysis during projection.** Neutral fields
always contain the original text. Detect substantive fields independently: an English filename and
a French body can legitimately populate different language groups. A reliable supported-language
assignment populates only that language field. Do not infer a short filename's or tag's language
from the body. Unknown, short, unsupported, or failed classifications retain neutral search without
stemming. This sacrifices some inflection recall and needs explicit evaluation on our corpus.

For mixed bodies, independently classified paragraphs or extraction blocks can populate separate
language arrays while the complete original remains in `content_text`. Do not assign one winning
language to the entire body merely because a detector returns high confidence. Each segment has its
own position/offset space: highlight language fields independently, rather than merging their offsets
into the full neutral body's `matched_fields`. Neutral token counts still describe whole-field length
for LTR. Segment-field BM25 statistics do not.

Google CLD3 is a candidate local detector, but its upstream repository is archived. Its default
minimum length excludes most filenames, and its top-N method splits by script rather than separating
English/French paragraphs. Short query fragments must never choose a single search-language branch.
The [language detection investigation](dfs-language-detection-evidence.md) records primary sources,
reproducible detector probes, and the integration/calibration work still required. No detector is
integrated in this schema/bootstrap PR. The ES harness uses explicitly labeled language fixtures,
which validates selective indexing mechanics rather than classifier accuracy.

Queries still consider neutral and both supported language fields for each required word, grouping
alternatives under `dis_max`. Only populated fields can match. This preserves matches spanning an
English filename and French content without relying on language detection of a short query.
Quotes and prefixes use only the neutral fields. The built-in French `elision` filter replaces the
copied article list. Detecting French does not itself normalize `l'avion` to `avion`.
[Elision behavior](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-elision-tokenfilter.html),
[selective-field analysis](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/multi-fields.html).

**Use `index_prefixes` as an accelerator on the unstemmed fields.** The proposed starting ranges
are 1–10 for names/title and 1–5 for body/description/tags. They are tuning inputs, not measured
production optima. The internal prefix representation shares the root's analyzed tokens, while
the public root retains ordinary full terms and positions.

Query an active clause with analyzed `match_bool_prefix` against the public root/parts fields.
An in-range fragment rewrites to an indexed prefix term. A longer fragment falls back to a normal
prefix query on the full-term dictionary. The maximum therefore limits acceleration, not recall.
The actual rewrite for repo was ConstantScore(content_text._index_prefix:repo), and the 22-character
electroencephalographic prefix still matched electroencephalographically.
[Prefix mapping](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/index-prefixes),
[pinned implementation analysis](dfs-search-as-you-type-evidence.md).

The fallback needs `search.allow_expensive_queries` enabled. The harness verifies that short
optimized queries work when it is disabled but long fallback queries fail. Do not silently drop
the prefix in that situation. Check the target cluster setting and bound generated query size/
request time before rollout. `min_chars: 1` also avoids an ES 8.16 lower-bound mismatch between
UTF-16 length and Unicode code-point length. Supplementary-character completion is tested.

`search_as_you_type` is a credible alternative, especially for short-title adjacent-word/order
signals. It adds shingle representations that this candidate query does not require. It does not
make whole-query bool_prefix AND become term-centric across name/body, nor does it independently
solve stemming/exact-phrase semantics. A manually indexed edge-ngram field also works with an
explicit fallback, but preserve_original alone leaves intermediate long prefixes missing.
[Search-as-you-type source](https://github.com/elastic/elasticsearch/blob/v8.16.0/docs/reference/mapping/types/search-as-you-type.asciidoc),
[edge-ngram limits](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-edgengram-tokenfilter.html).

The separate 201-document synthetic comparison measured these configurations. All use the same
source corpus. These are as-configured storage figures, not equal-gram-range efficiency ratios
or a forecast for real extraction data. The main mapping's offsets and attribute fields add
further costs beyond this minimal comparison. The unconditional bilingual row is a historical
comparison, not the current selective-language projection or its `_source` storage cost.

| Configuration | Inverted-index bytes | Long intermediate prefix found? |
| --- | ---: | --- |
| Plain unstemmed text | 59,194 | Yes, dictionary prefix query |
| Unstemmed + index_prefixes 1–5 | 109,142 | Yes, fallback |
| Historical unconditional English/French alternates | 226,414 | Yes, fallback |
| Unstemmed + manual edge field 1–20, preserve_original | 364,458 | No with match on that edge field |
| search_as_you_type with 2/3-word shingles | 619,841 | Yes, fallback |

**Compile text into required groups, with filters outside them.** For the combined example:

```text
FILTER tenant, current-readable scope, not-deleted, kind=file, mime_type=application/pdf
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
compile the resulting structure. A token may analyze to several components. The initial policy
keeps those components within its syntactic clause. Full multiword-synonym expansion would need
query-graph work. It is not implicitly supported by splitting whitespace. The Python parser is
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

**The application compiles modifiers into metadata filters.** The lexer/parser recognizes
syntax such as `type:pdf`. The query compiler resolves aliases and emits filters on stored fields.
Type categories live in an application registry of MIME values, so changing a category does not
require reindexing. The index stores `kind` and normalized `mime_type`, as listed in the
[original design](https://github.com/dust-tt/dust/blob/b37e616/dfs/design-docs/SEARCH.md#fields).
There is no derived `file_type` field.

Selected xattributes use a separate projection registry that specifies source key(s), byte
decoding, cardinality, normalization, ES destination, and supported operators. Producers may use
xattributes for most of this metadata. DFS MIME and kind already have native fields.
Unrecognized/binary/internal xattributes do not enter lexical search.

| Modifier | Destination/semantics |
| --- | --- |
| `type:pdf` | `kind=file` and `mime_type=application/pdf`. |
| `type:spreadsheet` | `kind=file` and a `terms` filter on the MIME values in the application category registry. |
| `type:folder` | kind=directory. |
| `mime:application/pdf` | Exact normalized MIME type/subtype. |
| `ext:pdf` | Explicit extension metadata. Separate from MIME-derived type. |
| `tag:"Réseau sécurité"` | Exact normalized whole tag, resolved from registered xattribute(s). |
| `owner:<id>`, `source:gdrive` | Exact registered metadata, with a user/alias-resolution layer if needed. |
| `before:2026-01-01`, `after:2026-01-01` | Typed modified_at range. Define UTC/date-zone boundaries consistently. |

The diagnostic category `spreadsheet` groups the XLS and XLSX MIME values. The application
registry will define the complete product categories. Missing or generic MIME does not silently
acquire a type from the filename. `ext:pdf` remains available as an explicit suffix filter. Any
future extension fallback belongs in query compilation and must preserve authoritative MIME
precedence. Dotfiles, version suffixes, compound extensions, and directories have explicit
extension-extraction rules. The diagnostic verifies that unknown MIME, a known text/plain type,
or directory kind cannot pass `type:pdf` because of a .pdf filename. Optional attribute
projections are absent when no registered producer value exists. Do not invent owners or sources.

**Prepare for LTR by retaining data and independent features, not by adding a model now.** Preserve
name/body/attribute BM25 features, whole-name equality, phrase/order matches, prefix-versus-word
match indicators, token counts, type/extraction state, and source/object modification timestamps.
These query-dependent match features should be computed for the query, not stored as stale
document scores. A future feature builder/reranker can consume the same parsed query and candidate
objects while the retrieval/filtering stage stays stable. The current mapping/query adds no
freshness boost or LTR model.

`name.token_count` counts tokens produced by `dfs_filename`, and `content_text.token_count` uses
`dfs_text`. These explicit numeric fields are optional inputs for later LTR. BM25 already has its
own internal length normalization, and the current query does not use these counts as boosts.

`mtime_ms` is an unsigned source value. `modified_at` is its validated date projection, omitted
when it is outside the supported date domain. The diagnostic indexes the maximum u64 with no
derived date successfully. Preserve source_modified_at separately when a connector supplies it.
Do not equate indexing time with content freshness. Use a fixed query-time reference and an
explicit missing/future-time policy when deriving age features. DFS reads do not update atime,
so it is not a popularity or last-viewed signal.
[DFS timestamp semantics](https://github.com/dust-tt/dust/blob/7f5fba70710c3e1cf7866aeeae97a8c40fa0a4fd/dfs/design-docs/VERSIONS.md).

LTR can only rerank retrieved candidates. Evaluate recall@K as well as top-page relevance, and
later retain candidate/features/query-version data for judged or interaction-based training.
Keep reranking behind an explicit boundary rather than promising that arbitrary existing
search_after/sort pagination will work unchanged. Native ES 8.16 rescore operates per shard,
has sort/window constraints, and native LTR model configuration requires Enterprise. The infra
proposal shows Basic. The mapping is also usable by an application reranker or another selected
implementation. These are future integration choices, not a request to add LTR today.
[Pinned LTR/rescore evidence](dfs-search-ranking-evidence.md).

**Subtree scope and access use separate ancestry and grant-eligibility fields.**

```text
foo              ALLOW g:engineering read
└── bar          DENY read
    └── folder123 ALLOW u:flav + g:finance read/write
        └── x.pdf
```

For `x.pdf`, using the example's top node as the root:

```json
{
  "object_id": "x_pdf_id",
  "ancestor_ids": ["foo_id", "bar_id", "folder123_id"],
  "read_grant_scope_ids": ["bar_id", "folder123_id", "x_pdf_id"]
}
```

`ancestor_ids` contains every physical ancestor from the real tenant root to the immediate parent,
excluding the indexed object itself. The tenant root has an empty ancestor list.
`read_grant_scope_ids` contains the object IDs where a direct READ grant could authorize this
object: itself and its ancestors through the closest ancestor-or-self carrying a read DENY,
including that DENY node. Without a read DENY, it contains all `ancestor_ids` plus `object_id`.
A read DENY on the object itself leaves only `object_id`. A write-only DENY does not truncate this
set. Include eligible object IDs even when no ALLOW is currently attached. No subjects or actual
grant records are copied into either array. Array order explains the projection. ES filters use
membership, not positional lookup. There is no separate `parent_id` field in the search mapping.

Resolve current direct ALLOW grants for the session's exact subjects, retaining only grants with
the read bit, then require at least one grant object ID in `read_grant_scope_ids`. Ordinary sessions with
no matching read-grant IDs get no candidates. A failed/incomplete grant lookup must not disable the
filter. Subtree search separately matches the requested folder ID against `ancestor_ids`, or
against `object_id` when the selected folder itself should also be eligible:

```json
{
  "bool": {
    "filter": [
      { "term": { "tenant_id": "tenant_id" } },
      { "term": { "is_deleted": false } },
      {
        "bool": {
          "should": [
            { "term": { "ancestor_ids": "foo_id" } },
            { "term": { "object_id": "foo_id" } }
          ],
          "minimum_should_match": 1
        }
      },
      { "terms": { "read_grant_scope_ids": ["folder123_id"] } }
    ]
  }
}
```

Finance can find `x.pdf` under `foo`, while Engineering's grant on `foo` does not cross the read DENY.
An ALLOW on `bar` itself would work, because local ALLOW is applied after local DENY. This agrees
with DFS's existing `(inherited & ~local_deny) | matching_local_allow` rule.
[Current permission evaluation](../../server/src/storage/resources/object/modes.rs).

Adding/removing an ordinary user/group ALLOW updates grant records and their subject lookup index.
It does not require updating descendants in ES. Moving a subtree or changing its closest read-DENY
boundary can require descendant updates. These costs are accepted. An inclusive scope uses the
`ancestor_ids` / `object_id` alternative above. Strict-descendant search uses only `ancestor_ids`.
Both remain separate from the mandatory grant filter, so matching the scope object itself does not
bypass access checks. Physical scope does not require an ALLOW on the scope node itself.

The ES membership query is a candidate prefilter. Before exposing any title, content, or excerpt,
deduplicate object IDs and check current permissions once per distinct object in DFS. Recheck current
physical scope as well when moves could leave stale indexed ancestry. Stale candidates may be removed
by these checks. Missing candidates after a move or DENY removal need index repair. Superusers bypass
only the grant prefilter, retaining tenant and requested-scope restrictions and existence checks.
The current subject-listing helper includes write-only ALLOWs, so it is not a ready-made read-grant
resolver. [Existing subject lookup](../../server/src/storage/resources/object.rs),
[shared listing](../../server/src/storage/resources/directory/shared.rs).

The validation harness exercises the example's membership/scope queries, explicit self inclusion,
strict ancestry, same-node ALLOW, any-grant matching, tenant isolation, and grant changes without
modifying the indexed ancestry or grant scopes. Selecting the object itself still enforces access.
It does not implement or validate the grant resolver, transactional rechecks, or durable subtree
reindexing. Attribute/extraction changes still need to publish a consistent complete projection.
Stale extraction text must not survive a content-version change.

**Deployment settings are selected by cell only.** `cell-00000` and `cell-00001` require
`workload=filesystem`. `cell-00002` has no workload allocation requirement. `--cell` / `CELL` has no
region fallback. Three primaries, one replica, and five-second refresh remain provisional production
settings. Capacity tests must use realistic extracted sizes, language mix, vocabulary, short-prefix
traffic, refresh/indexing rates, concurrent queries, and reindex headroom. The local fixture does not
establish p95 latency, final boosts, production ACL correctness, extraction completeness, or real
query relevance.
