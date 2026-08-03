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
| `ChatClient` + fluent API | `ChatClient.create` / `.builder` + fluent prompt |
| Advisors | ordered advisors (not generic “middleware”) |
| `ToolCallback` / `ToolCallingManager` | `functionToolCallback`, `ToolCallingAdvisor` |
| `StructuredOutputConverter` / `entity()` | `schemaOutputConverter`, `.entity()` |
| `ChatMemory` + `ChatMemoryRepository` | `ChatMemory`, `MessageWindowChatMemory`, `MessageChatMemoryAdvisor` |
| `VectorStore` / `VectorStoreRetriever` | `SimpleVectorStore`, filters, RAG advisor |
| `OpenAiChatModel` / Anthropic | `OpenAiChatModel`, `AnthropicChatModel` (HTTP, no SDKs) |
| MCP `SyncMcpToolCallback` | `McpToolCallback`, `McpToolCallbackProvider`, `adaptSdkClient` |
| Effective-agent workflows | `ChainWorkflow`, routing, parallel, orchestrator-workers, evaluator-optimizer |
| Tool-calling agent | `ChatAgent` (ChatClient + tools + optional memory) |
| Boot auto-config / starters | `configureAi`, `AiTokens`, `@Tool`, observation |


## Package layout (target)

Mirrors Spring AI modules; starts as one package and may split later:

```text
src/
├── content/           # Media (commons)
├── chat/
│   ├── messages/      # Message types + factories
│   ├── prompt/        # Prompt, ChatOptions
│   ├── model/         # ChatModel, ChatResponse, Generation
│   ├── client/        # ChatClient + advisors
│   └── memory/        # ChatMemory, repository, MessageWindowChatMemory
├── tool/              # ToolCallback, FunctionToolCallback
├── model/tool/        # ToolCallingManager, execution result
├── converter/         # StructuredOutputConverter, schema/map/list
├── document/          # Document
├── embedding/         # EmbeddingModel, FakeEmbeddingModel
├── vectorstore/       # VectorStore, SearchRequest, filters
├── rag/               # RetrievalAugmentationAdvisor, retrievers
├── provider/          # OpenAI-compatible + Anthropic ChatModel adapters
├── mcp/               # MCP → ToolCallback (official SDK adapter)
├── agent/             # Workflows + ChatAgent (effective-agent patterns)
├── di/                # AiTokens, configureAi, @Tool, ObservationAdvisor
├── model/             # shared Model/errors
└── testing/           # FakeChatModel, ScriptedChatModel
```

Providers live under `src/provider/` for now (fetch-only, no vendor SDKs). Optional future split packages:

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

### Phase 3 — Tools ✅

- `ToolDefinition`, `ToolCallback`, `functionToolCallback`
- `ToolCallingManager` / `DefaultToolCallingManager`
- `ToolCallingAdvisor` (tool loop **outside** `ChatModel`)
- `ChatClient.tools(...)` / builder `.defaultTools(...)` / `.toolContext(...)`
- Auto-registers `ToolCallingAdvisor` unless a `ToolAdvisor` is already present
- `returnDirect` short-circuit; tool context map; exception processor hook

### Phase 4 — Structured output ✅

- `StructuredOutputConverter` + `schemaOutputConverter` / `mapOutputConverter` / `listOutputConverter`
- Response cleaners (markdown fences, thinking tags, whitespace)
- `call().entity(converter | schema)` and `responseEntity(...)`
- `useProviderStructuredOutput()` → `ChatOptions.outputSchema`
- `validateSchema()` → `StructuredOutputValidationAdvisor` retry loop
- Format instructions injected by terminal `ChatModelCallAdvisor` (prompt path)

### Phase 5 — Memory ✅

- `ChatMemory` (`add` / `get` / `clear`) + `CHAT_MEMORY_CONVERSATION_ID`
- `ChatMemoryRepository` / `InMemoryChatMemoryRepository`
- `MessageWindowChatMemory` (window size, system-message preservation, turn-boundary snap)
- `MessageChatMemoryAdvisor` (order ≈ `HIGHEST + 200`, wraps tool-calling loop)
- Conversation id via `advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: id })`

### Phase 6 — Retrieval / RAG ✅

- `Document` / `textDocument`
- `EmbeddingModel` + `FakeEmbeddingModel` (deterministic bag-of-words for tests)
- `SearchRequest`, `VectorStoreRetriever`, `VectorStore`, `SimpleVectorStore`
- Portable metadata filters: AST, `FilterExpressionBuilder`, evaluator, text parser
- RAG: `Query`, `VectorStoreDocumentRetriever`, `ContextualQueryAugmenter`, `RetrievalAugmentationAdvisor`

### Phase 7 — Providers ✅

- `OpenAiChatModel` — Chat Completions (OpenAI-compatible: OpenAI, Groq, Ollama, OpenRouter, …)
- `AnthropicChatModel` — Messages API (Claude)
- Injectible `fetch`, `AbortSignal`, SSE streaming, tool call mapping
- HTTP errors → `AiError` (`authentication`, `rate-limit`, …)
- Shared contract tests with mock transports (no live keys required)

