# DFS object search: language detection and French analysis

2026-10-19. Research against upstream Google, Elasticsearch 8.16, and Lucene 9.12 sources.
This note refines the language-routing part of the [index proposal](dfs-object-search-revised-design.md).
It does not introduce a detector dependency or an ingestion implementation.

**Recommendation: detect language before populating optional stemmed fields, while keeping
every searchable value in its universal, unstemmed field.** One Elasticsearch document still
represents one original DFS object. Language is a property of text, not necessarily of the
whole object: an English filename can accompany a French body. Unknown text remains searchable.
It simply has no language-specific inflection expansion until we can classify it adequately.

**Detection and elision do different jobs.** A detector chooses the appropriate analysis chain.
French elision makes `l'avion` searchable as `avion` within the French chain. It neither detects
French nor replaces stemming. The current hand-copied article list is the standard Elastic/Lucene
French list, not an application-specific heuristic. Remove that duplication by referring to the
built-in `elision` filter. The Elasticsearch 8.16 preconfigured filter delegates to
`FrenchAnalyzer.DEFAULT_ARTICLES`, whose set is case-insensitive. There is no need to copy the
list to handle uppercase `L'`. [Elastic elision documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-elision-tokenfilter.html),
[preconfigured filter implementation](https://github.com/elastic/elasticsearch/blob/v8.16.0/modules/analysis-common/src/main/java/org/elasticsearch/analysis/common/CommonAnalysisPlugin.java#L499),
[Lucene French analyzer](https://github.com/apache/lucene/blob/releases/lucene/9.12.0/lucene/analysis/common/src/java/org/apache/lucene/analysis/fr/FrenchAnalyzer.java#L54).

That is different from declaring a new custom `type: elision` filter without articles, which
Elasticsearch rejects. Use the existing filter by name. Changing to `type: french` with disabled
stopwords is possible, but also changes the tokenizer to `standard` and removes the explicit ICU
folding pipeline. It is not a drop-in substitution for the current analyzer.
[Custom filter validation](https://github.com/elastic/elasticsearch/blob/v8.16.0/modules/analysis-common/src/main/java/org/elasticsearch/analysis/common/ElisionTokenFilterFactory.java#L28),
[language analyzers](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/analysis-lang-analyzer.html#french-analyzer).

The recorded ES validation does show `L’avion des sociétés` becoming `avion`, `des`, `societ` in
`dfs_text_fr`. No nondeterministic failure of that chain was demonstrated. Lucene's elision filter
recognizes straight apostrophe U+0027 and right apostrophe U+2019, not every Unicode quote-like
character. An upstream detector cannot repair such token normalization gaps. Any change to order
ICU folding before elision should be checked on uppercase, straight/right/left apostrophes, NFC/NFD,
and stems. The universal field already has its independent apostrophe-boundary rule for phrase and
prefix semantics. [Recorded analyzer results](dfs-object-search-validation-results.json),
[Lucene elision implementation](https://github.com/apache/lucene/blob/releases/lucene/9.12.0/lucene/analysis/common/src/java/org/apache/lucene/analysis/util/ElisionFilter.java#L55).

**Google CLD3 is feasible, but it is not a maintained dependency to adopt blindly.** Google's
CLD3 repository was archived on June 15, 2024. Its C++ model supports English and French and runs
locally. Model inference uses character n-grams. Google's package also includes Python bindings.
The reviewed Rust `cld3` crate is a community C++ bridge, not an official Google Rust API.
[Google CLD3](https://github.com/google/cld3),
[Google Python binding/build](https://github.com/google/cld3/blob/master/setup.py),
[Rust crate source](https://github.com/ttys3/cld3-rs).

The Rust crate's latest published version observed was 0.1.1 from June 2023. It builds bundled
C++ through `cxx`, links `libprotobuf`, and its published documentation build failed. That does
not prove the crate unusable, but Linux/macOS builds, protobuf compatibility, and the FFI boundary
need verification before adopting it. The reviewed bridge exposes language, probability,
reliability, and proportion. It does not expose upstream byte ranges.
[Published crate](https://docs.rs/crate/cld3/0.1.1),
[build script](https://github.com/ttys3/cld3-rs/blob/main/build.rs),
[result bridge](https://github.com/ttys3/cld3-rs/blob/main/cld3_wrapper.cc).

CLD3's defaults and result meanings impose concrete constraints:

| Property | Verified behavior and consequence |
| --- | --- |
| Minimum text | The default minimum is 140 processed bytes. Most filenames fall below it. Setting the minimum to zero permits a prediction, not a guarantee of short-text accuracy. |
| Sampling | Defaults consider up to 700 selected bytes from at most the first 10,000 input bytes. A long document's later language changes can be missed. |
| `probability` | Model output confidence. It is not a measured error probability on DFS filenames, OCR, or queries. |
| `is_reliable` | For English/French, a fixed probability threshold of 0.7. Upstream reports tuning on Wikipedia segments, not filenames. |
| `proportion` | `FindLanguage` sets it to 1 for a prediction. That does not establish monolingual content. The top-N API computes byte shares over classified script spans. |
| Top-N segmentation | It splits by script. English and French are both Latin, so top-N is not a general English/French language-span segmenter. |

[CLD3 implementation](https://github.com/google/cld3/blob/master/src/nnet_language_identifier.cc#L85),
[CLD3 API and reliability documentation](https://github.com/google/cld3/blob/master/src/nnet_language_identifier.h#L53).

An isolated local probe built Google's unmodified detection implementation at commit
[`b48dc46512566f5a2d41118c8c1116c4f96dc661`](https://github.com/google/cld3/tree/b48dc46512566f5a2d41118c8c1116c4f96dc661)
with C++17 and protobuf 36.2.0 on macOS arm64. No repository dependency was added. This establishes
native feasibility on this machine, not Rust-crate or production-image compatibility. Eighteen
handwritten inputs were passed to both `FindLanguage` and `FindTopNMostFreqLangs(text, 3)` with
`max_num_bytes=700`, once with `min_num_bytes=0` and once with the default minimum of 140.

| Input | Result with minimum 0 | Probability | Reliable flag |
| --- | --- | ---: | --- |
| `repo` | Italian (`it`) | 1.0000 | true |
| `report an` | Luxembourgish (`lb`) | 0.7284 | true |
| `Reports.pdf` | Haitian (`ht`) | 0.2880 | false |
| `Reports` | English (`en`) | 0.9385 | true |
| `Journaux.pdf` | Polish (`pl`) | 0.9052 | true |
| `Journaux` | Serbian (`sr`) | 0.4918 | false |
| `report année 2026` | French (`fr`) | 0.7042 | true |
| `rapport année 2026` | French (`fr`) | 0.9963 | true |
| `API_v2_final.pdf` | Portuguese (`pt`) | 0.8175 | true |
| `2026-01-02.pdf` | Ukrainian (`uk`) | 0.9346 | true |
| English paragraph below | English (`en`) | 1.0000 rounded | true |
| French paragraph below | French (`fr`) | 1.0000 rounded | true |
| Both paragraphs together | French (`fr`) only | 0.8652 | true |

With the default minimum, every listed short input returned `und`. Paragraph results were
unchanged. The combined paragraphs produced only French with `proportion=1.0` in the top-N result,
whether separated by a space or a blank line. Exact reproduction inputs:

```text
This report describes the new project and the results of our recent experiments. The team expects to complete the remaining work next week, after reviewing the budget and the risks.

Ce rapport présente les résultats de notre projet et les prochaines étapes prévues pour notre équipe. Nous allons examiner les documents et les chiffres avant de prendre une décision collective.
```

These are counterexamples to treating a reliable flag as a filename or mixed-language guarantee,
not an accuracy benchmark. `Reports.pdf` versus `Reports` also shows why detector preprocessing
deserves evaluation: stripping a known extension for the detector input can help while leaving
the actual filename intact in Elasticsearch. It does not make ambiguous names reliable.

Reproduction loop, linked against the pinned upstream implementation and its generated protobuf
sources. `english` and `french` are the two paragraphs printed above. Output columns are minimum
bytes, sample index, language, probability, reliability, proportion, and the three top-N results:

```cpp
std::vector<std::string> samples = {
    "repo", "report an", "Reports.pdf", "Reports", "report annee 2026",
    "Journaux.pdf", "rapport année 2026", "Les journaux des sociétés.",
    "L’avion est prêt.", "budget", "API_v2_final.pdf", "2026-01-02.pdf",
    english, french, english + " " + french, english + "\n\n" + french,
    "Journaux", "report année 2026"
};
std::cout << std::setprecision(8);
for (int minimum : {0, 140}) {
    chrome_lang_id::NNetLanguageIdentifier detector(minimum, 700);
    for (size_t i = 0; i < samples.size(); ++i) {
        const auto result = detector.FindLanguage(samples[i]);
        std::cout << minimum << '\t' << i << '\t' << result.language
                  << '\t' << result.probability << '\t' << result.is_reliable
                  << '\t' << result.proportion;
        for (const auto& language : detector.FindTopNMostFreqLangs(samples[i], 3)) {
            std::cout << '\t' << language.language << ':' << language.probability
                      << ':' << language.is_reliable << ':' << language.proportion;
        }
        std::cout << '\n';
    }
}
```

Google also offers a current MediaPipe Language Detector using a 315 KB model with 110 language
labels. The published integration guides cover Android, iOS, Python, and Web, not a ready-made
Rust interface. Its model card explicitly excludes reliable multilingual segmentation: the
predictions need not include every language or even rank the dominant language first. A top-N
score list must not be treated as language proportions or as text ranges. This is an alternative
Google runtime/model to evaluate, not evidence that routing mixed documents is solved.
[Google guide](https://developers.google.com/edge/mediapipe/solutions/text/language_detector),
[Google model card](https://storage.googleapis.com/mediapipe-assets/LanguageDetector%20Model%20Card.pdf).

**Use explicit fields for selective indexing.** Elasticsearch multi-fields automatically analyze
the same source value in every configured representation. They cannot condition `.en` or `.fr`
on a per-document detector result. Real source properties make that decision possible in the
projection. [Elasticsearch multi-fields](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/multi-fields.html).

Recommended structure, with only the supported `en` and `fr` objects declared in a strict mapping:

```text
name, name.parts, name.keyword, name.folded
content_text
attributes.title, attributes.description, attributes.tags

stemmed.en.name
stemmed.en.content_text
stemmed.en.attributes.title / description / tags
stemmed.fr.name
stemmed.fr.content_text
stemmed.fr.attributes.title / description / tags
```

The first group retains every original value and the existing unstemmed phrase/prefix analysis.
The `stemmed` fields contain original text selected by the projection, analyzed with the relevant
language chain. The application should not send pre-stemmed tokens. Name fields retain their
filename-component tokenization. Language groups are ordinary objects, not `nested` documents.
Separating each logical field preserves independent boosts and future LTR signals.

Recommended projection policy, to implement with ingestion:

1. Detect each substantive logical field independently. Do not silently inherit a French body's
   classification for an English filename, short title, or individual tag.
2. Accept a supported language only after a chosen detector and thresholds have been evaluated on
   our data. The detector's `is_reliable` flag is evidence, not the complete acceptance policy.
   Do not force unsupported or unknown languages into English/French.
3. A confidently classified field can populate its one stemmed language field. Uncertain, short,
   code-like, or unsupported text stays only in its universal field. This deliberately sacrifices
   some stemming recall, including potentially a short `Reports.pdf` title, while preserving
   literal/prefix recall. Do not describe that tradeoff as unchanged stemming coverage.
4. For a mixed body, route independently classified paragraphs or extraction blocks only after
   validating segmentation and thresholds. Each accepted segment goes to one language field.
   Uncertain segments stay neutral. Until then, use the complete neutral body instead of stamping
   one winner's language on all text. Code switching within a paragraph remains a limitation.
5. Keep model/version and projection-policy provenance with indexing diagnostics so classification
   can be reproduced and changed by reindexing. A detector failure should retain neutral search.

Explicit fields duplicate their selected text in `_source`, unlike automatic multi-fields. This
is an intentional storage tradeoff. Measure it with representative extraction sizes. Avoid
excluding derived source fields merely to hide the cost without a reindex and highlighting plan.

**Query language must not become a hard recall gate.** Completed word clauses can use `dis_max`
over the universal representation and both supported language fields, with each field's own
analyzer. Require each clause once, not a whole-query AND within each language or field. An
English name and French body can then jointly satisfy `report société`. Query-time guesses on
short or incomplete words must not exclude one branch. Prefix expansion remains on the universal
fields. `report an` can match `report année 2026` without language detection. Quotes remain
unstemmed, ordered, same-field/value phrases. These are proposed query rules consistent with the
existing requirements, not a parser implementation.

If body language fields contain selected segments, their offsets and lengths differ from the
complete universal body. Do not merge such fields into the root highlighter's `matched_fields`
as though they held byte-identical text. Neutral highlighting can serve the baseline. Highlighting
stem-only matches in partial language segments requires an explicit source-offset mapping or a
separate segment highlight path. Likewise, partial-field BM25 lengths are not whole-body length
features for LTR. Elastic explicitly warns that combining differently sourced strings can produce
nonsensical highlights or fail the query. [Highlighting documentation](https://www.elastic.co/guide/en/elasticsearch/reference/8.16/highlighting.html#combine-matches-on-multiple-fields).

[Full isolated probe results](dfs-language-detection-probe-results.json) preserve every input,
minimum-length setting, and detector output. These synthetic cases demonstrate failure modes.
They are not an accuracy benchmark on the DFS corpus.

**What remains unproven:** detector quality on real English/French filenames and documents,
thresholds for short fields, OCR, and multilingual paragraphs, deployment build compatibility,
language-change recall, indexing size/cost, and relevance after selective stemming. The schema can
support the policy now. Selecting and integrating a detector belongs with the projection work and
must include labeled routing cases and search-recall evaluation. Neither Google's brand nor the
existing synthetic Elasticsearch checks establishes those properties.
