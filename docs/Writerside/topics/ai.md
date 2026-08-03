# AI

Build portable AI applications with a provider-neutral model API, a fluent chat client, tool calling, structured output, memory, retrieval-augmented generation (RAG), Model Context Protocol (MCP), and agent workflows. `@di-framework/ai` integrates these capabilities with the DI container while keeping model providers and stores replaceable.

## Features

- **Chat model abstraction**: use `ChatModel`, `Prompt`, messages, responses, and streaming without coupling application code to a vendor SDK.
- **Provider adapters**: call OpenAI-compatible Chat Completions endpoints or the Anthropic Messages API through built-in, `fetch`-based models.
- **Fluent client and advisors**: assemble prompts and compose logging, memory, tool-calling, validation, observation, and RAG behavior.
- **Tools and structured output**: expose functions to models and convert responses using JSON Schema.
- **Memory and retrieval**: keep bounded conversation history and augment prompts with documents from a vector store.
- **MCP interoperability**: expose MCP server tools to a model or adapt a local callback into an MCP tool.
- **Workflows and agents**: compose chains, routing, parallelization, orchestrator-workers, evaluator-optimizer loops, and tool-calling agents.
- **DI integration**: register models, clients, memory, vector stores, and `@Tool` methods with `configureAi`.

## Installation

```bash
bun add @di-framework/ai @di-framework/core
```

```bash
npm install @di-framework/ai @di-framework/core
```

`@di-framework/ai` uses the platform `fetch` API. Its MCP adapters include the official `@modelcontextprotocol/sdk`; the OpenAI and Anthropic adapters do not require vendor SDKs.

The `@Tool` decorator needs TypeScript 5 with `experimentalDecorators` enabled. `emitDecoratorMetadata` is not required.

## Chat Client

Create a model, pass it to `ChatClient`, and assemble a request with the fluent prompt API:

```typescript
import { ChatClient, OpenAiChatModel } from '@di-framework/ai';

const model = new OpenAiChatModel({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
});

const content = await ChatClient.create(model)
  .prompt()
  .system('Be concise.')
  .user('Explain dependency injection in one sentence.')
  .call()
  .content();
```

Use `ChatClient.builder` for reusable defaults:

```typescript
const client = ChatClient.builder(model)
  .defaultSystem('Answer as a TypeScript expert.')
  .defaultOptions({ temperature: 0.2 })
  .build();

const answer = await client.prompt('What is a decorator?').call().content();
```

For streaming models, iterate over `stream().content()`:

```typescript
for await (const content of client.prompt('Tell me a short story.').stream().content()) {
  process.stdout.write(content);
}
```

Use the lower-level `ChatModel.call(Prompt)` API when you do not need advisors or the fluent client.

## Model Providers

### OpenAI-compatible endpoints

`OpenAiChatModel` supports OpenAI Chat Completions and compatible services such as Groq, Ollama, and OpenRouter. Override `baseUrl` for a compatible endpoint:

```typescript
const model = new OpenAiChatModel({
  apiKey: process.env.GROQ_API_KEY,
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'llama-3.3-70b-versatile',
});
```

### Anthropic

```typescript
import { AnthropicChatModel, ChatClient } from '@di-framework/ai';

const model = new AnthropicChatModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const answer = await ChatClient.create(model)
  .prompt()
  .user('Say hello in one word.')
  .call()
  .content();
```

Both adapters accept custom `fetch`, headers, and `AbortSignal` options. Provider and HTTP failures are normalized as `AiError`; inspect `error.code` and `error.details.retryable` when applying retry policy.

## Tool Calling

Create a portable callback with a name, description, JSON Schema, and implementation. Adding it with `.tools()` automatically adds the tool-calling advisor and runs the model/tool loop outside the provider adapter.

```typescript
import {
  ChatClient,
  OpenAiChatModel,
  functionToolCallback,
} from '@di-framework/ai';

const weather = functionToolCallback({
  name: 'getWeather',
  description: 'Get the current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  call: ({ city }: { city: string }) => ({ city, tempF: 68 }),
});

const answer = await ChatClient.create(new OpenAiChatModel())
  .prompt()
  .user('What is the weather in Yorktown?')
  .tools(weather)
  .call()
  .content();
```

