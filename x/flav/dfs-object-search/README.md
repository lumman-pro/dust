# DFS object search

**Status: schema and bootstrap implemented. Application indexing and search remain to build.**
Research targets Elasticsearch 8.16.0 with `analysis-icu`. Production code lives in
[the DFS search module](../../../dfs/server/src/search.rs). The
[reviewer guide](../../../dfs/server/src/search/README.md) follows one file through the fields,
explains every analyzer, and includes the creation commands.
This directory holds personal research and reproducible probes.

| Decision | Proposal |
| --- | --- |
| Entity | One ES document per original DFS object, including its extracted text |
| Index | Alias `dfs.objects`, physical index `dfs.objects_1`, `dynamic: strict` |
| Routing | Required `routing=tenant_id`, compound tenant/object `_id`, explicit tenant filter |
| Text | Separate name, content, and selected attributes with neutral and optional language representations |
| Completion | Prefix matching on the active unquoted word, accelerated by `index_prefixes` |
| Ranking | Independent field signals for later LTR. No production weights or freshness boosts |
| Placement | Filesystem nodes in `cell-00000` and `cell-00001`, shared nodes in `cell-00002` |
| Sizing | 100 primaries in the large cells, 10 in `cell-00002`, one replica. [Tenant routing](sharding.md) reaches ten physical shards in every production cell |

The executable [mapping](../../../dfs/server/src/search/indices/objects_1.mappings.json)
and [per-cell settings](../../../dfs/server/src/search/indices) are the source of truth.
Settings use a five-second refresh. Local settings use one primary and no replica.
The sizing target is 100 GB per primary in 6–12 months, with benchmarks at 120 GB.
Search latency, recovery, and prefix storage still need representative measurements before rollout.

**Search behavior**

| Input | Intended match |
| --- | --- |
| `repo` while typing | `Reports.pdf`, reports in content, or reports in selected attributes |
| `report an` while typing | `report année 2026` |
| `A B` | Both words on the object, including A in its name and B in its content |
| `"annual reports"` | Adjacent, ordered, unstemmed tokens in one field/value |
| `"report"` | The complete token, without prefix or stem expansion |
| `employee request` | Employees in an English name and requested in English content |
| `journal société` | Journaux and sociétés in text accepted for French stemming |
| `type:pdf "annual reports" budg` | PDF metadata, the quoted phrase, and the active budget prefix |
| `tag:"Réseau sécurité"` | Equality on the normalized complete tag |
| `filename:"Literal-v1.2.PDF"` | Equality on the normalized complete basename, preserving punctuation |

Quotes are exact after case/accent normalization and tokenization, not byte-exact substrings.
They cannot assemble a phrase across a name and body or across separate array values.
Symbolic strings such as C++ and C# are not distinguished by ordinary prose analysis.
Whole-name identity remains available through `name.keyword`.

**Text representations**

| Fields | Purpose |
| --- | --- |
| `name` | Whole filename components, with punctuation boundaries and prefix acceleration |
| `name.parts` | Additional CamelCase components, indexed separately |
| `name.keyword`, `name.folded` | Raw and normalized complete-name equality |
| `content_text` | Full neutral extracted/native text, including phrase positions and offsets |
| `attributes.title`, `attributes.description` | Selected searchable text |
| `attributes.tags` | Normalized keyword array plus `.text` for lexical matching |
| `stemmed.en`, `stemmed.fr` | Explicit source fields for accepted English/French names, content, and attributes |
| `name.token_count`, `content_text.token_count` | Numeric length features available for future LTR |

`AnnualReports.pdf` produces `annualreports` and `pdf` in `name`, and `annual`,
`reports`, and `pdf` in `name.parts`. Query boundaries do not depend on capitalization.
Extensions remain in source and analyzed tokens. `uax_url_email` does not remove them.
Type filtering uses metadata rather than guessing from suffix tokens.

All text first receives NFKC normalization. Neutral analysis uses ICU tokenization
and folding, without stemming or stop-word removal. Dots and underscores separate filename
components. Apostrophes separate neutral words so `avio` can find `l’avion` and `reill`
can find `O’Reilly`. Quoted phrases still require the complete analyzed sequence.

English alternates use possessive normalization and Porter2. French alternates use the
built-in `elision` filter and `light_french`. Filename component analysis also handles
CamelCase during indexing. Each text analyzer ends with a length filter that drops whole
tokens above 8,191 UTF-16 units after folding/stemming, preserving the original `_source`.
NFKC before tokenization prevents compatibility-character expansion from creating immense terms.
Optional normalized keywords need projection validation against the 32,766-byte UTF-8 term limit
after folding. Oversized optional tags should be omitted with a diagnostic, never truncated.
[ICU normalization](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-icu-normalization-charfilter),
[stemmer choices](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-stemmer-tokenfilter.html).

Keep English and French in the same index. Neutral fields always contain the original text.
Detect substantive fields independently and populate only the accepted language fields.
Unknown or short text keeps neutral search. Do not infer a name's language from its body.
Mixed content needs validated segmentation, with independent highlights for language segments.
Language detection is not implemented. [Detector evidence and limitations](language-detection.md)
explain why CLD3 confidence alone is insufficient, especially for short names.

**Query construction**

Compile each word into a required group of field alternatives. A word may match the name,
content, or an allowed attribute. A different word may match another field on the same object.
Use neutral and populated language representations as alternatives, preserving field scores.
Sending the complete query to `best_fields` with AND would incorrectly require all words in one field.

