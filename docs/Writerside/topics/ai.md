# AI

Spring AI–aligned chat, tools, RAG, MCP, and agents for TypeScript. Portable model abstractions sit on top of OpenAI-compatible and Anthropic HTTP adapters (no vendor SDKs). Domain services stay on `@di-framework/core`; this package is the AI layer — wire it with annotations (`@AiService`, `@Agent`, `@Tool`, …) or `configureAi`.

## Features

- **Annotation DX**: `@AiService` / `@Agent` assistants, `@Tool` / `@ToolSet` beans, `@WithMemory` / `@WithRag` / `@WithTools`, workflows (`@Chain`, `@Route`, …).
- **ChatClient**: fluent prompt / call / stream API with an advisor chain (memory, tools, RAG, logging, observation).
- **Prototype builder**: inject `AiTokens.CHAT_CLIENT_BUILDER` (fresh per resolve), like Spring’s `ChatClient.Builder`.
- **Providers**: `OpenAiChatModel` and `AnthropicChatModel` over `fetch` — no official SDKs.
- **Tools**: `functionToolCallback`, method-level `@Tool` on DI beans, automatic tool-calling loops.
- **Structured output**: JSON Schema converters and `call().entity(...)`.
- **Memory / RAG / MCP / agents**: same runtime as the imperative APIs, annotation-friendly.

## Installation

```bash
bun add @di-framework/ai @di-framework/core
```

```bash
npm install @di-framework/ai @di-framework/core
```

Peer: `@di-framework/core`. Runtime dependency: `@modelcontextprotocol/sdk` (MCP helpers).

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` when using the HTTP providers.

Decorators need TypeScript 5 and `experimentalDecorators`. `emitDecoratorMetadata` is not required. Parameter decorators are factories — call them with parentheses: `@UserMessageAnn()`, `@MemoryId()`, `@ToolParam()`.

## Quick Start (annotations)

```typescript
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
});

const bot = resolveAiService(WeatherBot);
await bot.ask('Weather in Yorktown?', 'session-1');

const agent = resolveAnnotatedAgent(WeatherAgent);
await agent.chat('Weather in Yorktown?');
```

`configureAi` registers the chat model, a singleton `ChatClient`, a **prototype** `ChatClient.Builder`, optional memory/tools/advisors, and (by default) scans annotations so `@AiService` / `@Agent` classes become resolvable factories.

## Inject a prototype ChatClient.Builder

```typescript
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

Each resolve of `AiTokens.CHAT_CLIENT_BUILDER` yields a fresh builder (Spring `@Scope("prototype")` style). Customize per service without mutating a shared client.

## Imperative ChatClient

```typescript
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

Advisors, default tools, and default system text can be attached on the builder before `build()`, or per prompt.

## DI with configureAi

```typescript
configureAi({
  chatModel: new OpenAiChatModel(),
  defaultSystem: 'You help with weather questions.',
  toolBeans: [WeatherTools],
  observation: true,
  agent: true, // optional AiTokens.CHAT_AGENT
  scanAnnotations: true, // default — processes @AiService / @Agent / …
});
```

Useful options:

| Option | Default | Meaning |
| --- | --- | --- |
| `chatModel` | — | Instance or factory; required unless already registered |
| `registerChatClient` | `true` | Register singleton `ChatClient` |
| `registerChatClientBuilder` | `true` | Register prototype builder |
| `toolBeans` | — | Beans scanned for `@Tool` methods |
| `memory` | — | `ChatMemory` instance or factory |
| `advisors` | — | Extra advisors on the default client |
| `observation` | — | Emit redacted `ai.chat.*` container events |
| `scanAnnotations` | `true` | Register annotated assistants / agents / workflows |
| `agent` | — | Register a default `ChatAgent` under `AiTokens.CHAT_AGENT` |

Fine-grained helpers: `registerChatModel`, `registerChatClient`, `registerChatClientBuilder`, `registerChatMemory`, `registerToolCallbacks`, `registerChatAgent`, plus matching `resolve*` functions.

## Tools

Two equivalent paths:

1. **Bean methods** — `@ToolSet()` + `@Tool({ description, inputSchema })` on a `@Container()` class; pass the class to `toolBeans` or `@AiService({ tools: [...] })`.
2. **Callbacks** — `functionToolCallback({ name, description, inputSchema }, handler)` for imperative wiring.

Tool-calling loops run through the advisor chain (`ToolCallingAdvisor`). Duplicate tool names are deduped (last registration wins) when combining `toolBeans` and per-assistant tools.

## Memory and advisors

```typescript
import { MessageWindowChatMemory, configureAi, WithMemory, MemoryId } from '@di-framework/ai';

configureAi({
  chatModel: /* … */,
  memory: new MessageWindowChatMemory({ maxMessages: 20 }),
});

