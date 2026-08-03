# @di-framework/ai

Spring AI–aligned chat, tools, RAG, MCP, and agents for TypeScript. Portable model abstractions sit on top of OpenAI-compatible and Anthropic HTTP adapters (no vendor SDKs). Wire everything into `@di-framework/core` with `configureAi`, `@Tool`, and string tokens.

## Features

- **ChatClient**: fluent prompt / call / stream API with an advisor chain (memory, tools, RAG, logging, observation).
- **Providers**: `OpenAiChatModel` (OpenAI, Azure, Groq, Ollama, OpenRouter, …) and `AnthropicChatModel` over `fetch` — no official SDKs.
- **Tools**: `functionToolCallback`, method-level `@Tool` on DI beans, and automatic tool-calling loops via `ToolCallingAdvisor`.
- **Structured output**: JSON Schema converters and `call().entity(...)` with optional provider-side schema hints.
- **Memory**: `MessageWindowChatMemory` + `MessageChatMemoryAdvisor` for multi-turn conversations.
- **RAG**: documents, embeddings, in-memory `SimpleVectorStore` with filter expressions, and `RetrievalAugmentationAdvisor`.
- **MCP**: adapt Model Context Protocol tools to `ToolCallback` (and the reverse) via `@modelcontextprotocol/sdk`.
- **Agents / workflows**: `ChatAgent` plus chain, routing, parallelization, orchestrator–workers, and evaluator–optimizer patterns.
- **DI starter**: `configureAi({ chatModel, tools, memory, observation })` registers model, client, and tools under `AiTokens`.
- **Test doubles**: `FakeChatModel`, `ScriptedChatModel`, `RecordingChatModel`, and `FakeEmbeddingModel`.

## Installation

```bash
bun add @di-framework/ai @di-framework/core
# or
npm install @di-framework/ai @di-framework/core
```

Peer: `@di-framework/core`. Runtime dependency: `@modelcontextprotocol/sdk` (MCP helpers). Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when using the HTTP providers.

## Quick start

```ts
import { ChatClient, OpenAiChatModel } from '@di-framework/ai';

const model = new OpenAiChatModel({ model: 'gpt-4o-mini' });
const client = ChatClient.create(model);

const answer = await client
  .prompt()
  .system('You are concise.')
  .user('What is Yorktown known for?')
  .call()
  .content();
```

Stream tokens:

```ts
for await (const chunk of client.prompt().user('Tell me a joke').stream().content()) {
  process.stdout.write(chunk);
}
```

## DI with `configureAi`

Register a model, optional memory/tools, and a `ChatClient` factory on the container:

```ts
import { Container } from '@di-framework/core/decorators';
import {
  AiTokens,
  configureAi,
  OpenAiChatModel,
  resolveChatClient,
  Tool,
} from '@di-framework/ai';

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
    return { temp: 68, city };
  }
}

configureAi({
  chatModel: new OpenAiChatModel(),
  defaultSystem: 'You help with weather questions.',
  toolBeans: [WeatherTools],
  observation: true, // emits redacted ai.chat.* events on the container
});

const client = resolveChatClient(); // AiTokens.CHAT_CLIENT
await client.prompt().user('Weather in Yorktown?').call().content();
```

Inject by token:

```ts
import { Component, Container } from '@di-framework/core/decorators';
import { AiTokens, ChatClient, type ChatModel } from '@di-framework/ai';

@Container()
class Assistant {
  @Component(AiTokens.CHAT_MODEL)
  model!: ChatModel;

  ask(q: string) {
    return ChatClient.create(this.model).prompt().user(q).call().content();
  }
}
```

## Tools

Imperative callbacks:

```ts
import { ChatClient, functionToolCallback, OpenAiChatModel } from '@di-framework/ai';

const getWeather = functionToolCallback<{ city: string }, { temp: number }>({
  name: 'getWeather',
  description: 'Look up weather',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  call: ({ city }) => ({ temp: 72, city }),
});

const client = ChatClient.builder(new OpenAiChatModel())
  .defaultTools(getWeather)
  .build();

await client.prompt().user('Weather in Yorktown?').call().content();
```

`ToolCallingAdvisor` runs the model → tool → model loop; you do not call tools yourself.

## Structured output

```ts
import { ChatClient, FakeChatModel, schemaOutputConverter } from '@di-framework/ai';

const personSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
  },
  required: ['name', 'age'],
} as const;

const person = await ChatClient.create(model)
  .prompt()
  .user('Describe Ada Lovelace')
  .call()
  .entity<{ name: string; age: number }>(personSchema);
```

