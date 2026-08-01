# ConceptNet Numberbatch for ask relevance — evaluation and integration path

## What it is

[ConceptNet Numberbatch](https://github.com/commonsense/conceptnet-numberbatch)
is a set of precomputed word vectors (300-dim) built by retrofitting
word2vec/GloVe embeddings with the ConceptNet knowledge graph. The
English-only text distribution covers ~500k terms. Lookup is a hash-map read —
effectively free compared to running the local ONNX sentence-embedding model
per node (`engine/embeddings.ts`), which is why it is attractive for "more
local vectors, much quicker".

## Honest fit assessment

**Strengths**
- Word-level relatedness is exactly the gap our static lexicon fills by hand:
  `payment ↔ billing/invoice/checkout` style neighborhoods come out of the box.
- Zero inference cost; deterministic (fixed released matrix, versioned
  releases, e.g. 19.08).
- Strong on common nouns/verbs — the vocabulary intent questions are made of.

**Limits**
- **Not contextual**: one vector per word. `charge` (payments) and `charge`
  (battery) share a vector; our contextual MiniLM path is strictly better at
  disambiguating full questions. Numberbatch complements, not replaces, it.
- **Identifiers are out-of-vocabulary**: `createSepaMandate` needs camelCase
  splitting and part-vector averaging (we already have `identifierParts`).
  Brand/product tokens (`stripe`, `bacs`) are sparse or missing — the
  hand-curated lexicon remains authoritative for those.
- **Size**: English text file ≈ 1–2 GB uncompressed (~300 MB gz). Not
  shippable in the npm package; must stay a dev-time or opt-in artifact.
- **License**: CC-BY-SA 4.0 (share-alike). Bundling the matrix into the
  Apache-2.0 `@vibgrate/cli` package is a licensing conflict. Facts (word
  relatedness) are not copyrightable, but the embedding file itself is — so we
  never redistribute it.

## Decision

1. **Primary (implemented): build-time lexicon candidate generation.**
   `bench/numberbatch-lexicon.mjs` streams a locally downloaded Numberbatch
   file and proposes CONCEPTS/BIGRAM additions (nearest neighbors for each
   lexicon key, filtered to identifier-plausible words) as JSON for human
   review. Reviewed entries are hand-edited into `engine/concepts.ts`. Runtime
   stays deterministic, pinnable, tiny, and Apache-2.0-clean; Numberbatch
   never ships.

2. **Possible follow-up (not implemented): opt-in runtime term-relatedness.**
   A `numberbatch` backend behind the existing `Embedder` interface for
   `--semantic`, using part-averaged word vectors as a cheap first stage
   before (or instead of) MiniLM on very large graphs. Requires an opt-in
   download flow like the current local model, a subset-extraction step (keep
   only graph-vocabulary rows, shrinking 1–2 GB to a few MB per repo), and a
   licensing note in the download prompt. Do this only if `--semantic` latency
   on big graphs becomes a real complaint — the lexical + lexicon path already
   carries the quality gate at 100%.

## Usage

```
# one-time, dev machine (any recent release; 19.08 is the stable classic):
curl -LO https://conceptnet.s3.amazonaws.com/downloads/2019/numberbatch/numberbatch-en-19.08.txt.gz

# propose neighbors for every lexicon key:
pnpm --filter @vibgrate/cli-public exec node bench/numberbatch-lexicon.mjs \
  --file numberbatch-en-19.08.txt.gz --top 8 > lexicon-candidates.json

# or for specific terms:
… numberbatch-lexicon.mjs --file … --terms payment,booking,mainframe
```

Review `lexicon-candidates.json`, keep the words a maintainer would plausibly
put in an identifier or directory name, and edit them into
`engine/concepts.ts` — the ask-quality gate then holds the result to 100%.
