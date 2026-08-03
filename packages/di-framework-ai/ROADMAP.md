# `@di-framework/ai` — status and roadmap

## Phases 1–10: complete

The planned Spring AI–aligned vertical **and** di-framework wiring are finished:

```text
model → ChatClient → tools → structured output → memory → RAG
  → providers → MCP → workflows / agents → DI
```

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Model layer (`Prompt`, messages, `ChatModel`, test doubles) | ✅ |
| 2 | `ChatClient` + advisors | ✅ |
| 3 | Tools (`ToolCallback`, `ToolCallingManager`, `ToolCallingAdvisor`) | ✅ |
| 4 | Structured output (`entity()`, converters, validation advisor) | ✅ |
| 5 | Memory (`ChatMemory`, `MessageChatMemoryAdvisor`) | ✅ |
| 6 | Retrieval / RAG (`VectorStore`, filters, RAG advisor) | ✅ |
| 7 | Providers (`OpenAiChatModel`, `AnthropicChatModel`) | ✅ |
| 8 | MCP (`McpToolCallback`, `adaptSdkClient`) | ✅ |
| 9 | Workflows / agents (effective-agent patterns + `ChatAgent`) | ✅ |
| 10 | DI integration (tokens, `configureAi`, `@Tool`, observation) | ✅ |

### Phase 10 detail (DI) ✅

| Item | Status |
| --- | --- |
| Register / inject `ChatModel`, `ChatClient` via string tokens | ✅ `AiTokens`, `registerChatModel` / `registerChatClient`, `resolveChat*` |
| `@Tool` method decorator on `@Container` beans | ✅ `@Tool` + `toolBeans` / `toolCallbacksFromBean` |
| Observation via `container.emit` / `@Subscriber` (redacted) | ✅ `ObservationAdvisor`, `AiEvents`, opt-in via `configureAi({ observation: true })` |
| Auto-config style factories (Spring “starters” analog) | ✅ `configureAi({ chatModel, tools, memory, … })` |

See package `README.md` for usage examples and `src/di/` for implementation.

---

## What’s still open (optional depth)

### 1. Package split / starters (optional packaging)

Still one package (`@di-framework/ai`). Future split (optional):

```text
@di-framework/ai-openai
@di-framework/ai-anthropic
@di-framework/ai-ollama
@di-framework/ai-mcp
@di-framework/ai-vector-*
```

### 2. Depth gaps (nice-to-have)

| Area | Gap |
| --- | --- |
| **Embedding providers** | Only `FakeEmbeddingModel`; no OpenAI (or other) embedding adapters |
| **Vector stores** | Only `SimpleVectorStore`; no PG / Redis / Chroma / etc. |
| **Memory stores** | Only `InMemoryChatMemoryRepository` |
| **Document loaders** | No PDF / HTML readers (Spring AI has document-readers) |
| **Media / multimodal** | Types exist; providers barely use images |
| **Standard Schema for tools** | Called out as “later” in `DESIGN.md` |
| **Live integration tests** | Providers / MCP covered with mocks and in-memory transports, not CI against real APIs |
| **Retry advisor** | HTTP errors map to `AiError`; no first-class retry advisor |
| **MCP server side** | Client → tools is solid; hosting tools as a full MCP server is thin (`toolCallbackAsMcpTool` only) |
| **Advanced agents** | No graph / planner / A2A (Koog-style); only Anthropic effective-agent patterns |

### 3. Repo / product hygiene

- Package version is still early (`0.0.1`); publish pipeline may be incomplete
- Example app using `@di-framework/ai` under `examples/` may be missing or thin
- Monorepo typecheck / lint / CI coverage for this package should be verified end-to-end

---

## Practical priority (post–Phase 10)

1. **One real embedding provider + one durable vector store** — production RAG  
2. **Example app + optional live smoke tests**  
3. **Split provider packages** when the public surface feels crowded  

---

## Bottom line

| Layer | State |
| --- | --- |
| Planned AI stack (Phases 1–9) | **Complete** |
| Framework integration (DI, Phase 10) | **Complete** |
| Production adapters (embeddings, durable stores) | **Open** |
| Polish / examples / package split | **Open** |

---

## References

- Package README: [`README.md`](./README.md)
- Design notes: [`DESIGN.md`](./DESIGN.md)
- Spring AI: local checkout `references/spring-ai/`
- Anthropic effective agents: [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