Or pass `schemaOutputConverter({ schema })` for reusable format instructions and validation. Use `responseEntity(...)` when you need both the parsed value and the raw `ChatResponse`.

## Conversation memory

```ts
import {
  CHAT_MEMORY_CONVERSATION_ID,
  ChatClient,
  MessageChatMemoryAdvisor,
  MessageWindowChatMemory,
} from '@di-framework/ai';

const memory = MessageWindowChatMemory.builder().maxMessages(20).build();
const client = ChatClient.builder(model)
  .defaultAdvisors(new MessageChatMemoryAdvisor({ chatMemory: memory }))
  .build();

await client
  .prompt()
  .user("Hi, I'm Alice")
  .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'c1' })
  .call()
  .content();
```

With `configureAi({ memory })`, the memory advisor is wired automatically.

## RAG

```ts
import {
  ChatClient,
  FakeEmbeddingModel,
  RetrievalAugmentationAdvisor,
  SimpleVectorStore,
  textDocument,
  VectorStoreDocumentRetriever,
} from '@di-framework/ai';

const store = SimpleVectorStore.of(new FakeEmbeddingModel({ dimensions: 64 }));

await store.add([
  textDocument('Yorktown is a historic town in Virginia.', { source: 'wiki' }, 'd1'),
  textDocument('The Siege of Yorktown ended the Revolutionary War.', { source: 'wiki' }, 'd2'),
]);

const client = ChatClient.builder(model)
  .defaultAdvisors(
    RetrievalAugmentationAdvisor.builder({
      documentRetriever: VectorStoreDocumentRetriever.builder({
        vectorStore: store,
        topK: 3,
      }),
    }),
  )
  .build();

await client.prompt().user('What happened at Yorktown?').call().content();
```

Filter expressions support a builder and a text parser (`country == 'UK' && year >= 2020`).

## MCP

Expose remote MCP tools as `ToolCallback`s:

```ts
import { adaptSdkClient, createMcpToolCallbackProvider } from '@di-framework/ai';

const session = adaptSdkClient(mcpClient, { title: 'fs' });
const provider = await createMcpToolCallbackProvider({ mcpClients: [session] });

const client = ChatClient.builder(model).defaultTools(provider).build();
```

Or use `mcpToolCallbacks(session)` when you only need the callback list. Local tools can be published as MCP descriptors with `toolCallbackAsMcpTool` / `toolCallbackToMcpHandler`.

## Agents and workflows

`ChatAgent` is a preconfigured client that lets the model choose tools dynamically:

```ts
import { ChatAgent, functionToolCallback } from '@di-framework/ai';

const agent = ChatAgent.create({
  chatModel: model,
  system: 'You help with weather questions.',
  tools: [getWeather],
});

const { content } = await agent.chat('Weather in Yorktown?');
```

Fixed multi-step patterns (Anthropic / Spring AI effective-agent styles):

| Workflow | Role |
| --- | --- |
| `ChainWorkflow` | Feed each step’s output into the next |
| `RoutingWorkflow` | Classify then dispatch to a handler |
| `ParallelizationWorkflow` | Run several prompts concurrently |
| `OrchestratorWorkersWorkflow` | Plan tasks, run workers, synthesize |
| `EvaluatorOptimizerWorkflow` | Generate → evaluate → refine until pass |

```ts
import { ChainWorkflow, ChatClient } from '@di-framework/ai';

const chain = new ChainWorkflow(ChatClient.create(model), [
  'Extract key facts',
  'Summarize the facts in one sentence',
]);
const summary = await chain.chain('Alice is 30 years old and lives in Yorktown.');
```

## Providers

```ts
import { AnthropicChatModel, OpenAiChatModel } from '@di-framework/ai';

new OpenAiChatModel({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1', // or Groq / Ollama / Azure / OpenRouter
  model: 'gpt-4o-mini',
});

new AnthropicChatModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
});
```

Both implement `ChatModel` / `StreamingChatModel`. Tool loops stay on `ChatClient`; each provider call is a single request.

## Testing

```ts
import {
  ChatClient,
  FakeChatModel,
  ScriptedChatModel,
  requestContains,
  toolCall,
  toolCallResponse,
} from '@di-framework/ai';

const model = new ScriptedChatModel([
  {
    when: requestContains('weather'),
    respond: toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]),
  },
  { respond: '68F in Yorktown' },
]);

const content = await ChatClient.create(model).prompt().user('weather?').call().content();
```

`FakeChatModel` returns fixed text (and supports streaming). Prefer scripted models when asserting tool rounds or multi-turn memory.

## License

MIT
