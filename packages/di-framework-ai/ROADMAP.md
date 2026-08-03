# `@di-framework/ai` — status and roadmap

## Phases 1–9: complete

The planned Spring AI–aligned vertical is finished:

```text
model → ChatClient → tools → structured output → memory → RAG
  → providers → MCP → workflows / agents
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

Nothing remains on that numbered sequence. The portable AI primitives stack is done.

---

## What’s still open (deferred / “later”)

These items were never part of Phases 1–9, but design notes and the README still call them out.

### 1. DI integration with `di-framework-core` (main gap)

README still marks **DI integration** as later work. Roughly:

| Item | Status |
| --- | --- |
| Register / inject `ChatModel`, `ChatClient` via string tokens | Not wired |
| `@Tool` method decorator on `@Container` beans | Explicitly deferred |
| Observation via `container.emit` / `@Subscriber` (redacted payloads) | Hooks only, not DI-native |
| Auto-config style factories (Spring “starters” analog) | Not done |

Illustrative target (not implemented):

```ts
container.registerFactory("chatModel", () => myChatModel);
// ChatClient.create(container.resolve("chatModel"))
// Named models: string tokens such as "chat.default"
```

This is the natural **next product phase** if the goal is “native di-framework,” not only portable AI primitives.

### 2. Package split / starters (optional packaging)

The library is still a single package (`@di-framework/ai`). A future split was only sketched:

```text
@di-framework/ai-openai
@di-framework/ai-anthropic
@di-framework/ai-ollama
@di-framework/ai-mcp
@di-framework/ai-vector-*
```

Providers and MCP currently live under `src/provider/` and `src/mcp/` inside the core package (fetch-only providers; official MCP SDK for the adapter).

### 3. Depth gaps (not blocking, nice-to-have)

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

### 4. Repo / product hygiene

- Package version is still early (`0.0.1`); publish pipeline may be incomplete
- Example app using `@di-framework/ai` under `examples/` may be missing or thin
- Monorepo typecheck / lint / CI coverage for this package should be verified end-to-end

---

## Practical priority

Suggested order by leverage:

1. **DI phase** — registration, `@Tool`, inject `ChatClient`
2. **One real embedding provider + one durable vector store** — so RAG is production-usable
3. **Example app + optional live smoke tests**
4. **Split provider packages** when the public surface feels crowded

---

## Bottom line

| Layer | State |
| --- | --- |
| Planned AI stack (Phases 1–9) | **Complete** |
| Framework integration (DI) | **Open** |
| Production adapters (embeddings, durable stores) | **Open** |
| Polish / examples / package split | **Open** |

What’s left is **framework integration (DI)**, **production adapters**, and **polish**—not another numbered core AI phase.

---

## References

- Package README: [`README.md`](./README.md)
- Design notes: [`DESIGN.md`](./DESIGN.md)
- Spring AI (primary API reference): local checkout `references/spring-ai/`
- Anthropic effective agents (Phase 9 patterns): [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
