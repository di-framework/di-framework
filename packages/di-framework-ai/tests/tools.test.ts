import { describe, expect, test } from 'bun:test';
import {
  type CallAdvisor,
  type CallAdvisorChain,
  ChatClient,
  type ChatClientRequest,
  createToolCallingManager,
  DEFAULT_TOOL_CALLING_ORDER,
  FunctionToolCallback,
  functionToolCallback,
  hasToolCalls,
  isToolResponseMessage,
  Prompt,
  ScriptedChatModel,
  staticToolCallbackProvider,
  ToolCallingAdvisor,
  ToolContext,
  ToolExecutionException,
  textResponse,
  toolCall,
  toolCallResponse,
  toolDefinition,
  userMessage,
} from '../src/index.ts';

describe('ToolDefinition / FunctionToolCallback', () => {
  test('toolDefinition defaults description and schema', () => {
    const def = toolDefinition({ name: 'getWeather' });
    expect(def.name).toBe('getWeather');
    expect(def.description).toBe('get Weather');
    expect(def.inputSchema).toContain('object');
  });

  test('functionToolCallback parses JSON and returns stringified result', async () => {
    const cb = functionToolCallback<{ city: string }, { temp: number }>({
      name: 'getWeather',
      description: 'weather lookup',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      call: ({ city }) => ({ temp: 72, city }),
    });

    const result = await cb.call('{"city":"Yorktown"}');
    expect(JSON.parse(result)).toEqual({ temp: 72, city: 'Yorktown' });
    expect(cb.toolDefinition.name).toBe('getWeather');
  });

  test('functionToolCallback wraps execution errors', async () => {
    const cb = functionToolCallback({
      name: 'boom',
      call: () => {
        throw new Error('nope');
      },
    });

    await expect(cb.call('{}')).rejects.toBeInstanceOf(ToolExecutionException);
  });

  test('tool context is passed through', async () => {
    let seen: unknown;
    const cb = functionToolCallback({
      name: 'ctx',
      call: (_input, context) => {
        seen = context?.get('userId');
        return 'ok';
      },
    });

    await cb.call('{}', new ToolContext({ userId: 'u-1' }));
    expect(seen).toBe('u-1');
  });

  test('staticToolCallbackProvider exposes callbacks', () => {
    const a = functionToolCallback({ name: 'a', call: () => 'a' });
    const provider = staticToolCallbackProvider([a]);
    expect(provider.getToolCallbacks()).toHaveLength(1);
  });
});

describe('ToolCallingManager', () => {
  test('executeToolCalls appends assistant + tool response messages', async () => {
    const weather = functionToolCallback<{ city: string }>({
      name: 'getWeather',
      call: ({ city }) => `sunny in ${city}`,
    });

    const manager = createToolCallingManager();
    const prompt = Prompt.fromMessages([userMessage('weather?')], {
      toolCallbacks: [weather],
    });

    const response = toolCallResponse([toolCall('call-1', 'getWeather', { city: 'Yorktown' })]);

    const result = await manager.executeToolCalls(prompt, response);
    expect(result.returnDirect).toBe(false);
    expect(result.conversationHistory).toHaveLength(3);
    expect(result.conversationHistory[1]?.messageType).toBe('assistant');
    expect(result.conversationHistory[2]?.messageType).toBe('tool');

    const toolMsg = result.conversationHistory[2]!;
    expect(isToolResponseMessage(toolMsg)).toBe(true);
    if (isToolResponseMessage(toolMsg)) {
      expect(toolMsg.responses[0]?.responseData).toBe('sunny in Yorktown');
      expect(toolMsg.responses[0]?.id).toBe('call-1');
    }
  });

  test('returnDirect is true when metadata says so', async () => {
    const cb = functionToolCallback({
      name: 'direct',
      returnDirect: true,
      call: () => 'payload',
    });

    const manager = createToolCallingManager();
    const prompt = new Prompt('hi', { toolCallbacks: [cb] });
    const response = toolCallResponse([toolCall('1', 'direct', {})]);

    const result = await manager.executeToolCalls(prompt, response);
    expect(result.returnDirect).toBe(true);
  });

  test('resolveToolDefinitions maps callbacks', () => {
    const cb = functionToolCallback({ name: 'x', description: 'X', call: () => '' });
    const defs = createToolCallingManager().resolveToolDefinitions({
      toolCallbacks: [cb],
    });
    expect(defs).toEqual([cb.toolDefinition]);
  });
});