@AiService()
@WithMemory()
class RememberingBot {
  talk(@UserMessageAnn() message: string, @MemoryId() sessionId: string): Promise<string> {
    throw new Error('proxy');
  }
}
```

`@MemoryId()` / `@ConversationId()` bind a method parameter to the chat-memory conversation id. Other advisor stereotypes: `@WithRag` / `@RetrievalAugmented`, `@WithTools`, `@AiObserved` / `@Observed`, plus `@AiAdvisor` / `@AdvisorOrder` for custom advisor beans.

## RAG

Imperative pieces: `SimpleVectorStore`, `FakeEmbeddingModel` / embedding models, `VectorStoreDocumentRetriever`, `RetrievalAugmentationAdvisor`. Annotation markers (`@VectorStoreAnn`, `@EmbeddingModelAnn`, `@Retriever`, `@IndexedDocument`, `@WithRag`) declare intent for scanning; wire stores and embeddings through `configureAi({ embeddingModel, vectorStore })` or manual registration under `AiTokens`.

## Agents and workflows

- **`ChatAgent`** — multi-turn chat with tools/memory; build via `ChatAgent.create(...)`, `chatAgent(...)`, or `ChatAgent.fromBuilder(builder)`.
- **`@Agent` / `@ChatAgentBean`** — declarative bean resolved with `resolveAnnotatedAgent`.
- **Workflows** (imperative + stereotypes): `ChainWorkflow`, `RoutingWorkflow`, `ParallelizationWorkflow`, `OrchestratorWorkersWorkflow`, `EvaluatorOptimizerWorkflow`, with matching `@Chain`, `@Route` / `@Router`, `@Parallel`, `@Orchestrator` / `@Worker`, `@Evaluate` / `@Optimize`.
- **`GraphWorkflow`** — typed graph runtime for arbitrary control flow (linear, branch, loop, nested subgraphs). Fluent builder with async edge predicates/transforms, `AbortSignal`, `maxSteps`, build-time validation, and lifecycle hooks. Helpers: `chatToolLoopGraph`, `simpleAgentGraph`. Graph stereotypes are deferred until the imperative API is stable.
- **`PlannerExecutorWorkflow`** — plan → act → replan loop on `ChatClient` + tools, with step limits and cycle protection.
- **`A2ABus`** — thin in-process agent-to-agent message bus with optional human-in-the-loop hooks (local only; not a network protocol).

```typescript
import { GRAPH_FINISH, GRAPH_START, GraphWorkflow, PlannerExecutorWorkflow } from '@di-framework/ai';

const graph = GraphWorkflow.builder<number, string>('example')
  .node('double', (n) => n * 2)
  .node('label', (n) => `value=${n}`)
  .edge(GRAPH_START, 'double')
  .edge('double', 'label')
  .edge('label', GRAPH_FINISH)
  .build();

const { output, path } = await graph.run(21, { maxSteps: 50 });

const { answer } = await PlannerExecutorWorkflow.of(chatClient).run(goal, {
  tools: [tool],
  maxSteps: 6,
});
```

## MCP

Uses `@modelcontextprotocol/sdk`. Adapt an SDK client and expose remote tools as `ToolCallback`s, or mark beans with `@McpClient` / `@McpTool`. Token: `AiTokens.MCP_CLIENT`.

## Agent Skills

Reusable `SKILL.md` folders (name + description at discovery, full instructions on invoke) live in **`@di-framework/ai-utils`**, not this package. Attach the `Skill` tool to any `ChatAgent` or `ChatClient`:

```bash
bun add @di-framework/ai-utils
```

```typescript
import { ChatAgent, OpenAiChatModel } from '@di-framework/ai';
import { skillsToolbox } from '@di-framework/ai-utils';

const agent = ChatAgent.create({
  chatModel: new OpenAiChatModel({ model: 'gpt-4o-mini' }),
  system: 'You help with code review.',
  tools: skillsToolbox({
    directories: ['.claude/skills'],
    workspace: process.cwd(),
    shell: true,
  }),
});

await agent.chat('Review src/UserController.ts');
```

`skillsToolbox()` attaches `Skill`, `Read`, `Glob`, and opt-in `Bash`. File tools are limited to the workspace and skill folders. `Bash` jails `cwd` only — it is not a container sandbox.

This is the generic, model-agnostic pattern (same idea as Spring’s `spring-ai-agent-utils` `SkillsTool`). It is not Anthropic’s hosted document Skills API.

## Providers

```typescript
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

Both speak HTTP via `fetch`. Point `baseUrl` at any OpenAI-compatible gateway when needed.

## Testing

```typescript
import { ChatClient, ScriptedChatModel, toolCall, toolCallResponse } from '@di-framework/ai';

const model = new ScriptedChatModel([
  { respond: toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]) },
  { respond: '68F in Yorktown' },
]);

const client = ChatClient.create(model);
```

