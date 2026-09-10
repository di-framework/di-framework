import { describe, expect, test } from 'bun:test';

describe('sqlite open registry', () => {
  test('ignores unreadable process env when resolving backend overrides', async () => {
    const { requestedSqliteBackend } = await import('../src/sqlite/open');
    const originalProcess = globalThis.process;
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: {
        get env() {
          throw new Error('env unavailable');
        },
      },
    });
    try {
      expect(requestedSqliteBackend()).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'process', { configurable: true, value: originalProcess });
    }
  });
});
