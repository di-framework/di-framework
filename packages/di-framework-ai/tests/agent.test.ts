import { describe, expect, test } from 'bun:test';
import {
  ChainWorkflow,
  ChatAgent,
  ChatClient,
  EvaluatorOptimizerWorkflow,
  extractJsonObject,
  functionToolCallback,
  MessageWindowChatMemory,
  OrchestratorWorkersWorkflow,
  ParallelizationWorkflow,
  RoutingWorkflow,
  requestContains,
  ScriptedChatModel,
  toolCall,
  toolCallResponse,
} from '../src/index.ts';

describe('extractJsonObject', () => {
  test('extracts fenced JSON and rejects an unterminated whitespace-heavy fence', () => {
    expect(extractJsonObject('Result:\n```JSON\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(() => extractJsonObject(`\`\`\`json${' '.repeat(10_000)}`)).toThrow(
      'Could not parse JSON from workflow response',
    );
  });
});

describe('ChainWorkflow', () => {
  test('feeds each step output into the next', async () => {
    const model = new ScriptedChatModel([
      {
        when: requestContains('extract'),
        respond: (p) => {
          // first step receives original user text
          expect(p.getContents().toLowerCase()).toContain('alice');
          return 'fact: Alice is 30';
        },
      },
      {
        when: requestContains('summarize'),
        respond: (p) => {
          expect(p.getContents()).toContain('fact: Alice is 30');
          return 'Alice (30)';
        },
      },
    ]);
    const client = ChatClient.create(model);
    const chain = new ChainWorkflow(client, ['extract key facts', 'summarize the facts']);
    const result = await chain.chain('Alice is 30 years old.');
    expect(result).toBe('Alice (30)');
  });

  test('chainDetailed returns intermediate steps', async () => {
    const model = new ScriptedChatModel([{ respond: 'step1' }, { respond: 'step2' }]);
    const detailed = await new ChainWorkflow(ChatClient.create(model), ['A', 'B']).chainDetailed(
      'seed',
    );
    expect(detailed.result).toBe('step2');
    expect(detailed.steps).toHaveLength(2);
    expect(detailed.steps[0]!.output).toBe('step1');
    expect(detailed.steps[1]!.input).toBe('step1');
  });

  test('rejects empty steps', () => {
    expect(() => new ChainWorkflow(ChatClient.create(new ScriptedChatModel([])), [])).toThrow(
      /at least one/,
    );
  });
});

class ConcurrentFakeModel {
  readonly calls: string[] = [];
  async call(prompt: {
    messages: readonly { text: string | null; messageType?: string }[];
    options?: { signal?: AbortSignal };
  }) {
    if (prompt.options?.signal?.aborted) {
      throw new Error('cancelled');
    }
    const user =
      [...prompt.messages].reverse().find((m) => m.messageType === 'user' || m.text)?.text ?? '';
    this.calls.push(user);
    await Bun.sleep(5);
    const { ChatResponse } = await import('../src/chat/model/chat-response.ts');
    return ChatResponse.of(`done:${user}`);
  }
}

describe('ParallelizationWorkflow', () => {
  test('maps inputs to ordered results', async () => {
    const concurrent = new ConcurrentFakeModel();
    const model = concurrent as unknown as import('../src/chat/model/chat-model.ts').ChatModel;
    const client = ChatClient.create(model);
    const workflow = new ParallelizationWorkflow(client);
    const results = await workflow.parallel('Analyze stakeholder.', [
      'Customers',
      'Employees',
      'Investors',
    ]);
    expect(results).toEqual(['done:Customers', 'done:Employees', 'done:Investors']);
    expect(concurrent.calls).toHaveLength(3);
  });
});

describe('RoutingWorkflow', () => {
  test('classifies then invokes route system prompt', async () => {
    const model = new ScriptedChatModel([
      {
        when: requestContains('router'),
        respond: JSON.stringify({
          route: 'billing',
          reasoning: 'double charge',
        }),
      },
      {
        when: requestContains('billing specialist'),
        respond: 'Refund initiated',
      },
    ]);
    const client = ChatClient.create(model);
    const detailed = await new RoutingWorkflow(client).routeDetailed('I was charged twice', {
      billing: 'You are a billing specialist. Help with charges.',
      technical: 'You are a technical support engineer.',
      general: 'You are general support.',
    });
    expect(detailed.route).toBe('billing');
    expect(detailed.result).toBe('Refund initiated');
  });

  test('falls back when route is unknown', async () => {
    const model = new ScriptedChatModel([
      {
        when: requestContains('router'),
        respond: JSON.stringify({ route: 'unknown-route' }),
      },
      {
        respond: 'general help',
      },
    ]);
    const result = await new RoutingWorkflow(ChatClient.create(model)).route(
      'hi',
      {
        billing: 'billing',
        general: 'general system',
      },
      { defaultRoute: 'general' },
    );
    expect(result).toBe('general help');
  });

  test('supports function routes', async () => {
    const model = new ScriptedChatModel([
      {
        respond: JSON.stringify({ route: 'custom' }),
      },
    ]);
    const result = await new RoutingWorkflow(ChatClient.create(model)).route('x', {
      custom: async (input) => `handled:${input}`,
    });
    expect(result).toBe('handled:x');
  });
});

describe('OrchestratorWorkersWorkflow', () => {
  test('plans, runs workers, synthesizes', async () => {
    const model = new ScriptedChatModel([
      {
        when: requestContains('orchestrator'),
        respond: JSON.stringify({
          analysis: 'Need technical and user docs',
          tasks: [
            { type: 'technical', description: 'Write API docs' },
            { type: 'user', description: 'Write user guide' },
          ],
        }),
      },
      {
        when: requestContains('Write API docs'),
        respond: 'TECH DOCS',
      },
      {
        when: requestContains('Write user guide'),
        respond: 'USER DOCS',
      },
      {
        when: requestContains('synthesize'),
        respond: 'COMBINED DOCS',
      },
    ]);

    const result = await new OrchestratorWorkersWorkflow(ChatClient.create(model)).process(
      'Document the REST API',
      {
        // Scripted model is sequential — force concurrency 1
        concurrency: 1,
      },
    );

    expect(result.analysis).toContain('technical');
    expect(result.workerResponses).toHaveLength(2);
    expect(result.workerResponses.map((w) => w.result)).toEqual(['TECH DOCS', 'USER DOCS']);
    expect(result.finalResponse).toBe('COMBINED DOCS');
  });
});

describe('EvaluatorOptimizerWorkflow', () => {
  test('refines until evaluator passes', async () => {
    let gen = 0;
    const model = new ScriptedChatModel([
      {
        when: requestContains('generate'),
        respond: () => {
          gen += 1;
          return gen === 1 ? 'draft v1' : 'draft v2 polished';
        },
      },
      {
        when: requestContains('evaluate'),
        respond: () =>
          gen === 1
            ? JSON.stringify({ pass: false, feedback: 'needs polish' })
            : JSON.stringify({ pass: true, feedback: 'looks good', score: 0.95 }),
      },
      {
        when: requestContains('generate'),
        respond: 'draft v2 polished',
      },
      {
        when: requestContains('evaluate'),
        respond: JSON.stringify({
          pass: true,
          feedback: 'looks good',
          score: 0.95,
        }),
      },
    ]);

    // System prompts contain "generate"/"evaluate"? Our defaults say "You generate" and "You evaluate"
    // requestContains is case-insensitive on message text which includes system+user via getContents?
    // requestContains only checks message texts - system is a message so "You generate" matches generate.

    const refined = await new EvaluatorOptimizerWorkflow(ChatClient.create(model)).loop(
      'Create a counter class',
      { maxIterations: 3 },
    );

    expect(refined.solution).toContain('polished');
    expect(refined.chainOfThought.length).toBeGreaterThanOrEqual(2);
    expect(refined.chainOfThought.at(-1)?.evaluation?.pass).toBe(true);
  });
});

describe('ChatAgent', () => {
  test('runs tool-calling loop via ChatClient', async () => {
    const weather = functionToolCallback({
      name: 'getWeather',
      description: 'weather',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      call: ({ city }: { city: string }) => ({ temp: 68, city }),
    });

    const model = new ScriptedChatModel([
      {
        respond: toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]),
      },
      { respond: '68F in Yorktown' },
    ]);

    const agent = ChatAgent.create({
      chatModel: model,
      system: 'Help with weather.',
      tools: [weather],
    });

    const { content } = await agent.chat('Weather in Yorktown?');
    expect(content).toBe('68F in Yorktown');
  });

  test('uses conversation memory across turns', async () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(20).build();
    const model = new ScriptedChatModel([
      { respond: 'Hello Alice' },
      {
        respond: (p) => {
          // Second turn should include prior history (Alice)
          const texts = p.messages.map((m) => m.text ?? '').join(' ');
          expect(texts).toContain('Alice');
          return 'Your name is Alice';
        },
      },
    ]);

    const agent = ChatAgent.create({
      chatModel: model,
      memory,
      defaultConversationId: 'c1',
    });

    await agent.chat("Hi, I'm Alice");
    const second = await agent.chat('What is my name?');
    expect(second.content).toBe('Your name is Alice');
    expect(second.conversationId).toBe('c1');
  });
});
