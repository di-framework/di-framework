import { describe, expect, test } from 'bun:test';
import {
  assistantMessage,
  CHAT_MEMORY_CONVERSATION_ID,
  ChatClient,
  DEFAULT_CHAT_MEMORY_PRECEDENCE_ORDER,
  DEFAULT_TOOL_CALLING_ORDER,
  FakeChatModel,
  InMemoryChatMemoryRepository,
  MessageChatMemoryAdvisor,
  MessageWindowChatMemory,
  Prompt,
  processWindow,
  RecordingChatModel,
  ScriptedChatModel,
  systemMessage,
  textResponse,
  toolResponse,
  toolResponseMessage,
  userMessage,
} from '../src/index.ts';

describe('InMemoryChatMemoryRepository', () => {
  test('save, find, list ids, delete', () => {
    const repo = new InMemoryChatMemoryRepository();
    expect(repo.findConversationIds()).toEqual([]);

    repo.saveAll('c1', [userMessage('hi')]);
    expect(repo.findByConversationId('c1')).toHaveLength(1);
    expect(repo.findConversationIds()).toEqual(['c1']);

    repo.deleteByConversationId('c1');
    expect(repo.findByConversationId('c1')).toEqual([]);
  });

  test('rejects empty conversation id', () => {
    const repo = new InMemoryChatMemoryRepository();
    expect(() => repo.findByConversationId('')).toThrow(/conversationId/);
  });
});

describe('MessageWindowChatMemory', () => {
  test('builder rejects non-positive maxMessages', () => {
    expect(() => MessageWindowChatMemory.builder().maxMessages(0).build()).toThrow(/maxMessages/);
    expect(() => MessageWindowChatMemory.builder().maxMessages(-1).build()).toThrow(/maxMessages/);
  });

  test('add / get / clear single and multiple messages', () => {
    const memory = MessageWindowChatMemory.builder().build();
    const id = 'conv-1';

    memory.addMessage(id, userMessage('Hello'));
    expect(memory.get(id)).toHaveLength(1);
    expect(memory.get(id)[0]?.text).toBe('Hello');

    memory.add(id, [assistantMessage('I, Robot'), userMessage('Next')]);
    expect(memory.get(id)).toHaveLength(3);

    memory.clear(id);
    expect(memory.get(id)).toEqual([]);
  });

  test('rejects null/empty conversation id', () => {
    const memory = MessageWindowChatMemory.of();
    expect(() => memory.get('')).toThrow(/conversationId/);
    expect(() => memory.clear('')).toThrow(/conversationId/);
    expect(() => memory.add('', [userMessage('x')])).toThrow(/conversationId/);
  });

  test('customMaxMessages snaps to user turn boundary', () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(2).build();
    const id = 'w';
    memory.add(id, [
      userMessage('Message 1'),
      assistantMessage('Response 1'),
      userMessage('Message 2'),
      assistantMessage('Response 2'),
      userMessage('Message 3'),
    ]);
    // Raw cut would leave assistant orphaned; snap keeps only last USER.
    expect(memory.get(id).map((m) => m.text)).toEqual(['Message 3']);
  });

  test('no eviction when within limit', () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(3).build();
    const id = 'w';
    memory.add(id, [userMessage('Hello'), assistantMessage('Hi there')]);
    memory.add(id, [userMessage('How are you?')]);
    expect(memory.get(id).map((m) => m.text)).toEqual(['Hello', 'Hi there', 'How are you?']);
  });

  test('eviction drops oldest complete turns', () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(2).build();
    const id = 'w';
    memory.add(id, [userMessage('Message 1'), assistantMessage('Response 1')]);
    memory.add(id, [userMessage('Message 2'), assistantMessage('Response 2')]);
    expect(memory.get(id).map((m) => m.text)).toEqual(['Message 2', 'Response 2']);
  });

  test('system message preserved during eviction', () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(3).build();
    const id = 'w';
    memory.add(id, [
      systemMessage('System instruction'),
      userMessage('Message 1'),
      assistantMessage('Response 1'),
    ]);
    memory.add(id, [userMessage('Message 2'), assistantMessage('Response 2')]);
    expect(memory.get(id).map((m) => m.text)).toEqual([
      'System instruction',
      'Message 2',
      'Response 2',
    ]);
  });

  test('new system message replaces previous system messages', () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(10).build();
    const id = 'w';
    memory.add(id, [systemMessage('old'), userMessage('hi')]);
    memory.add(id, [systemMessage('new'), userMessage('again')]);
    // Old system messages dropped; remaining non-system memory then new messages.
    // (Advisor, not the memory store, reorders system to first.)
    const texts = memory.get(id).map((m) => m.text);
    expect(texts).toEqual(['hi', 'new', 'again']);
  });

  test('old system messages removed when only a new system is added', () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(2).build();
    const id = 'w';
    memory.add(id, [systemMessage('System instruction 1'), systemMessage('System instruction 2')]);
    memory.add(id, [systemMessage('System instruction 3')]);
    expect(memory.get(id).map((m) => m.text)).toEqual(['System instruction 3']);
  });

  test('processWindow export matches turn snap semantics', () => {
    const result = processWindow(
      [],
      [
        userMessage('Message 1'),
        assistantMessage('Response 1'),
        userMessage('Message 2'),
        assistantMessage('Response 2'),
        userMessage('Message 3'),
      ],
      2,
    );
    expect(result.map((m) => m.text)).toEqual(['Message 3']);
  });
});