Set `returnDirect: true` when a tool result should be returned immediately instead of being sent back to the model. Pass per-request application data to callbacks with `.toolContext({ ... })` rather than placing it in the model-visible schema.

## Structured Output

Convert a response using a JSON Schema. The converter removes common Markdown fences before parsing:

```typescript
import { ChatClient, OpenAiChatModel, schemaOutputConverter } from '@di-framework/ai';

const personSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
  required: ['name', 'age'],
};

const converter = schemaOutputConverter<{ name: string; age: number }>({
  schema: personSchema,
});

const person = await ChatClient.create(new OpenAiChatModel())
  .prompt()
  .user('Return Ada Lovelace as JSON.')
  .call()
  .entity(converter, (options) => {
    options.useProviderStructuredOutput().validateSchema();
  });
```

`useProviderStructuredOutput()` sends the schema through the provider's native structured-output option. `validateSchema()` validates the response and enables the validation advisor's retry loop. You can also pass a schema directly to `.entity<T>(schema)` or use `mapOutputConverter` and `listOutputConverter`.

## Conversation Memory

`MessageWindowChatMemory` keeps recent messages while preserving system messages. The conversation id belongs in advisor context so separate users do not share history:

```typescript
import {
  CHAT_MEMORY_CONVERSATION_ID,
  ChatClient,
  MessageChatMemoryAdvisor,
  MessageWindowChatMemory,
  OpenAiChatModel,
} from '@di-framework/ai';

const memory = MessageWindowChatMemory.builder().maxMessages(20).build();
const client = ChatClient.builder(new OpenAiChatModel())
  .defaultAdvisors(MessageChatMemoryAdvisor.builder(memory).build())
  .build();

await client
  .prompt('My name is Ada.')
  .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'session-1' })
  .call()
  .content();

const answer = await client
  .prompt('What is my name?')
  .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'session-1' })
  .call()
  .content();
```

The built-in repository is in-memory. Implement `ChatMemoryRepository` when conversation state must survive a process restart or be shared across instances.

## Retrieval-Augmented Generation

The retrieval layer separates embeddings, vector storage, document retrieval, and prompt augmentation. `FakeEmbeddingModel` and `SimpleVectorStore` are deterministic in-memory implementations intended for tests and small examples:

```typescript
import {
  ChatClient,
  FakeEmbeddingModel,
  OpenAiChatModel,
  RetrievalAugmentationAdvisor,
  SimpleVectorStore,
  VectorStoreDocumentRetriever,
  textDocument,
} from '@di-framework/ai';

const store = SimpleVectorStore.of(new FakeEmbeddingModel());
await store.add([
  textDocument('Yorktown is in Virginia.', { source: 'places' }, 'doc-1'),
  textDocument('Paris is the capital of France.', { source: 'places' }, 'doc-2'),
]);

const rag = RetrievalAugmentationAdvisor.builder({
  documentRetriever: VectorStoreDocumentRetriever.builder({
    vectorStore: store,
    topK: 2,
  }),
});

const answer = await ChatClient.builder(new OpenAiChatModel())
  .defaultAdvisors(rag)
  .build()
  .prompt('Where is Yorktown?')
  .call()
  .content();
```

Implement `EmbeddingModel` and `VectorStore` to connect production embedding and vector database services. Retrieval supports similarity thresholds, portable metadata filters, query transformation/expansion, document joining, and post-processing.

## Model Context Protocol

Adapt an official MCP SDK client and discover its tools as `ToolCallback` objects:

```typescript
import {
  adaptSdkClient,
  createMcpToolCallbackProvider,
} from '@di-framework/ai';

const tools = await createMcpToolCallbackProvider({
  mcpClients: [adaptSdkClient(connectedMcpClient, { title: 'filesystem' })],
});

const answer = await client
  .prompt('List the available project files.')
  .tools(tools)
  .call()
  .content();
```

The MCP SDK client must already be connected. Use name prefixes and tool filters when combining servers. For the reverse direction, `toolCallbackAsMcpTool` adapts a local callback into an MCP descriptor and handler.

## Workflows and Agents

Use a fixed workflow when your application controls the execution path, and `ChatAgent` when the model should decide which tools to call.

