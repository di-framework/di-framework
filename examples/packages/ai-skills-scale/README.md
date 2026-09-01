# Agent Skills scale example

An empirical large-catalog test for [`@di-framework/ai-utils`](../../../packages/di-framework-ai-utils). It measures the exact `Skill` tool description, can run live skill-selection trials at increasing catalog sizes, and tests build-time semantic retrieval with Transformers.js.

The baseline corpus is [`github/awesome-copilot`](https://github.com/github/awesome-copilot) at
commit `a80885b76044550770f60f360f8a0e5ae3524a31`. Fetching always checks out that commit rather
than following its default branch. The source tree contains 423 `SKILL.md` files; 408 pass strict
validation. [`corpora/awesome-copilot-408.json`](corpora/awesome-copilot-408.json) records the
revision and an aggregate SHA-256 over the sorted skill paths and Git blob IDs.

External skills are untrusted input. This example parses their metadata and instructions, sends only the generated discovery catalog to the model, and inspects the model's proposed `Skill` call without executing it. Skill bodies, bundled scripts, and referenced files never enter the live conversation.

## Fetch and measure

The fetch is opt-in and stored under the gitignored `.cache/` directory. It requires an authenticated [GitHub CLI](https://cli.github.com/).

```bash
bun run fetch
bun start
```

`bun start` is offline after the fetch. It reports discovered, accepted, and rejected skills plus the catalog size at 10, 50, 100, 250, and all accepted skills. The rough token estimate is characters divided by four; live provider usage is authoritative.

Use another local corpus with:

```bash
bun start -- --skills-dir /path/to/repository/skills --sizes 25,100,all
```

## Live selection trials

Live trials require `OPENAI_API_KEY` in the process environment or a gitignored `.env.secrets` file in this package or an ancestor directory. The env file is parsed as data and is never sourced as shell code. Trials guarantee that the expected target is present, add a deterministic sample of real distractors, record the proposed `Skill` command without executing it, and report provider prompt tokens for the selection request.

```bash
OPENAI_API_KEY=... bun run live
OPENAI_API_KEY=... bun run live -- --all-cases --trials 3 --sizes 10,50,100,250,all
```

Available cases are `pdf`, `postgres`, and `threat-model`. Set `OPENAI_MODEL` or pass `--model` to compare models. The default is `gpt-4o-mini`, matching the smaller Agent Skills example.

The benchmark intentionally filters invalid third-party entries one by one so it can report compatibility. Normal `SkillsToolbox` construction remains fail-closed.

## Recorded baseline

One run on 2026-08-14 used corpus commit `a80885b76044550770f60f360f8a0e5ae3524a31` and `gpt-4o-mini` with one trial per case and size:

- 423 `SKILL.md` files were discovered; 408 passed strict `ai-utils` validation and 15 were rejected for directory/name mismatches.
- The current name/description-only 408-skill tool description is 163,141 characters (40,786 rough characters/4 tokens). An earlier 177,545-character live catalog produced roughly 39,300 provider prompt tokens per selection request.
- The expected skill was the first choice in all 15 trials across catalog sizes 10, 50, 100, 250, and 408.
- PostgreSQL and threat-model cases proposed exactly one skill. The PDF case proposed additional conversion skills at every size because its unusually broad discovery description explicitly mentions sibling activation.

This is a smoke baseline, not a claim that hundreds of skills are universally reliable. Repeat trials, varied seeds, ambiguous prompts, and should-not-trigger cases are needed before choosing a production discovery strategy.

## Build-time semantic index

After fetching the corpus, build a local JSONL index and measure retrieval recall:

```bash
bun run index
bun run retrieve
```

`retrieve` now writes machine-readable `.cache/retrieval-results.json` and a human-readable
`.cache/retrieval-results.md`. Use repeated trials for any nondeterministic retrieval layer and
choose alternate destinations when comparing runs:

```bash
bun run retrieve -- --trials 3 --seed 42 --json .cache/run.json --markdown .cache/run.md
```

The report records recall@1/10, mean reciprocal rank, no-skill abstention and false-positive
rates, query-embedding/search/end-to-end latency, artifact size, and peak RSS. A zero value means
the measurement was not supplied by that run (for example, indexing time when evaluating an
already-built artifact).

The baseline command fails if the 30 labeled tasks regress below 29/30 recall@1 or 30/30
recall@10. Its historical 29/30 and 30/30 result remains a measured baseline, not a general claim.

## Extended 1,000- and 10,000-skill benchmark

The extended benchmark uses the CC-BY-4.0
[`mvaccargiu/gitskills`](https://huggingface.co/datasets/mvaccargiu/gitskills) dataset associated
with [GitSkills](https://arxiv.org/abs/2608.10906), pinned at revision
`289a292b3c6b175df1331f5ad2715673ba42dead`. The committed manifests record the source revision,
the aggregate hash/size/count of its 31 artifact Parquet shards, and the selection algorithm.
Large source shards, materialized skills, indexes, and results stay in gitignored `.cache/`.

Materialization is deliberately opt-in. It requires roughly 6.5 GB for source shards, additional
space for indexes, network access, and the `duckdb` CLI. Downloads are cached and every shard is
verified against its pinned LFS SHA-256. Valid, content-verified, deduplicated rows are ordered by
content hash/repository/path after a small, versioned set of labeled skills is pinned to the front.
This guarantees that every hard-query label exists in both subsets while the remaining distractors
are a hash-ordered sample. The 1,000-skill set is an exact prefix of the 10,000-skill set.

```bash
bun run materialize:gitskills -- corpora/gitskills-1000.json
bun run index -- --skills-dir .cache/gitskills-1000 --output .cache/gitskills-1000.jsonl
bun run retrieve -- \
  --index .cache/gitskills-1000.jsonl \
  --labels corpora/hard-cases.v1.json \
  --corpus-id gitskills-1000 \
  --corpus-revision 289a292b3c6b175df1331f5ad2715673ba42dead \
  --min-score 0.4 \
  --trials 3 \
  --json .cache/gitskills-1000-results.json \
  --markdown .cache/gitskills-1000-results.md
```

Repeat with `gitskills-10000.json` and separate output paths for the 10,000-skill run. The hard
labels include aliases/paraphrases, rare identifiers, misspellings, multilingual prompts,
ambiguous and multi-skill intents, long context, generic-description interference, and no-skill
requests. The score threshold is explicit because abstention cannot be measured if every query is
forced to return a candidate.

[`corpora/quality-targets.v1.json`](corpora/quality-targets.v1.json) versions the larger-suite
targets as pre-tuning expectations. It is intentionally marked `measuredResults: false`; only
generated JSON/Markdown reports describe measured runs. The tiny `ci-fixture.v1.json` exercises
the deterministic harness without downloading either real-world corpus.

`@di-framework/ai-utils` owns the generic skills-index API used by `di-framework skills index build` and `SkillsIndex.builder()`. This example keeps a thin custom wrapper only because its third-party benchmark corpus intentionally reports and skips incompatible entries; production indexing remains fail-closed.

The indexer uses `@huggingface/transformers` with a pinned [`onnx-community/bge-small-en-v1.5-ONNX`](https://huggingface.co/onnx-community/bge-small-en-v1.5-ONNX) revision, CLS pooling, the model's recommended query prefix, normalized 384-dimensional embeddings, and cosine similarity. The generated file stays under `.cache/` and is not committed. The package's normal `bun run build` invokes the same index step automatically when the fetched corpus is present; on a clean checkout it skips it.

The default count threshold is 50. At or below it, the artifact contains one metadata line and Transformers.js is never initialized. Above it, Transformers.js tokenizes each exact `SKILL.md` into 256-token chunks with 32-token overlap. Each JSONL skill record stores compact little-endian float32/base64 vectors; no chunk text is sent to the chat model.

At runtime, a skill score is 75% cosine against its first raw document chunk (which contains routing frontmatter) plus 25% cosine against its best chunk. Only the top 10 names/descriptions enter the `Skill` tool; a full body still loads only after activation. Re-running the build with unchanged source, chunking, and model metadata reuses the artifact without loading the model.

The recorded 408-skill build produced 4,558 chunks in 50.9 seconds and a 9,680,303-byte JSONL artifact. Across 30 hand-written cross-domain tasks, retrieval achieved 29/30 rank-1, 30/30 recall@10, and 0.9708 mean reciprocal rank. These are example-corpus measurements, not universal production guarantees.

## ANN compare (SQLite / HNSW)

Exact JSONL cosine remains the default. To index the same vectors into `BunSqliteVectorStore` via `SkillSearchIndexer` / `SkillSearchRepository` and compare ANN recall@10, latency, disk, and peak RSS:

```bash
bun run retrieve -- --compare --sqlite .cache/skills-ann.sqlite
bun run retrieve -- --backend sqlite --sqlite .cache/skills-ann.sqlite
```

Opt-in 10,000-skill runs use the existing gitskills materialization. A Transformers-free synthetic 100,000-skill catalog is:

```bash
bun run retrieve -- --synthetic 100000 --compare --sqlite .cache/synthetic-100k.sqlite
```

ANN vs exact is fail-closed: missing/corrupt graphs and incompatible formats raise errors instead of falling back to the full catalog. Prompts still receive only selected skill names and descriptions.
