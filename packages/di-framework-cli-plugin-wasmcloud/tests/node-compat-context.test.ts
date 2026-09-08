import { describe, expect, it } from 'bun:test';
import { AsyncLocalStorage, AsyncResource } from '../src/node-compat/async-hooks';

describe('guest async context scopes', () => {
  it('restores nested scopes on return and throw and binds snapshots', () => {
    const storage = new AsyncLocalStorage<string>();
    let bound!: () => string | undefined;
    storage.run('outer', () => {
      bound = AsyncLocalStorage.bind(() => storage.getStore());
      expect(storage.run('inner', () => storage.getStore())).toBe('inner');
      expect(storage.getStore()).toBe('outer');
      expect(storage.exit(() => storage.getStore())).toBeUndefined();
      expect(() =>
        storage.run('bad', () => {
          throw new Error('failure');
        }),
      ).toThrow('failure');
      expect(storage.getStore()).toBe('outer');
      const resource = new AsyncResource('probe');
      expect(resource.runInAsyncScope(() => storage.getStore(), null)).toBe('outer');
    });
    expect(storage.getStore()).toBeUndefined();
    expect(bound()).toBe('outer');
    storage.disable();
    expect(bound()).toBeUndefined();
  });
  it('keeps separate storage instances and preserves callback this/arguments', () => {
    const first = new AsyncLocalStorage<number>({ defaultValue: 0, name: 'first' });
    const second = new AsyncLocalStorage<number>();
    expect(first.name).toBe('first');
    expect(first.getStore()).toBe(0);
    first.run(1, () =>
      second.run(2, () => {
        const bound = AsyncLocalStorage.bind(function (this: { value: number }, n: number) {
          return [first.getStore(), second.getStore(), this.value, n];
        });
        expect(bound.call({ value: 3 }, 4)).toEqual([1, 2, 3, 4]);
      }),
    );
    expect(second.getStore()).toBeUndefined();
  });
});
