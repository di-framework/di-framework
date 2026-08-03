# `@di-framework/ai`

Provides framework-native dependency injection and orchestration for portable AI capabilities; providers, stores, protocols, and transports remain replaceable adapters.

## Design posture

This package tracks **Spring AI** as the primary API reference—not a class-by-class Java port, and not a LangChain4j/`@AiService` clone.

| Spring AI concept | `@di-framework/ai` |
| --- | --- |
| `ChatModel` / `call(Prompt)` | `ChatModel.call(prompt)` |
| `StreamingChatModel` / `Flux` | optional `stream()` → `AsyncIterable<ChatResponse>` |
| `Prompt` + `Message` hierarchy | `Prompt`, `UserMessage`, `SystemMessage`, `AssistantMessage`, `ToolResponseMessage` |
| `ChatResponse` + `Generation` | `ChatResponse`, `Generation` |
| `ChatClient` + fluent API | planned (Phase 2) |
| Advisors | planned (not generic “middleware” under a different name) |
| `ToolCallback` / `ToolCallingManager` | planned |
| `ChatMemory` + `ChatMemoryRepository` | planned |
| `VectorStore` / `VectorStoreRetriever` | planned |
| Boot auto-config / starters | DI registration + optional packages |


## Package layout (target)

Mirrors Spring AI modules; starts as one package and may split later:

```text
src/
├── content/           # Media (commons)
├── chat/
│   ├── messages/      # Message types + factories
│   ├── prompt/        # Prompt, ChatOptions
│   ├── model/         # ChatModel, ChatResponse, Generation
│   ├── client/        # ChatClient + advisors (later)
│   └── memory/        # ChatMemory (later)
├── tool/              # ToolCallback, ToolCallingManager (later)
├── converter/         # StructuredOutputConverter (later)
├── vectorstore/       # VectorStore (later)
├── rag/               # RAG advisors/pipelines (later)
├── model/             # shared Model/errors
└── testing/           # FakeChatModel, ScriptedChatModel
```

Optional future packages

```text
@di-framework/ai-openai
@di-framework/ai-anthropic
@di-framework/ai-ollama
@di-framework/ai-mcp
@di-framework/ai-vector-*
```

## Status

### Phase 1 — model layer ✅

- Message types and factories
- `Prompt` / `ChatOptions`
- `ChatModel` / `ChatResponse` / `Generation` / `Usage`
- `AiError`
- `FakeChatModel`, `ScriptedChatModel`, `RecordingChatModel`

### Phase 2 — ChatClient + advisors ✅

- `ChatClient.create(model)` / `ChatClient.builder(model)`
- Fluent `prompt().system().user().options().advisors().call() / stream()`
- Advisor chain with Spring-style order (`HIGHEST_PRECEDENCE` → `LOWEST_PRECEDENCE`)
- Terminal `ChatModelCallAdvisor` / `ChatModelStreamAdvisor`
- `createBeforeAfterAdvisor`, `SimpleLoggerAdvisor`
- `ChatClientRequest` / `ChatClientResponse` with context map

### Quick example

```ts
import { ChatClient, FakeChatModel } from "@di-framework/ai";

const model = new FakeChatModel("Hello from a fake model");
const client = ChatClient.create(model);

const content = await client
  .prompt()
  .system("You are concise.")
  .user("Say hi.")
  .call()
  .content();

console.log(content);
// → Hello from a fake model
```

With a custom advisor:

```ts
import { ChatClient, FakeChatModel, createBeforeAfterAdvisor } from "@di-framework/ai";

const audit = createBeforeAfterAdvisor({
  name: "Audit",
  order: 0,
  before(req) {
    // mutate prompt / context
    return req;
  },
  after(res) {
    return res;
  },
});

const client = ChatClient.builder(new FakeChatModel("ok"))
  .defaultAdvisors(audit)
  .build();

await client.prompt().user("q").call().content();
```

Low-level model call (no client):

```ts
import { FakeChatModel, Prompt, systemMessage, userMessage } from "@di-framework/ai";

const model = new FakeChatModel("ok");
await model.call(
  Prompt.fromMessages([systemMessage("…"), userMessage("…")]),
);
```

## Implementation sequence (Spring-aligned)

1. **Model layer** ✅ — `Prompt`, messages, `ChatModel`, test doubles  
2. **ChatClient + advisors** ✅ — fluent API, advisor chain  
3. **Tools** — `ToolCallback`, `ToolDefinition`, `ToolCallingManager`, `ToolCallingAdvisor`  
4. **Structured output** — `StructuredOutputConverter`, provider-native schema when available  
5. **Memory** — `ChatMemory` + `ChatMemoryRepository` + `MessageWindowChatMemory`  
6. **Retrieval** — `VectorStoreRetriever`, `VectorStore`, RAG advisor  
7. **Providers** — OpenAI-compatible + one non-OpenAI family; shared contract tests  
8. **MCP** — official TypeScript MCP SDK behind an adapter  
9. **Workflows / agents** — only after tools, memory, streaming, and cancellation are solid  

## DI integration (later)

Registration will follow existing di-framework patterns (`registerFactory` string tokens, `@Container`, sibling packages like `@Portal` / `@Configuration`):

```ts
// Illustrative — not fully implemented yet
container.registerFactory("chatModel", () => myChatModel);
// ChatClient.create(container.resolve("chatModel"))
```

Named models use string tokens (`"chat.default"`), not a separate qualifier system.

## Develop

```bash
cd packages/di-framework-ai
bun test
```

## References

- [Spring AI](https://docs.spring.io/spring-ai/reference/)