# DFS object search review

2026-10-19. Reviewed `aafa1435cfc93a833f632f6bafa4fa2d10e7348e` against primary sources and Elasticsearch 8.16.0 + ICU probes.

**Status: the two mapping defects are fixed.** The [active definitions](../../server/src/search/indices/objects_1.mappings.json) pass [83 checks on 151 synthetic objects](dfs-object-search-validation-results.json). Production query weights, relevance, and capacity remain unvalidated.

| Defect | Before | Now |
| --- | --- | --- |
| Filename recall depends on query casing | `AnnualReports budget` finds `AnnualReports.pdf` with Budget in its body. `annualreports budget` misses it. Quotes also differ. | `name` retains whole filename components, `name.parts` adds CamelCase components, and queries use case-independent boundaries. All three casing variants have identical matches and scores for completed, quoted, and interactive queries. |
| Unicode folding rejects the complete object | A valid 3,300-byte body of repeated U+FDFA characters becomes one oversized term and returns HTTP 400. | NFKC runs before tokenization, exposing ordinary word boundaries. The body indexes and remains searchable in neutral, English, and French representations. A final length guard omits pathological oversized tokens without truncation. Original source and highlight offsets are verified. |

The fixes follow [word delimiter behavior](https://www.elastic.co/docs/reference/text-analysis/analysis-word-delimiter-graph-tokenfilter), [ICU character normalization](https://www.elastic.co/docs/reference/elasticsearch/plugins/analysis-icu-normalization-charfilter), and [whole-token length filtering](https://www.elastic.co/docs/reference/text-analysis/analysis-length-tokenfilter). No additional indexed field was needed.

**Keyword boundary.** Optional tags still require validation in the future projection. Measure their full UTF-8 length after normalization and omit an oversized optional tag with a diagnostic. Do not truncate equality values. Raw `ignore_above` is insufficient because [normalization runs after that check](https://github.com/elastic/elasticsearch/blob/v8.16.0/server/src/main/java/org/elasticsearch/index/mapper/KeywordFieldMapper.java#L941). The text fix does not implement that producer validation.

**Ranking is deferred.** The illustrative query can rank a partial name/body match above a complete filename. No production query or weights are shipped here, and these fixes do not tune ranking. Decide exact-name priority and measure recall before adding LTR. Apostrophes in quotes compare normalized word sequences. Filename possessive/elision behavior still differs from prose and needs an explicit application policy.

**Other evidence.** End-of-body highlighting passed on 1,200,035 characters for a word, a short prefix, and a long prefix. Long prefixes still depend on expensive queries being enabled. Body prefix cost, duplicated language source, shard sizing, and real-corpus ranking require measurements. The [DD comparison](dfs-object-search-dd-comparison.md) records routing and extraction-provenance decisions that remain open.
