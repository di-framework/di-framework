import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { StorageAdapter } from '../src/adapter';
import { BaseRepository, SoftDeleteRepository } from '../src/repository';

interface User {
  id: string;
  name: string;
}

class MockAdapter<E, ID> implements StorageAdapter<E, ID> {
  findById = mock(async (id: ID) => null as E | null);
  findMany = mock(async (ids: ID[]) => [] as E[]);
  findAll = mock(async () => [] as E[]);
  save = mock(async (entity: E) => entity);
  delete = mock(async (id: ID) => true);
  count = mock(async () => 0);
  exists = mock(async (id: ID) => false);
  findPaginated = mock(async (params: any) => ({
    items: [],
    total: 0,
    page: 1,
    size: 10,
    pages: 0,
  }));
  transactionMock = mock(async () => {});
  async transaction<T>(fn: (adapter: this) => Promise<T>): Promise<T> {
    await this.transactionMock();
    return fn(this);
  }
  dispose = mock(async () => {});
}

class UserRepository extends BaseRepository<User, string> {
  constructor(adapter: StorageAdapter<User, string>) {
    super(adapter);
  }

  // Expose protected methods for testing
  public testNormalizeId(id: string) {
    return this.normalizeId(id);
  }

  public async testInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.inTransaction(fn);
  }
}

describe('BaseRepository', () => {
  let adapter: MockAdapter<User, string>;
  let repo: UserRepository;

  beforeEach(() => {
    adapter = new MockAdapter<User, string>();
    repo = new UserRepository(adapter);
  });

  test('findById delegates to adapter with normalized id', async () => {
    const user = { id: '1', name: 'Alice' };
    adapter.findById.mockResolvedValueOnce(user);

    // Pass number to test normalization to string
    const result = await repo.findById(1 as any);

    expect(adapter.findById).toHaveBeenCalledWith('1');
    expect(result).toBe(user);
  });

  test('findAll delegates to adapter', async () => {
    await repo.findAll();
    expect(adapter.findAll).toHaveBeenCalled();
  });

  test('findMany delegates to adapter with normalized ids', async () => {
    await repo.findMany([1, '2'] as any);
    expect(adapter.findMany).toHaveBeenCalledWith(['1', '2']);
  });

  test('save delegates to adapter', async () => {
    const user = { id: '1', name: 'Alice' };
    await repo.save(user);
    expect(adapter.save).toHaveBeenCalledWith(user);
  });

  test('delete delegates to adapter with normalized id', async () => {
    await repo.delete(1 as any);
    expect(adapter.delete).toHaveBeenCalledWith('1');
  });

  test('findPaginated delegates to adapter', async () => {
    const params = { page: 1, size: 10, customFilter: 'value' };
    await repo.findPaginated(params);
    expect(adapter.findPaginated).toHaveBeenCalledWith(params);
  });

  test('inTransaction delegates to adapter.transaction', async () => {
    const txFn = async () => 'result';

    const result = await repo.testInTransaction(txFn);

    expect(adapter.transactionMock).toHaveBeenCalled();
    expect(result).toBe('result');
  });

  test('inTransaction falls back when adapter has no transaction method', async () => {
    const txFn = async () => 'result';
    const adapterWithoutTx = new MockAdapter<User, string>();
    adapterWithoutTx.transaction = undefined as any;
    const repoWithoutTx = new UserRepository(adapterWithoutTx);

    const result = await repoWithoutTx.testInTransaction(txFn);

    expect(result).toBe('result');
  });

  test('dispose delegates to adapter.dispose', async () => {
    await repo.dispose();
    expect(adapter.dispose).toHaveBeenCalled();
  });

  test('dispose handles adapter without dispose method safely', async () => {
    const adapterWithoutDispose = new MockAdapter<User, string>();
    adapterWithoutDispose.dispose = undefined as any;
    const repoWithoutDispose = new UserRepository(adapterWithoutDispose);

    await expect(repoWithoutDispose.dispose()).resolves.toBeUndefined();
  });
});

interface SoftUser {
  id: string;
  name: string;
  deletedAt: Date | null;
}

class MySoftDeleteRepo extends SoftDeleteRepository<SoftUser, string> {
  softDelete = mock(async (id: string) => true);
  restore = mock(async (id: string) => true);
  findActive = mock(async () => []);
  findDeleted = mock(async () => []);
  afterNotifyDelete = mock((id: string) => {});

  constructor(adapter: StorageAdapter<SoftUser, string>) {
    super(adapter);
  }
}

describe('SoftDeleteRepository', () => {
  test('softDeleteAndNotify orchestrates calls', async () => {
    const adapter = new MockAdapter<SoftUser, string>();
    const repo = new MySoftDeleteRepo(adapter);

    const result = await repo.softDeleteAndNotify('1');

    expect(repo.softDelete).toHaveBeenCalledWith('1');
    expect(repo.afterNotifyDelete).toHaveBeenCalledWith('1');
    expect(result).toBe(true);
  });

  test('softDeleteAndNotify does not notify if delete fails', async () => {
    const adapter = new MockAdapter<SoftUser, string>();
    const repo = new MySoftDeleteRepo(adapter);
    repo.softDelete.mockResolvedValueOnce(false);

    const result = await repo.softDeleteAndNotify('1');

    expect(repo.softDelete).toHaveBeenCalledWith('1');
    expect(repo.afterNotifyDelete).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });
});
