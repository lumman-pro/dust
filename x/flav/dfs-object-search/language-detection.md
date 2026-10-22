# Language selection

**Decision: one index, neutral text always, optional English/French fields after detection.**
No detector is integrated yet. Classification, thresholds, and mixed-language handling still
need evaluation on actual filenames and extracted content.

Detection and analysis solve different problems. A detector can label text French.
The analyzer still needs to turn `l'avion` into `avion` for stemming. Use Elasticsearch's
built-in `elision` filter with `light_french`, without a copied article list. Neutral fields
keep apostrophe-separated words for prefix and phrase behavior.
[Elision documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-elision-tokenfilter.html),
[8.16 built-in filter](https://github.com/elastic/elasticsearch/blob/v8.16.0/modules/analysis-common/src/main/java/org/elasticsearch/analysis/common/CommonAnalysisPlugin.java#L499).

Multi-fields always analyze the same source value. They cannot conditionally enable a language
based on detection. Explicit `stemmed.en` and `stemmed.fr` source fields let the projection supply
only accepted text. The complete original remains in the neutral field. This duplicates selected
text in `_source`, so measure the resulting storage cost.
[Multi-field behavior](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/multi-fields.html).

**CLD3 is a candidate, not a settled dependency.** Google's repository is archived. The probe
used revision `b48dc46512566f5a2d41118c8c1116c4f96dc661`. Its default minimum is 140 processed
bytes, which excludes most filenames. Disabling that minimum produces confident short-input
errors, including these observed predictions:

| Input | Prediction | Reported reliable |
| --- | --- | --- |
| `repo` | Italian, probability 1.0 | Yes |
| `report an` | Luxembourgish, probability 0.7284 | Yes |
| `Journaux.pdf` | Polish, probability 0.9052 | Yes |

The defaults instead classify these short inputs as undetermined. Model confidence is not
evidence of accuracy on our domain.
[Pinned CLD3 source](https://github.com/google/cld3/tree/b48dc46512566f5a2d41118c8c1116c4f96dc661),
[recorded probe results](https://github.com/dust-tt/dust/blob/53d914b83c08ddfc8599480f9f2b9852cd608275/dfs/design-docs/search/dfs-language-detection-probe-results.json).

CLD3 samples up to 700 bytes from an initial 10,000-byte window by default. Later language changes
can be missed. Its top-N function groups by script, not general language segments, so English and
French paragraphs can be merged. One mixed probe returned French alone with proportion 1.0.
That is not proof the complete document is French.
[Identifier defaults](https://github.com/google/cld3/blob/b48dc46512566f5a2d41118c8c1116c4f96dc661/src/nnet_language_identifier.h#L53),
[sampling and top-N implementation](https://github.com/google/cld3/blob/b48dc46512566f5a2d41118c8c1116c4f96dc661/src/nnet_language_identifier.cc#L85).

Detect each substantive logical field independently. An English name and French body can
populate different language groups. Do not borrow the body's language for a short name or tag.
Unknown, unsupported, or failed classifications retain neutral search without stemming.
Evaluate the lost inflection recall explicitly before choosing a confidence policy.

For mixed content, classify paragraphs or extraction blocks only after validating the segmentation
and minimum-length policy. Preserve the complete neutral body. Each language segment has its own
offset space, so highlight those fields independently. Do not merge segment offsets into the full
body with `matched_fields`.
[Highlighting constraints](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/highlighting.html#combine-matches-on-multiple-fields).

Queries consider neutral and both language branches. A short query must not choose only one
language. Quotes and prefixes use neutral fields, while completed words may use stemmed branches.
The mapping harness labels fixtures explicitly and tests analysis, not detection accuracy.

Before integration, choose and pin the model/runtime, benchmark classification and latency,
calibrate thresholds, and record detector provenance for repeatable rebuilds. Google's MediaPipe
[language detector model card](https://storage.googleapis.com/mediapipe-assets/LanguageDetector%20Model%20Card.pdf)
is another candidate to evaluate. A Google library alone does not resolve the short-text or
mixed-language limitations.
