import { describe, expect, test } from 'bun:test';
import { Repository } from '../src/decorators';

describe('Repository Decorator', () => {
  test('returns a class decorator function', () => {
    const decorator = Repository({ singleton: true });
    expect(typeof decorator).toBe('function');
  });

  test('accepts empty options', () => {
    const decorator = Repository();
    expect(typeof decorator).toBe('function');
  });
});
