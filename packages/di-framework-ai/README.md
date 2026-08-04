# @di-framework/ai

Spring AI–aligned chat, tools, RAG, MCP, and agents for TypeScript. Portable model abstractions sit on top of OpenAI-compatible and Anthropic HTTP adapters (no vendor SDKs). Wire everything into `@di-framework/core` with annotations (`@AiService`, `@Agent`, `@Tool`, …) or `configureAi`.

## Features

- **Annotation DX**: `@AiService` / `@Agent` assistants, `@Tool` / `@ToolSet` beans, `@WithMemory` / `@WithRag` / `@WithTools`, workflows (`@Chain`, `@Route`, …).
- **ChatClient**: fluent prompt / call / stream API with an advisor chain (memory, tools, RAG, logging, observation).
- **Prototype builder**: inject `AiTokens.CHAT_CLIENT_BUILDER` (fresh per resolve) like Spring’s `ChatClient.Builder`.
- **Providers**: `OpenAiChatModel` and `AnthropicChatModel` over `fetch` — no official SDKs.
- **Tools**: `functionToolCallback`, method-level `@Tool` on DI beans, automatic tool-calling loops.
- **Structured output**: JSON Schema converters and `call().entity(...)`.
- **Memory / RAG / MCP / agents**: same runtime as before, now annotation-friendly.

## Installation

```bash
bun add @di-framework/ai @di-framework/core
# or
npm install @di-framework/ai @di-framework/core
```

Peer: `@di-framework/core`. Runtime dependency: `@modelcontextprotocol/sdk` (MCP helpers). Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when using the HTTP providers.

## Annotation-first quick start

```ts
import { Container } from '@di-framework/core/decorators';
import {
  Agent,
  AiService,
  configureAi,
  OpenAiChatModel,
  resolveAiService,
  resolveAnnotatedAgent,
  SystemMessageAnn,
  Tool,
  ToolParam,
  ToolSet,
  UserMessageAnn,
  WithMemory,
  MemoryId,
} from '@di-framework/ai';

@ToolSet()
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
  getWeather(@ToolParam('City name') input: { city: string }) {
    return { temp: 68, city: input.city };
  }
}

@AiService({ tools: [WeatherTools] })
@WithMemory()
class WeatherBot {
  @SystemMessageAnn('You help with weather questions.')
  ask(@UserMessageAnn() question: string, @MemoryId() sessionId: string): Promise<string> {
    throw new Error('handled by AiService proxy');
  }
}

@Agent({
  system: 'You help with weather.',
  tools: [WeatherTools],
})
class WeatherAgent {}

configureAi({
  chatModel: new OpenAiChatModel({ model: 'gpt-4o-mini' }),
  toolBeans: [WeatherTools],
  memory: /* MessageWindowChatMemory… */ undefined,
});

const bot = resolveAiService(WeatherBot);
await bot.ask('Weather in Yorktown?', 'session-1');

const agent = resolveAnnotatedAgent(WeatherAgent);
await agent.chat('Weather in Yorktown?');
```

Parameter decorators are factories — use `@UserMessageAnn()`, `@MemoryId()`, `@ToolParam()` (with parentheses).

### Inject a prototype `ChatClient.Builder`

```ts
import { Component, Container } from '@di-framework/core/decorators';
import {
  AiTokens,
  ChatAgent,
  type ChatClientBuilder,
  configureAi,
  OpenAiChatModel,
} from '@di-framework/ai';

configureAi({ chatModel: new OpenAiChatModel() });

@Container()
class SupportAgentService {
  private readonly agent: ChatAgent;

  constructor(@Component(AiTokens.CHAT_CLIENT_BUILDER) builder: ChatClientBuilder) {
    this.agent = ChatAgent.fromBuilder(builder)
      .system('You are an e-commerce support assistant.')
      .build();
  }

  chat(prompt: string, sessionId: string) {
    return this.agent.chat(prompt, { conversationId: sessionId });
  }
}
```

### Decorator catalog (selection)

| Decorator | Purpose |
| --- | --- |
| `@AiService` / `@Assistant` | Declarative chat assistant (class → proxy) |
| `@Agent` / `@ChatAgentBean` | Declarative `ChatAgent` bean |
| `@SystemMessageAnn` / `@UserMessageAnn()` / `@MemoryId()` | Prompt + session wiring |
| `@Tool` / `@ToolSet` / `@ToolParam()` | Tool methods on beans |
| `@WithMemory` / `@WithRag` / `@WithTools` / `@AiObserved` | Attach advisors |
| `@EnableAi` | Bootstrap scanning + `configureAi` options on an app class |
| `@Chain` / `@Route` / `@Parallel` / … | Workflow stereotypes |

Where names collide with runtime types, the package exports `AiAdvisor`, `ChatModelAnn`, `SystemMessageAnn`, `UserMessageAnn`, `AssistantMessageAnn`, `VectorStoreAnn`, `ChatMemoryAnn`, `DocumentAnn`, `EmbeddingModelAnn`, `ChatClientAnn`, and `PromptTemplate` (prompt decorator; `Prompt` remains the message class).

## Imperative ChatClient

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

## DI with `configureAi`

```ts
configureAi({
  chatModel: new OpenAiChatModel(),
  defaultSystem: 'You help with weather questions.',
  toolBeans: [WeatherTools],
  observation: true,
  agent: true, // optional AiTokens.CHAT_AGENT
  scanAnnotations: true, // default — processes @AiService / @Agent / …
});
```

## Tools, memory, RAG, MCP, workflows

Imperative APIs are unchanged: `functionToolCallback`, `MessageChatMemoryAdvisor`, `RetrievalAugmentationAdvisor`, MCP adapters, and `ChainWorkflow` / `RoutingWorkflow` / … See source tests under `tests/` for examples.

## Providers

```ts
new OpenAiChatModel({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
});

new AnthropicChatModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
});
```

## Testing

```ts
import { ChatClient, ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';

const model = new ScriptedChatModel([
  { respond: toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]) },
  { respond: '68F in Yorktown' },
]);
```

## License

MIT
