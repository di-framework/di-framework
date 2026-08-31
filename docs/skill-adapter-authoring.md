# Authoring Agent Skill adapters

`@di-framework/ai-utils` separates skill metadata/body storage, vector search, and build-time
index writing. Provider integrations can replace any one of these pieces while selection,
explicit-name pinning, skill-level aggregation, validation, activation, prompt filtering, and
tool gating remain shared.

## Choose the narrow contract

- Implement `SkillCatalogStore` to list safe `SkillDescriptor` values and lazily load an
  `AgentSkill` body. `list()` must not fetch complete bodies.
- Implement `SkillVectorSearch` for runtime-only vector lookup. Return chunk matches; do not
  aggregate them into skills or insert chunks/backend metadata into prompts.
- Implement `SkillIndexWriter` only in build/deployment code. Runtime deployments do not need
  write permission.

Generic contracts and the in-memory reference adapters have no `node:fs` dependency.
`LocalSkillCatalogStore`, `LocalSkillVectorSearch`, and `LocalSkillIndexWriter` contain the
filesystem/JSONL implementation used by the compatible local APIs.

## Versioning and readiness

Catalog versions must change whenever a descriptor or body changes. Writer receipts must include
an immutable `indexVersion`, the matching `catalogVersion`, model/revision/embedder identity,
dimensions, scoring identity, and `ready: true`. Eventually consistent services should return a
receipt only after the written version is queryable, or return `ready: false` from metadata and
health until promotion completes.

Runtime search is fail closed. A stale catalog, incompatible model, missing body, timeout, partial
result, or not-ready version raises `SkillAdapterError`; it never expands the prompt to the full
catalog. Use namespaces consistently for every catalog, metadata, search, and load operation.

```ts
const toolbox = await SkillsToolbox.builder()
  .workspace('/workspace')
  .semanticDiscovery({
    catalogStore,
    vectorSearch,
    embedder,
    namespace: 'tenant:catalog-v4',
    timeoutMs: 2_000,
  })
  .buildAsync();
```

The synchronous `.build()` and `.semanticDiscovery({ indexFile, embedder })` paths remain for the
default filesystem implementation. Remote catalogs require `.buildAsync()`,
`createSkillsToolboxAsync()`, or `createSkillsAgentAsync()`.

## Contract checklist

An adapter test suite should exercise:

1. deterministic ordering and namespace isolation;
2. capabilities and ready/degraded/not-ready health;
3. catalog/model/version mismatches and missing bodies;
4. timeouts, provider failures, malformed vectors, unknown skills, and partial results;
5. replacement/upsert receipts and eventual-consistency readiness;
6. prompt snapshots proving that vectors, chunks, source hashes, provider metadata, and
   unactivated bodies never appear;
7. lazy activation loading exactly the selected body.

The in-memory adapters are the non-filesystem reference implementation for these tests.

## Performance report

Use `benchmarkSkillVectorSearch()` for repeatable initialization/search timing and feed its
`quality` field either `RetrievalEvaluationResult.metrics` or the complete result from the
versioned semantic-retrieval evaluation corpus (#194). Passing the complete result retains the
pinned suite, corpus revision, case count, and trial count alongside the metrics. Report cold and
warm initialization, query embedding, vector search, end-to-end selection, peak memory, network
requests/bytes, ingestion time, readiness delay, artifact/index size, recall@1, recall@10, and MRR.
Keep measured results tied to corpus revision, adapter configuration, region, runtime, and hardware;
do not present one environment's measurements as general production claims.

ANN/remote adapters should compare against `InMemorySkillVectorSearch` exact cosine results and
preserve at least 99% recall@10 on the shared extended suite.
