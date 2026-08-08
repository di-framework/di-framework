import { beforeEach, describe, expect, test } from 'bun:test';
import { InMemoryRepository } from '../src/in-memory';

interface User {
  id: string;
  name: string;
  age: number;
}

class UserRepository extends InMemoryRepository<User, string> {}

describe('InMemoryRepository', () => {
  let repo: UserRepository;

  beforeEach(() => {
    repo = new UserRepository();
  });

  test('should return null for non-existent entity', async () => {
    expect(await repo.findById('1')).toBeNull();
  });

  test('should save and find entity', async () => {
    const user = { id: '1', name: 'Alice', age: 30 };
    await repo.save(user);

    const found = await repo.findById('1');
    expect(found).toEqual(user);
  });

  test('should find all entities', async () => {
    await repo.save({ id: '1', name: 'Alice', age: 30 });
    await repo.save({ id: '2', name: 'Bob', age: 25 });

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
  });

  test('should find many entities by ids', async () => {
    await repo.save({ id: '1', name: 'Alice', age: 30 });
    await repo.save({ id: '2', name: 'Bob', age: 25 });
    await repo.save({ id: '3', name: 'Charlie', age: 35 });

    const many = await repo.findMany(['1', '3', '4']);
    expect(many).toHaveLength(2);
    expect(many.map((u) => u.name)).toEqual(['Alice', 'Charlie']);
  });

  test('should delete entity', async () => {
    await repo.save({ id: '1', name: 'Alice', age: 30 });
    expect(await repo.delete('1')).toBe(true);
    expect(await repo.delete('2')).toBe(false);
    expect(await repo.findById('1')).toBeNull();
  });

  test('should upsert entity', async () => {
    const user = { id: '1', name: 'Alice', age: 30 };
    await repo.upsert(user);

    expect(await repo.findById('1')).toEqual(user);

    await repo.upsert({ id: '1', name: 'Alice Updated', age: 31 });
    expect((await repo.findById('1'))?.name).toBe('Alice Updated');
  });

  test('should find paginated with filters', async () => {
    await repo.save({ id: '1', name: 'Alice', age: 30 });
    await repo.save({ id: '2', name: 'Bob', age: 30 });
    await repo.save({ id: '3', name: 'Charlie', age: 25 });
    await repo.save({ id: '4', name: 'David', age: 30 });

    const result = await repo.findPaginated({ age: 30, page: 1, size: 2 });
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.pages).toBe(2);
    expect(result.page).toBe(1);

    const resultPage2 = await repo.findPaginated({ age: 30, page: 2, size: 2 });
    expect(resultPage2.items).toHaveLength(1);
    expect(resultPage2.items[0]?.name).toBe('David');
  });

  test('should support supportsConditionalWrite type guard', () => {
    const { supportsConditionalWrite } = require('../src/adapter');
    expect(supportsConditionalWrite(repo)).toBe(true);
    expect(supportsConditionalWrite({})).toBe(false);
  });

  test('saveIfAbsent saves entity only if absent', async () => {
    const user = { id: '1', name: 'Alice', age: 30 };
    expect(await repo.saveIfAbsent(user)).toBe(true);
    expect(await repo.findById('1')).toEqual(user);
    expect(await repo.saveIfAbsent({ id: '1', name: 'Alice 2', age: 31 })).toBe(false);
    expect((await repo.findById('1'))?.name).toBe('Alice');
  });

  test('compareAndSwap mutates entity atomically or aborts when null returned', async () => {
    await repo.save({ id: '1', name: 'Alice', age: 30 });
    const aborted = await repo.compareAndSwap('1', (current) => {
      if (current?.age !== 25) return null;
      return { ...current, age: 26 };
    });
    expect(aborted).toBe(false);
    expect((await repo.findById('1'))?.age).toBe(30);

    const swapped = await repo.compareAndSwap('1', (current) => {
      if (current?.age !== 30) return null;
      return { ...current, age: 31 };
    });
    expect(swapped).toBe(true);
    expect((await repo.findById('1'))?.age).toBe(31);
  });

  test('contention: concurrent saveIfAbsent has exactly 1 winner', async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      repo.saveIfAbsent({ id: 'concurrent-1', name: `User ${i}`, age: i }),
    );
    const results = await Promise.all(promises);
    const winners = results.filter((r) => r === true);
    expect(winners).toHaveLength(1);
  });

  test('contention: concurrent compareAndSwap has at most 1 winner per observed state', async () => {
    await repo.save({ id: 'concurrent-cas', name: 'Original', age: 0 });

    // 50 concurrent requests competing to transition age from 0 to 1
    const promises = Array.from({ length: 50 }, () =>
      repo.compareAndSwap('concurrent-cas', (current) => {
        if (current?.age !== 0) return null;
        return { ...current, age: 1 };
      }),
    );
    const results = await Promise.all(promises);
    const winners = results.filter((r) => r === true);
    expect(winners).toHaveLength(1);
    expect((await repo.findById('concurrent-cas'))?.age).toBe(1);
  });
});