```ts
import { ChatClient, OpenAiChatModel } from "@di-framework/ai";

const model = new OpenAiChatModel({
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o-mini",
});

const text = await ChatClient.create(model)
  .prompt()
  .user("Say hi in one word.")
  .call()
  .content();
```

Anthropic:

```ts
import { AnthropicChatModel, ChatClient } from "@di-framework/ai";

const model = new AnthropicChatModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const text = await ChatClient.create(model)
  .prompt()
  .system("Be brief.")
  .user("Hello")
  .call()
  .content();
```

Point `OpenAiChatModel` at any OpenAI-compatible base URL:

```ts
new OpenAiChatModel({
  apiKey: process.env.GROQ_API_KEY,
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
});
```

### Phase 8 — MCP ✅

- `McpClientSession` port + `adaptSdkClient` for `@modelcontextprotocol/sdk` `Client`
- `McpToolCallback` — one MCP tool as `ToolCallback` (original name for call, optional prefixed name for the model)
- `McpToolCallbackProvider` / `createMcpToolCallbackProvider` / `mcpToolCallbacks` — discover tools from one or more sessions
- Name prefixing, tool filter, tool-context → MCP `_meta`
- Reverse: `toolCallbackAsMcpTool` (local callback → MCP descriptor + handler)
- Tests: fake session + real SDK `InMemoryTransport` round-trip

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ChatClient,
  adaptSdkClient,
  createMcpToolCallbackProvider,
} from "@di-framework/ai";

const mcp = new Client({ name: "app", version: "1.0.0" });
await mcp.connect(
  new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }),
);

const tools = await createMcpToolCallbackProvider({
  mcpClients: [adaptSdkClient(mcp, { title: "fs" })],
});

const answer = await ChatClient.create(chatModel)
  .prompt()
  .user("List files in /tmp")
  .tools(tools)
  .call()
  .content();
```

### Phase 9 — Workflows / agents ✅

Anthropic [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) patterns via Spring AI’s approach — composable on `ChatClient`, not a heavy agent framework:

| Pattern | Class |
| --- | --- |
| Chain | `ChainWorkflow` |
| Parallelization | `ParallelizationWorkflow` |
| Routing | `RoutingWorkflow` |
| Orchestrator–workers | `OrchestratorWorkersWorkflow` |
| Evaluator–optimizer | `EvaluatorOptimizerWorkflow` |
| LLM-directed tools | `ChatAgent` |

```ts
import {
  ChainWorkflow,
  ChatAgent,
  ChatClient,
  RoutingWorkflow,
} from "@di-framework/ai";

const client = ChatClient.create(model);

// Fixed path (workflow)
const summary = await new ChainWorkflow(client, [
  "Extract key facts.",
  "Write a one-sentence summary.",
]).chain(document);

// Dynamic tools (agent)
const agent = ChatAgent.create({
  chatModel: model,
  system: "You help with weather.",
  tools: [weatherTool],
});
const { content } = await agent.chat("Weather in Yorktown?");
```

Routing:

```ts
const answer = await new RoutingWorkflow(client).route(userMessage, {
  billing: "You are a billing specialist…",
  technical: "You are a technical support engineer…",
  general: "You are general support…",
});
```

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

With tools (tool loop outside the model):

```ts
import {
  ChatClient,
  ScriptedChatModel,
  functionToolCallback,
  textResponse,
  toolCall,
  toolCallResponse,
} from "@di-framework/ai";

const weather = functionToolCallback({
  name: "getWeather",
  description: "Get weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  call: ({ city }: { city: string }) => ({ city, tempF: 68 }),
});

const model = new ScriptedChatModel([
  {
    respond: toolCallResponse([
      toolCall("c1", "getWeather", { city: "Yorktown" }),
    ]),
  },
  { respond: textResponse("68°F and clear in Yorktown.") },
]);

const answer = await ChatClient.create(model)
  .prompt()
  .system("Answer weather questions concisely.")
  .user("What is the weather in Yorktown?")
  .tools(weather)
  .call()
  .content();
```

Structured entity (JSON schema, no Java classes):

```ts
import {
  ChatClient,
  FakeChatModel,
  schemaOutputConverter,
} from "@di-framework/ai";

const converter = schemaOutputConverter<{ name: string; age: number }>({
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
  },
});

const person = await ChatClient.create(new FakeChatModel('{"name":"Ada","age":36}'))
  .prompt()
  .user("Describe Ada")
  .call()
  .entity(converter);

// Or pass a schema object directly:
// .entity<{ name: string; age: number }>(personSchema)

// Provider-native schema + validation retries:
// .entity(converter, (s) => { s.useProviderStructuredOutput().validateSchema(); })
```

Conversation memory:

```ts
import {
  ChatClient,
  CHAT_MEMORY_CONVERSATION_ID,
  FakeChatModel,
  MessageChatMemoryAdvisor,
  MessageWindowChatMemory,
} from "@di-framework/ai";