| Pattern | API |
| --- | --- |
| Sequential prompts | `ChainWorkflow` |
| Concurrent independent prompts | `ParallelizationWorkflow` |
| Classify then dispatch | `RoutingWorkflow` |
| Plan and delegate subtasks | `OrchestratorWorkersWorkflow` |
| Generate, evaluate, and refine | `EvaluatorOptimizerWorkflow` |
| Model-directed tool use | `ChatAgent` |

```typescript
import { ChainWorkflow, ChatAgent, ChatClient } from '@di-framework/ai';

const client = ChatClient.create(model);
const summary = await new ChainWorkflow(client, [
  'Extract the key facts.',
  'Write a one-sentence summary.',
]).chain(documentText);

const agent = ChatAgent.create({
  chatModel: model,
  system: 'You answer weather questions.',
  tools: [weather],
});

const { content } = await agent.chat('What is the weather in Yorktown?');
```

All workflows accept cancellation through `AbortSignal`. Parallel and iterative workflows also expose limits so callers can bound concurrency and refinement.

## Dependency Injection

`configureAi` registers a model and a reusable `ChatClient`. It can also discover `@Tool` methods on container-managed classes, attach memory and custom advisors, and emit redacted observation events:

```typescript
import {
  AiEvents,
  AiTokens,
  ChatClient,
  OpenAiChatModel,
  Tool,
  configureAi,
  resolveChatClient,
} from '@di-framework/ai';
import { Component, Container, Subscriber } from '@di-framework/core/decorators';

@Container()
class WeatherTools {
  @Tool({
    description: 'Get weather for a city',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  })
  getWeather({ city }: { city: string }) {
    return { city, tempF: 68 };
  }
}

@Container()
class AiAudit {
  @Subscriber(AiEvents.CHAT_RESPONSE)
  onResponse(event: { durationMs: number; model?: string }) {
    console.log(event.durationMs, event.model);
  }
}

configureAi({
  chatModel: new OpenAiChatModel(),
  defaultSystem: 'Be helpful and concise.',
  toolBeans: [WeatherTools],
  observation: true,
});

const client = resolveChatClient();

@Container()
class Assistant {
  @Component(AiTokens.CHAT_CLIENT)
  client!: ChatClient;
}
```

Observation events contain counts, model metadata, usage, and finish reasons by default—not full prompt or response text. Only enable `includePromptText` or `includeResponseText` after considering secrets and personal data in prompts.

Use `registerChatModel`, `registerChatClient`, `registerChatMemory`, and `registerToolCallbacks` when you want manual registration instead of the starter-style setup.

## Testing

Use `FakeChatModel` for a fixed or handler-based response, `ScriptedChatModel` for ordered multi-turn behavior such as tool calls, and `RecordingChatModel` to assert which prompts reached the model. These test doubles make unit tests deterministic and require no API keys.

## API Reference

| Area | Main exports |
| --- | --- |
| Model and prompts | `ChatModel`, `Prompt`, message factories, `ChatResponse`, `ChatOptions` |
| Fluent client | `ChatClient`, advisors, call/stream response specs |
| Providers | `OpenAiChatModel`, `AnthropicChatModel`, `AiError` |
| Tools | `functionToolCallback`, `ToolCallingAdvisor`, `@Tool`, `ToolContext` |
| Structured output | `schemaOutputConverter`, `mapOutputConverter`, `listOutputConverter` |
| Memory | `MessageWindowChatMemory`, `MessageChatMemoryAdvisor`, `ChatMemoryRepository` |
| Retrieval | `Document`, `EmbeddingModel`, `VectorStore`, `RetrievalAugmentationAdvisor` |
| MCP | `adaptSdkClient`, `McpToolCallbackProvider`, `toolCallbackAsMcpTool` |
| Workflows | `ChainWorkflow`, `RoutingWorkflow`, `ParallelizationWorkflow`, `OrchestratorWorkersWorkflow`, `EvaluatorOptimizerWorkflow`, `ChatAgent` |
| DI | `configureAi`, `AiTokens`, `AiEvents`, registration and resolution helpers |
| Tests | `FakeChatModel`, `ScriptedChatModel`, `RecordingChatModel` |

## Current Scope

The built-in providers cover OpenAI-compatible Chat Completions and Anthropic Messages. The package includes an in-memory vector store and deterministic fake embedding model, but no hosted embedding or production vector-database adapter. Implement the corresponding interfaces to keep domain code independent of those services.