describe('ChatClient tools + ToolCallingAdvisor', () => {
  test('end-to-end tool loop with ScriptedChatModel', async () => {
    const weather = functionToolCallback<{ city: string }>({
      name: 'getWeather',
      description: 'Get weather for a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      call: ({ city }) => ({ city, tempF: 68, conditions: 'clear' }),
    });

    const model = new ScriptedChatModel([
      {
        respond: toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]),
      },
      {
        when: (prompt) =>
          prompt.messages.some(
            (m) =>
              isToolResponseMessage(m) &&
              m.responses.some((r) => r.responseData.includes('Yorktown')),
          ),
        respond: textResponse('It is 68°F and clear in Yorktown.'),
      },
    ]);

    const client = ChatClient.create(model);

    const answer = await client
      .prompt()
      .system('Answer weather questions concisely.')
      .user('What is the weather in Yorktown?')
      .tools(weather)
      .call()
      .content();

    expect(answer).toBe('It is 68°F and clear in Yorktown.');
    expect(model.calls).toHaveLength(2);

    // Second call should include tool response history
    const second = model.calls[1]!;
    expect(second.messages.some(isToolResponseMessage)).toBe(true);
    expect(second.options?.toolCallbacks).toHaveLength(1);
  });

  test('tools appear on toRequest options', () => {
    const cb = functionToolCallback({ name: 'ping', call: () => 'pong' });
    const request = ChatClient.create(new ScriptedChatModel([]))
      .prompt()
      .user('hi')
      .tools(cb)
      .toolContext({ tenant: 't1' })
      .toRequest();

    expect(request.prompt.options?.toolCallbacks).toHaveLength(1);
    expect(request.prompt.options?.toolContext).toEqual({ tenant: 't1' });
  });

  test('builder defaultTools apply when call tools omitted', async () => {
    const calls: string[] = [];
    const cb = functionToolCallback({
      name: 'echo',
      call: (input: { text: string }) => {
        calls.push(input.text);
        return input.text;
      },
    });

    const model = new ScriptedChatModel([
      {
        respond: toolCallResponse([toolCall('1', 'echo', { text: 'hello' })]),
      },
      { respond: textResponse('done') },
    ]);

    const client = ChatClient.builder(model).defaultTools(cb).build();
    const content = await client.prompt().user('q').call().content();
    expect(content).toBe('done');
    expect(calls).toEqual(['hello']);
  });

  test('returnDirect short-circuits the model loop', async () => {
    const cb = functionToolCallback({
      name: 'lookup',
      returnDirect: true,
      call: () => 'direct-result',
    });

    const model = new ScriptedChatModel([
      {
        respond: toolCallResponse([toolCall('1', 'lookup', {})]),
      },
      { respond: textResponse('should-not-run') },
    ]);

    const content = await ChatClient.create(model).prompt().user('q').tools(cb).call().content();

    expect(content).toBe('direct-result');
    expect(model.calls).toHaveLength(1);
  });

  test('explicit ToolCallingAdvisor is not double-registered', async () => {
    let toolAdvisorPasses = 0;
    const counter: CallAdvisor = {
      name: 'counter',
      order: DEFAULT_TOOL_CALLING_ORDER + 100,
      async adviseCall(request: ChatClientRequest, chain: CallAdvisorChain) {
        toolAdvisorPasses += 1;
        return chain.nextCall(request);
      },
    };

    const model = new ScriptedChatModel([
      {
        respond: toolCallResponse([toolCall('1', 'noop', {}, 'function')]),
      },
      { respond: textResponse('final') },
    ]);

    // noop tool
    const noop = functionToolCallback({ name: 'noop', call: () => 'ok' });

    await ChatClient.create(model)
      .prompt()
      .user('q')
      .tools(noop)
      .advisors(ToolCallingAdvisor.builder().build(), counter)
      .call()
      .content();

    // counter sits after tool advisor: once per model round (tool call + final)
    expect(toolAdvisorPasses).toBe(2);
  });

  test('advisors after ToolCallingAdvisor see every tool iteration', async () => {
    const rounds: number[] = [];
    let n = 0;
    const counter: CallAdvisor = {
      name: 'round-counter',
      order: DEFAULT_TOOL_CALLING_ORDER + 50,
      async adviseCall(request, chain) {
        n += 1;
        rounds.push(request.prompt.messages.length);
        return chain.nextCall(request);
      },
    };

    const tool = functionToolCallback({
      name: 'step',
      call: () => 'step-ok',
    });

    const model = new ScriptedChatModel([
      { respond: toolCallResponse([toolCall('a', 'step', {})]) },
      { respond: textResponse('all done') },
    ]);

    await ChatClient.create(model)
      .prompt()
      .user('go')
      .tools(tool)
      .advisors(counter)
      .call()
      .content();

    expect(n).toBe(2);
    // second round has more messages (history + tool responses)
    expect(rounds[1]!).toBeGreaterThan(rounds[0]!);
  });

  test('stream path completes tool loop and yields final answer', async () => {
    const tool = functionToolCallback({
      name: 'add',
      call: (input: { a: number; b: number }) => String(input.a + input.b),
    });

    const model = new ScriptedChatModel([
      {
        respond: toolCallResponse([toolCall('1', 'add', { a: 2, b: 3 })]),
      },
      { respond: textResponse('5') },
    ]);

    // Fake stream via FakeChatModel-like: ScriptedChatModel has no stream.
    // Use a thin wrapper.
    const streamingModel = {
      options: model.options,
      call: (p: Prompt) => model.call(p),
      async *stream(prompt: Prompt) {
        const response = await model.call(prompt);
        yield response;
      },
    };

    const chunks: string[] = [];
    for await (const part of ChatClient.create(streamingModel)
      .prompt()
      .user('2+3?')
      .tools(tool)
      .stream()
      .content()) {
      chunks.push(part);
    }

    expect(chunks.at(-1)).toBe('5');
    expect(model.calls).toHaveLength(2);
  });

  test('without tools, ToolCallingAdvisor is a no-op pass-through', async () => {
    const model = new ScriptedChatModel([{ respond: textResponse('plain') }]);
    const content = await ChatClient.create(model).prompt().user('hi').call().content();
    expect(content).toBe('plain');
    expect(model.calls).toHaveLength(1);
  });

  test('FunctionToolCallback class export works', () => {
    const cb = new FunctionToolCallback({
      name: 'klass',
      call: () => 1,
    });
    expect(cb.toolDefinition.name).toBe('klass');
  });
});

describe('hasToolCalls helper', () => {
  test('detects tool calls on assistant messages', () => {
    const response = toolCallResponse([toolCall('1', 'x', {})]);
    expect(response.hasToolCalls()).toBe(true);
    expect(hasToolCalls(response.getResult()!.output)).toBe(true);
  });
});
