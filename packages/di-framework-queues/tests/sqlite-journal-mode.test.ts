import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteQueueBackend } from '../src/index';

describe('SqliteQueueBackend journal mode', () => {
  const dirs: string[] = [];
  const previous = process.env.DI_SQLITE_BACKEND;

  afterEach(() => {
    if (previous === undefined) delete process.env.DI_SQLITE_BACKEND;
    else process.env.DI_SQLITE_BACKEND = previous;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const freshPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-journal-'));
    dirs.push(dir);
    return join(dir, 'queue.db');
  };

  const journalOf = (backend: SqliteQueueBackend) =>
    (backend.getDatabase().query('PRAGMA journal_mode').get() as { journal_mode: string })
      .journal_mode;

  it('keeps WAL for native Bun by default', async () => {
    delete process.env.DI_SQLITE_BACKEND;
    const backend = new SqliteQueueBackend(freshPath());
    expect(backend.journalMode).toBe('wal');
    expect(journalOf(backend)).toBe('wal');
    await backend.close();
  });

  it('uses a rollback journal with full sync when durableWasi is set', async () => {
    const backend = new SqliteQueueBackend({ path: freshPath(), durableWasi: true });
    expect(backend.journalMode).toBe('delete');
    expect(journalOf(backend)).toBe('delete');
    expect(
      (backend.getDatabase().query('PRAGMA synchronous').get() as { synchronous: number })
        .synchronous,
    ).toBe(2);
    await backend.enqueue('receipts', { id: 1 });
    expect((await backend.dequeue('receipts'))?.payload).toEqual({ id: 1 });
    await backend.close();
  });

  it('defaults to the rollback journal when DI_SQLITE_BACKEND=wasm', async () => {
    process.env.DI_SQLITE_BACKEND = 'wasm';
    const backend = new SqliteQueueBackend(freshPath());
    expect(backend.journalMode).toBe('delete');
    expect(journalOf(backend)).toBe('delete');
    await backend.close();
    const explicit = new SqliteQueueBackend({ path: freshPath(), durableWasi: false });
    expect(explicit.journalMode).toBe('wal');
    await explicit.close();
  });
});