Also available: `FakeChatModel` for fixed-content replies. Prefer scripted models in unit tests so tool loops stay deterministic.

## Name collisions

Chat message **types** (`SystemMessage`, `UserMessage`, `AssistantMessage`) and other runtime types keep their names. Where a decorator would collide, the package exports an `*Ann` (or renamed) decorator:

| Decorator export | Collides with |
| --- | --- |
| `SystemMessageAnn` / `UserMessageAnn` / `AssistantMessageAnn` | Message types |
| `ChatModelAnn` / `ChatClientAnn` / `ChatMemoryAnn` | Model / client / memory types |
| `VectorStoreAnn` / `DocumentAnn` / `EmbeddingModelAnn` | Store / document / embedding types |
| `AiAdvisor` | `Advisor` type |
| `PromptTemplate` | `Prompt` class |
| `ChatAgentBean` | `ChatAgent` class |

## Tokens

Prefer `AiTokens` over ad-hoc strings:

| Token | Default string | Role |
| --- | --- | --- |
| `CHAT_MODEL` | `chatModel` | Primary chat model |
| `CHAT_MODEL_DEFAULT` | `chat.default` | Alias |
| `CHAT_CLIENT` | `chatClient` | Singleton client |
| `CHAT_CLIENT_BUILDER` | `chatClientBuilder` | Prototype builder |
| `CHAT_AGENT` | `chatAgent` | Default agent |
| `CHAT_MEMORY` | `chatMemory` | Memory bean |
| `EMBEDDING_MODEL` / `VECTOR_STORE` / `DOCUMENT_RETRIEVER` | … | RAG |
| `TOOL_CALLBACKS` | `ai.tools` | Aggregated tools |
| `ADVISORS` | `ai.advisors` | Aggregated advisors |
| `MCP_CLIENT` | `mcpClient` | MCP session |

## Decorator catalog (selection)

| Decorator | Purpose |
| --- | --- |
| `@AiService` / `@Assistant` | Declarative chat assistant (class → proxy) |
| `@Agent` / `@ChatAgentBean` | Declarative `ChatAgent` bean |
| `@SystemMessageAnn` / `@UserMessageAnn()` / `@MemoryId()` | Prompt + session wiring |
| `@Tool` / `@ToolSet` / `@ToolParam()` | Tool methods on beans |
| `@WithMemory` / `@WithRag` / `@WithTools` / `@AiObserved` | Attach advisors |
| `@EnableAi` | Bootstrap scanning + `configureAi` options on an app class |
| `@Chain` / `@Route` / `@Parallel` / … | Workflow stereotypes |

## API Reference

| Export | Description |
| --- | --- |
| `configureAi` / `enableAi` | Bootstrap model, client, builder, annotations |
| `ChatClient` / `ChatClientBuilder` | Fluent chat API |
| `OpenAiChatModel` / `AnthropicChatModel` | HTTP providers |
| `AiService` / `Assistant` / `resolveAiService` | Annotated assistants |
| `Agent` / `ChatAgentBean` / `resolveAnnotatedAgent` | Annotated agents |
| `ChatAgent` / `ChatAgent.fromBuilder` | Imperative / builder agents |
| `Tool` / `ToolSet` / `ToolParam` / `functionToolCallback` | Tools |
| `MessageWindowChatMemory` / `MessageChatMemoryAdvisor` | Memory |
| `RetrievalAugmentationAdvisor` / vector store helpers | RAG |
| `ChainWorkflow` / `RoutingWorkflow` / … | Fixed-pattern workflows |
| `GraphWorkflow` / `chatToolLoopGraph` | Graph agent runtime |
| `PlannerExecutorWorkflow` | Plan → act → replan |
| `A2ABus` | In-process multi-agent messages |
| `ScriptedChatModel` / `FakeChatModel` | Tests |
| `AiTokens` | Well-known DI tokens |
| `AiError` / `isAiError` | Typed errors |

## Non-goals (v1)

1. **Official vendor SDKs** — HTTP adapters only; bring your own SDK behind a custom `ChatModel` if needed.
2. **Hosting / orchestration platforms** — no LangSmith, Bedrock Agents console, or cloud agent runtimes.
3. **Full prompt IDE / playground** — library APIs and annotations only.
4. **Authorization of tool calls** — tools run as wired; gate them in your handlers.
5. **Persistent vector DBs as first-party drivers** — in-memory / simple store plus interfaces; plug your own `VectorStore`.

## Example

Package tests under [`packages/di-framework-ai/tests`](https://github.com/di-framework/di-framework/tree/main/packages/di-framework-ai/tests) cover ChatClient, tools, memory, RAG, MCP, agents, and the annotation DX.
