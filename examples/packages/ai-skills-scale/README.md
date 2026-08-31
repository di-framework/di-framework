# Agent Skills scale example

An empirical large-catalog test for [`@di-framework/ai-utils`](../../../packages/di-framework-ai-utils). It measures the exact `Skill` tool description, can run live skill-selection trials at increasing catalog sizes, and tests build-time semantic retrieval with Transformers.js.

The corpus is [`github/awesome-copilot`](https://github.com/github/awesome-copilot), selected by searching GitHub repositories with `gh` ordered by stars and then counting actual `SKILL.md` files. It contains hundreds of real skills while remaining smaller and easier to inspect than mirrored multi-thousand-skill collections.

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

`@di-framework/ai-utils` owns the generic `di-skills-index` build CLI and `SkillsIndex.builder()` API. This example keeps a thin custom wrapper only because its third-party benchmark corpus intentionally reports and skips incompatible entries; production indexing remains fail-closed.

The indexer uses `@huggingface/transformers` with a pinned [`onnx-community/bge-small-en-v1.5-ONNX`](https://huggingface.co/onnx-community/bge-small-en-v1.5-ONNX) revision, CLS pooling, the model's recommended query prefix, normalized 384-dimensional embeddings, and cosine similarity. The generated file stays under `.cache/` and is not committed. The package's normal `bun run build` invokes the same index step automatically when the fetched corpus is present; on a clean checkout it skips it.

The default count threshold is 50. At or below it, the artifact contains one metadata line and Transformers.js is never initialized. Above it, Transformers.js tokenizes each exact `SKILL.md` into 256-token chunks with 32-token overlap. Each JSONL skill record stores compact little-endian float32/base64 vectors; no chunk text is sent to the chat model.

At runtime, a skill score is 75% cosine against its first raw document chunk (which contains routing frontmatter) plus 25% cosine against its best chunk. Only the top 10 names/descriptions enter the `Skill` tool; a full body still loads only after activation. Re-running the build with unchanged source, chunking, and model metadata reuses the artifact without loading the model.

The recorded 408-skill build produced 4,558 chunks in 50.9 seconds and a 9,680,303-byte JSONL artifact. Across 30 hand-written cross-domain tasks, retrieval achieved 29/30 rank-1, 30/30 recall@10, and 0.9708 mean reciprocal rank. These are example-corpus measurements, not universal production guarantees.
