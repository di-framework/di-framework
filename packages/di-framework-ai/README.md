# @di-framework/ai

Spring AI–aligned chat, tools, RAG, MCP, and agents for TypeScript. Portable model abstractions sit on top of OpenAI-compatible and Anthropic HTTP adapters (no vendor SDKs). Wire everything into `@di-framework/core` with annotations (`@AiService`, `@Agent`, `@Tool`, …) or `configureAi`.

**Style:** prefer `static of` / `static builder` factories and free functions for pure helpers; keep instance methods for stateful clients and fluent builders. See [docs/static-methods-convention.md](../../docs/static-methods-convention.md).

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

**Agent Skills** (`SKILL.md`, progressive disclosure) are not in this package. Use [`@di-framework/ai-utils`](../di-framework-ai-utils) `SkillsAgent.builder()` / `SkillsToolbox.builder()`.

### Tool Execution Authorization & Interception

Tool execution can be intercepted and authorized by registering ordered `ToolExecutionAdvisor` instances with `ToolCallingManager` / `DefaultToolCallingManager`.

`ToolAuthorizationAdvisor` integrates with `@di-framework/auth` `AuthorizationManager` to evaluate authorization decisions before executing any tool call.

- **Covered Execution Paths**: Interception occurs inside `DefaultToolCallingManager.executeOne()` whenever the model requests a tool call (including multi-call turns).
- **Direct Execution Note**: Direct `ToolCallback.call()` invocations performed manually outside of `ToolCallingManager` are **not implicitly intercepted**; authorization policies are enforced during manager-driven execution.
- **Trusted Principal**: The authenticated subject (`Principal`) is resolved from trusted `ToolContext` data (`toolContext.get('principal')` or custom resolver) — model-generated arguments (`toolCall.arguments`) can **never** supply or overwrite the principal.
- **Fail Closed**: Missing principal, policy denial, manager exception, or unresolvable manager configurations fail closed and return generic response `"Tool execution unauthorized"` without leaking policy decision details to the model.

```ts
import {
  createToolCallingManager,
  functionToolCallback,
  ToolAuthorizationAdvisor,
  toolCallbacksFromBean,
  Tool,
  ToolSet,
} from '@di-framework/ai';
import type { AuthorizationManager, ToolAuthorizationContext } from '@di-framework/ai';

// 1. Authorization Manager definition
const authManager: AuthorizationManager<ToolAuthorizationContext> = {
  async authorize(principal, context) {
    // context.transport === 'ai-tool'
    // context.tool === tool name
    // context.arguments === parsed tool arguments
    // context.metadata === opaque auth metadata from @Tool / @ToolSet / callback
    if (principal?.sub === 'admin') return { allowed: true };
    return { allowed: false, reason: 'Insufficient privileges' };
  },
};

// 2. Opaque authorization metadata on callbacks / beans
const deleteUserTool = functionToolCallback({
  name: 'deleteUser',
  auth: { permission: 'users:delete' },
  call: ({ userId }: { userId: string }) => `Deleted ${userId}`,
});

@ToolSet({ auth: { scope: 'admin' } })
class AdminTools {
  @Tool({ auth: { permission: 'system:shutdown' } })
  shutdown() {
    return 'System shutting down';
  }
}

// 3. Create ToolCallingManager with Authorization Advisor
const toolManager = createToolCallingManager({
  authorizationManager: authManager,
});
```

### Graph workflows

For arbitrary agent control flow (branches, loops, nested subgraphs), use the typed graph runtime:

```ts
import {
  ChatClient,
  GRAPH_FINISH,
  GRAPH_START,
  GraphWorkflow,
  chatToolLoopGraph,
  functionToolCallback,
} from '@di-framework/ai';

const graph = GraphWorkflow.builder<number, string>('example')
  .node('double', (n) => n * 2)
  .node('label', (n) => `value=${n}`)
  .edge(GRAPH_START, 'double')
  .edge('double', 'label')
  .edge('label', GRAPH_FINISH)
  .build();

const { output, path, steps } = await graph.run(21, { maxSteps: 50, signal });
// output === "value=42"

// LLM + tools as a ready-made graph (uses ChatClient tool-calling)
const agentGraph = chatToolLoopGraph({
  chatClient: ChatClient.create(model),
  tools: [weatherTool],
  system: 'Help with weather.',
});
const answer = await agentGraph.run({ message: 'Weather in Yorktown?' });
```

Edges support async `when` predicates and `transform` functions. Nested graphs use `.subgraph(id, childGraph)`. Validation runs at `build()` (reachable finish, no edges from finish, unique ids). Lifecycle hooks (`onNodeStart`, `onGraphComplete`, …) align with observation-friendly debugging. Prefer fixed workflows when the path is known; use graphs when control flow must be composed dynamically. Stereotype annotations for graphs are deferred until the imperative API stabilizes.

### Planner–executor

Iterative plan → act → replan on `ChatClient` (+ tools), with `AbortSignal`, `maxSteps`, and cycle protection:

```ts
import { ChatClient, PlannerExecutorWorkflow, functionToolCallback } from '@di-framework/ai';

const pe = PlannerExecutorWorkflow.of(ChatClient.create(model));
const { answer, plan, rounds } = await pe.run('Weather in Yorktown?', {
  tools: [weatherTool],
  maxSteps: 6,
  signal,
});
```

### In-process A2A (multi-agent)

Thin local agent-to-agent bus with human-in-the-loop hooks (no network transport):

```ts
import { A2ABus } from '@di-framework/ai';

const bus = A2ABus.create({
  onHumanInTheLoop: async (msg) => msg, // approve / rewrite / return null to reject
});
bus.register('researcher', async (msg) => `notes:${msg.content}`);
bus.register('writer', async (msg, b) => {
  const research = await b.request('writer', 'researcher', msg.content);
  return `Article: ${research.content}`;
});
const reply = await bus.request('user', 'writer', 'Graph workflows');
```

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

Licensed under either [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE), at your option.
# Durable vector stores

The package exports `BunSqliteVectorStore`, `VectorizeVectorStore`, and `PgVectorStore`. All implement the same `VectorStore` API and can be passed to RAG advisors. The Bun store uses the optional `wasm-similarity` package for batch cosine ranking when installed, and automatically falls back to a portable exact cosine scan when it is unavailable. SQLite stores rows as JSON (appropriate for local/test corpora); Vectorize and pgvector delegate ranking to their managed backends. Create provider schemas and indexes out of band and keep provider clients optional so Workers and Bun bundles do not pull Postgres dependencies.