Only the active positive unquoted word gets a prefix alternative. Completed words retain
whole-word and stem matching. Quotes use neutral `match_phrase` at zero slop.
`index_prefixes` accelerates names/titles at 1–10 characters and content/description/tags at 1–5.
Longer prefixes fall back to the full term dictionary, preserving recall. That fallback needs
`search.allow_expensive_queries=true`, so query cost must be measured before rollout.
The mapping harness checks prefix behavior, including long and supplementary-character inputs.
[Prefix mapping](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/index-prefixes.html).

The application lexer/parser will preserve quoted clauses and typing state, resolve known
modifiers, and compile ES queries. The Python harness is a fixture tool, not that implementation.
For `type:pdf "annual reports" budg`, the structure is:

```text
FILTER tenant, readable scope, not deleted, kind=file, mime_type=application/pdf
AND PHRASE("annual reports", in one neutral field/value)
AND WORD_OR_STEM_OR_PREFIX("budg", in any searchable field)
```

Type categories belong to an application MIME registry. `type:pdf` uses `kind` and `mime_type`,
`type:folder` uses `kind=directory`, and `ext:pdf` separately filters `extension`.
There is no `file_type` field. Selected xattributes need a producer registry defining decoding,
normalization, cardinality, and destination. Arbitrary binary xattributes do not enter text search.
`xattr_names` and `xattr_pair_hashes` support separate raw existence/equality predicates.

There is no catch-all field. Name/body/attribute scores, exact-name matches, phrase and prefix
matches, token counts, and timestamps remain available for a future feature builder and reranker.
The harness uses illustrative weights only. It does not select production weights.
LTR cannot recover missing candidates, so future evaluation must include recall as well as ranking.

**Scope and access**

`ancestor_ids` contains all physical ancestors, excluding self. `read_grant_ancestor_ids` contains
ancestors through the closest read-DENY ancestor, inclusive, also excluding self. A read-DENY on
the object makes this second list empty. A write-only DENY does not truncate it. The IDs describe
where an inherited READ grant could apply, independently of current subjects or grant records.

```text
foo              ALLOW engineering read
└── bar          DENY read
    └── folder123 ALLOW finance read
        └── x.pdf

ancestor_ids            = [foo, bar, folder123]
read_grant_ancestor_ids = [bar, folder123]
```

Resolve the session's current direct READ grants, then require a match on `object_id` or an
intersection with `read_grant_ancestor_ids`. A direct grant on the object still works when its
ancestor list is empty, including at the tenant root. Finance can find x under foo.
Engineering's grant on foo cannot cross bar.
Local ALLOW on bar can still authorize descendants. An empty or failed grant lookup must not
remove the access filter. Subtree filtering independently matches `ancestor_ids`, with an
`object_id` alternative when the selected object itself is included.

Ordinary grant changes do not rewrite descendants. Moves and read-DENY changes may do so.
Recheck current permissions once per distinct object before returning any title, content, or excerpt.
Recheck requested scope after moves. Indexed access IDs are candidate filters, not authorization.
Tenant routing is also an optimization, not authorization. Every document operation and bulk item
uses the correct tenant routing, and every tenant search retains its explicit tenant filter.

**Storage and remaining work**

FDB's 64 KiB blocks are storage units, not search chunks. Extracted text belongs to the original
object's result. The [original DD comparison](dd-comparison.md) records field changes and an open
provenance question: the later extraction design uses private generations rather than objects.
Resolve that lifecycle before implementing projection.

Preserve unsigned source timestamps and validate derived `modified_at`/`created_at` dates.
Keep connector modification time separate. `ctime_ms` is not creation time, and DFS reads do not
update `atime_ms`. Neither indexing time nor read time is a freshness/popularity shortcut.
There is no `projected_at` field.

Next implementation work is object projection, durable indexing/extraction, language detection
and calibration, the xattribute registry, current authorization checks, and the query compiler.
Use the [GCS inventory tool](gcs-corpus-stats.md) to measure stored counts and bytes before sizing.
It does not determine unique live DFS objects or extracted-text size.

**Validation**

[validate_mapping.py](validate_mapping.py) loads the actual mapping and local settings into a
disposable ES 8.16.0 + ICU cluster named `codex-dfs-search-analysis` at `127.0.0.1:19217`.
It exercises 153 text fixtures, 4 routing fixtures, 95 checks, and five prefix mechanism variants.
Run from the repository root:

```sh
python3 x/flav/dfs-object-search/validate_mapping.py
python3 x/flav/dfs-object-search/validate_routing.py
```

Generated output lives in ignored `artifacts/validation-results.json`. Fixtures validate mechanics,
not classifier accuracy, production relevance, or capacity. The existing five Rust bootstrap tests
cover cell allocation, offline preview, creation failures, and index/alias preservation.
The separate routing probe loads all three production cell settings and the real mapping.
It checks 256 tenant keys per cell, document placement, and routed reads, updates, and deletes.
It also checks every routing residue and signed-overflow case in the ES 8.16 formula.
Only node placement and replica count are adjusted for the disposable single-node cluster.
See [sharding.md](sharding.md) for the results and limits of these checks.
Raw research dumps and superseded proposals remain recoverable from
[the pre-cleanup commit](https://github.com/dust-tt/dust/tree/53d914b83c08ddfc8599480f9f2b9852cd608275/dfs/design-docs/search).