const memory = MessageWindowChatMemory.builder().maxMessages(20).build();
const client = ChatClient.builder(new FakeChatModel("Noted."))
  .defaultAdvisors(MessageChatMemoryAdvisor.builder(memory).build())
  .build();

await client
  .prompt()
  .user("My name is Ada.")
  .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: "session-1" })
  .call()
  .content();

// Later turns load prior messages for the same conversation id.
await client
  .prompt()
  .user("What is my name?")
  .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: "session-1" })
  .call()
  .content();
```

RAG (retrieve → augment user message):

```ts
import {
  ChatClient,
  FakeChatModel,
  FakeEmbeddingModel,
  RetrievalAugmentationAdvisor,
  SimpleVectorStore,
  VectorStoreDocumentRetriever,
  textDocument,
} from "@di-framework/ai";

const store = SimpleVectorStore.of(new FakeEmbeddingModel());
await store.add([
  textDocument("Yorktown is in Virginia.", { source: "wiki" }, "d1"),
  textDocument("Paris is the capital of France.", { source: "wiki" }, "d2"),
]);

const rag = RetrievalAugmentationAdvisor.builder({
  documentRetriever: VectorStoreDocumentRetriever.builder({
    vectorStore: store,
    topK: 2,
  }),
});

const answer = await ChatClient.builder(new FakeChatModel("Yorktown is in Virginia."))
  .defaultAdvisors(rag)
  .build()
  .prompt()
  .user("Where is Yorktown?")
  .call()
  .content();
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
3. **Tools** ✅ — `ToolCallback`, `ToolDefinition`, `ToolCallingManager`, `ToolCallingAdvisor`  
4. **Structured output** ✅ — `StructuredOutputConverter`, `entity()`, validation advisor  
5. **Memory** ✅ — `ChatMemory` + `ChatMemoryRepository` + `MessageWindowChatMemory` + `MessageChatMemoryAdvisor`  
6. **Retrieval** ✅ — `VectorStoreRetriever`, `VectorStore`, filters, RAG advisor  
7. **Providers** ✅ — OpenAI-compatible + Anthropic; shared contract tests  
8. **MCP** ✅ — official TypeScript MCP SDK behind an adapter  
9. **Workflows / agents** ✅ — Anthropic effective-agent patterns + `ChatAgent`  
10. **DI integration** ✅ — tokens, `configureAi`, `@Tool`, observation  

## Implementation sequence complete

Phases 1–10 deliver a Spring AI–aligned stack with di-framework wiring: model → ChatClient → tools → structured output → memory → RAG → providers → MCP → workflows/agents → **DI**.

## DI integration ✅

### Tokens

| Token | Constant |
| --- | --- |
| `chatModel` | `AiTokens.CHAT_MODEL` |
| `chat.default` | `AiTokens.CHAT_MODEL_DEFAULT` |
| `chatClient` | `AiTokens.CHAT_CLIENT` |
| `chatMemory` | `AiTokens.CHAT_MEMORY` |
| `ai.tools` | `AiTokens.TOOL_CALLBACKS` |
| `embeddingModel` / `vectorStore` | `AiTokens.EMBEDDING_MODEL` / `VECTOR_STORE` |

### Auto-config (starter-style)

```ts
import {
  AiEvents,
  AiTokens,
  Tool,
  configureAi,
  resolveChatClient,
} from "@di-framework/ai";
import { Container, Component, Subscriber } from "@di-framework/core/decorators";
import { useContainer } from "@di-framework/core/container";

@Container()
class WeatherTools {
  @Tool({
    description: "Get weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  })
  getWeather({ city }: { city: string }) {
    return { temp: 68, city };
  }
}

@Container()
class AiAudit {
  @Subscriber(AiEvents.CHAT_RESPONSE)
  onChat(payload: { durationMs: number; model?: string }) {
    console.log("chat done", payload.durationMs, payload.model);
  }
}

useContainer().resolve(AiAudit);

configureAi({
  chatModel: new OpenAiChatModel({ apiKey: process.env.OPENAI_API_KEY }),
  defaultSystem: "You are helpful.",
  toolBeans: [WeatherTools],
  observation: true, // redacted ai.chat.* events on the container
});

const client = resolveChatClient();
// or: useContainer().resolve(AiTokens.CHAT_CLIENT)

@Container()
class Assistant {
  @Component(AiTokens.CHAT_CLIENT)
  client!: ChatClient;
}
```

Manual registration:

```ts
registerChatModel(model, { aliases: [AiTokens.CHAT_MODEL_DEFAULT] });
registerChatClient(ChatClient.create(model));
```

Observation payloads are **redacted by default** (counts, model, usage, finish reason — not full prompts). Opt into text with `observation: { includePromptText: true }`.

## Develop

```bash
cd packages/di-framework-ai
bun test
```

## References

- [Spring AI](https://docs.spring.io/spring-ai/reference/)