describe('MessageChatMemoryAdvisor', () => {
  test('default order is memory precedence', () => {
    const memory = MessageWindowChatMemory.of();
    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    expect(advisor.order).toBe(DEFAULT_CHAT_MEMORY_PRECEDENCE_ORDER);
    expect(advisor.order).toBeLessThan(DEFAULT_TOOL_CALLING_ORDER);
  });

  test('custom order', () => {
    const advisor = MessageChatMemoryAdvisor.builder(MessageWindowChatMemory.of())
      .order(42)
      .build();
    expect(advisor.order).toBe(42);
  });

  test('requires conversation id in context', () => {
    const advisor = MessageChatMemoryAdvisor.of(MessageWindowChatMemory.of());
    expect(() => advisor.getConversationId(new Map())).toThrow(/conversationId/);
  });

  test('getConversationId from context', () => {
    const advisor = MessageChatMemoryAdvisor.of(MessageWindowChatMemory.of());
    const ctx = new Map<string, unknown>([[CHAT_MEMORY_CONVERSATION_ID, 'session-42']]);
    expect(advisor.getConversationId(ctx)).toBe('session-42');
  });

  test('before stores user message; after stores assistant', async () => {
    const memory = MessageWindowChatMemory.of();
    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    const model = new FakeChatModel('Hello back');

    const client = ChatClient.builder(model).defaultAdvisors(advisor).build();

    const content = await client
      .prompt()
      .user('Hello')
      .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'test-conversation' })
      .call()
      .content();

    expect(content).toBe('Hello back');
    const stored = memory.get('test-conversation');
    expect(stored).toHaveLength(2);
    expect(stored[0]?.messageType).toBe('user');
    expect(stored[0]?.text).toBe('Hello');
    expect(stored[1]?.messageType).toBe('assistant');
    expect(stored[1]?.text).toBe('Hello back');
  });

  test('second turn includes prior history in model prompt', async () => {
    const memory = MessageWindowChatMemory.of();
    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    const model = new RecordingChatModel(
      new ScriptedChatModel([
        { respond: textResponse('Noted.') },
        { respond: textResponse('Your name is Ada.') },
      ]),
    );

    const client = ChatClient.builder(model).defaultAdvisors(advisor).build();

    const ctx = { [CHAT_MEMORY_CONVERSATION_ID]: 'session-1' };

    await client.prompt().user('My name is Ada.').advisorContext(ctx).call().content();
    await client.prompt().user('What is my name?').advisorContext(ctx).call().content();

    expect(model.calls).toHaveLength(2);
    const secondPrompt = model.calls[1]!;
    const texts = secondPrompt.messages.map((m) => m.text);
    expect(texts).toContain('My name is Ada.');
    expect(texts).toContain('Noted.');
    expect(texts).toContain('What is my name?');
  });

  test('isolates conversations by id', async () => {
    const memory = MessageWindowChatMemory.of();
    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    const model = new FakeChatModel('ok');
    const client = ChatClient.builder(model).defaultAdvisors(advisor).build();

    await client
      .prompt()
      .user('from-a')
      .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'a' })
      .call()
      .content();
    await client
      .prompt()
      .user('from-b')
      .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'b' })
      .call()
      .content();

    expect(memory.get('a').map((m) => m.text)).toEqual(['from-a', 'ok']);
    expect(memory.get('b').map((m) => m.text)).toEqual(['from-b', 'ok']);
  });

  test('before with tool response stores tool message as last turn', () => {
    const memory = MessageWindowChatMemory.of();
    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    const toolMsg = toolResponseMessage([toolResponse('t1', 'getWeather', 'Sunny')]);
    const prompt = Prompt.fromMessages([
      userMessage("What's the weather?"),
      assistantMessage('Let me check...'),
      toolMsg,
    ]);
    const request = {
      prompt,
      context: new Map<string, unknown>([[CHAT_MEMORY_CONVERSATION_ID, 'test-conversation']]),
    };

    advisor.before(request);

    const stored = memory.get('test-conversation');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.messageType).toBe('tool');
  });

  test('does not duplicate memory already present in prompt', () => {
    const memory = MessageWindowChatMemory.of();
    const user = userMessage('When can I pick up dog 45?');
    const assistant = assistantMessage('', {
      toolCalls: [
        {
          id: 'call-45',
          type: 'function',
          name: 'schedulePickup',
          arguments: '{"dogId":45}',
        },
      ],
    });
    memory.add('test-conversation', [user, assistant]);

    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    const toolMsg = toolResponseMessage([
      toolResponse('call-45', 'schedulePickup', 'Pickup scheduled'),
    ]);
    const prompt = Prompt.fromMessages([user, assistant, toolMsg]);
    const request = {
      prompt,
      context: new Map<string, unknown>([[CHAT_MEMORY_CONVERSATION_ID, 'test-conversation']]),
    };

    const processed = advisor.before(request);
    expect(processed.prompt.messages).toHaveLength(3);
    expect(memory.get('test-conversation').map((m) => m.messageType)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  test('system message is moved first when mixing memory and prompt', () => {
    const memory = MessageWindowChatMemory.of();
    memory.add('c', [userMessage('prior'), assistantMessage('reply')]);
    const advisor = MessageChatMemoryAdvisor.builder(memory).build();
    const request = {
      prompt: Prompt.fromMessages([systemMessage('Be brief.'), userMessage('next')]),
      context: new Map<string, unknown>([[CHAT_MEMORY_CONVERSATION_ID, 'c']]),
    };

    const processed = advisor.before(request);
    expect(processed.prompt.messages[0]?.messageType).toBe('system');
    expect(processed.prompt.messages[0]?.text).toBe('Be brief.');
  });
});

describe('Prompt.getLastUserOrToolResponseMessage', () => {
  test('returns last user', () => {
    const p = Prompt.fromMessages([
      systemMessage('s'),
      userMessage('first'),
      assistantMessage('a'),
      userMessage('second'),
    ]);
    expect(p.getLastUserOrToolResponseMessage().text).toBe('second');
  });

  test('prefers tool response when last', () => {
    const tool = toolResponseMessage([toolResponse('1', 't', 'data')]);
    const p = Prompt.fromMessages([userMessage('q'), tool]);
    expect(p.getLastUserOrToolResponseMessage().messageType).toBe('tool');
  });

  test('empty prompt yields empty user message', () => {
    const p = Prompt.fromMessages([]);
    expect(p.getLastUserOrToolResponseMessage().text).toBe('');
  });
});
