import { describe, expect, test } from 'bun:test';
import { assistantMessage, Prompt, systemMessage, userMessage } from '../src/index.ts';

describe('Prompt', () => {
  test('constructs from string as user message', () => {
    const prompt = new Prompt('Hello');
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.messageType).toBe('user');
    expect(prompt.messages[0]?.text).toBe('Hello');
  });

  test('exposes instructions alias', () => {
    const prompt = Prompt.fromMessages([systemMessage('sys'), userMessage('hi')]);
    expect(prompt.instructions).toHaveLength(2);
    expect(prompt.getSystemMessage().text).toBe('sys');
    expect(prompt.getUserMessage().text).toBe('hi');
  });

  test('augmentSystemMessage inserts when missing', () => {
    const prompt = new Prompt('hi').augmentSystemMessage('You are helpful.');
    expect(prompt.messages[0]?.messageType).toBe('system');
    expect(prompt.messages[0]?.text).toBe('You are helpful.');
    expect(prompt.messages[1]?.text).toBe('hi');
  });

  test('augmentUserMessage replaces last user message', () => {
    const prompt = Prompt.fromMessages([
      systemMessage('s'),
      userMessage('old'),
      assistantMessage('a'),
    ]).augmentUserMessage('new');
    expect(prompt.getUserMessage().text).toBe('new');
  });

  test('withOptions merges provider options', () => {
    const prompt = new Prompt('x', {
      temperature: 0.2,
      providerOptions: { a: 1 },
    }).withOptions({
      maxTokens: 10,
      providerOptions: { b: 2 },
    });
    expect(prompt.options?.temperature).toBe(0.2);
    expect(prompt.options?.maxTokens).toBe(10);
    expect(prompt.options?.providerOptions).toEqual({ a: 1, b: 2 });
  });
});
