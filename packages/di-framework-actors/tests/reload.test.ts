import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Actor,
  ActorContext,
  ActorMethod,
  ActorReloadError,
  ActorRuntime,
  SqliteActorStorage,
} from '../src/index';

describe('Actor Hot Reload', () => {
  let tmpDir: string;
  let storage: SqliteActorStorage;
  let runtime: ActorRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-reload-test-'));
    storage = new SqliteActorStorage({ baseDir: tmpDir });
    runtime = new ActorRuntime({ storage, namespace: 'test-ns' });
  });

  afterEach(async () => {
    await runtime.clear();
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('drains outstanding work according to drain policy during reload and preserves state', async () => {
    let deactivated = false;

    @Actor()
    class LongWorkerActor {
      @ActorContext()
      ctx!: ActorContext;

      onDeactivate() {
        deactivated = true;
      }

      @ActorMethod()
      async doWork(val: number): Promise<number> {
        await new Promise((r) => setTimeout(r, 40));
        await this.ctx.storage.set('result', val);
        return val * 2;
      }

      @ActorMethod()
      async getResult(): Promise<number> {
        return (await this.ctx.storage.get('result')) ?? 0;
      }
    }

    runtime.register(LongWorkerActor);
    const ref = runtime.get(LongWorkerActor, 'worker-1');

    // Launch async work
    const workPromise = ref.doWork(21);

    // Trigger reload with drain policy while work is in flight
    const reloadPromise = runtime.reload({
      policy: 'drain',
      timeoutMs: 2000,
    });

    const [workResult, reloadResult] = await Promise.all([workPromise, reloadPromise]);

    expect(workResult).toBe(42);
    expect(reloadResult.policy).toBe('drain');
    expect(reloadResult.success).toBe(true);
    expect(deactivated).toBe(true);

    // After reload, verify committed state was preserved on disk
    const refAfter = runtime.get(LongWorkerActor, 'worker-1');
    expect(await refAfter.getResult()).toBe(21);
  });

  it('explicitly fails queued unstarted work when policy is fail', async () => {
    @Actor()
    class SlowQueueActor {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async slowTask(): Promise<string> {
        await new Promise((r) => setTimeout(r, 60));
        return 'slow-done';
      }

      @ActorMethod()
      async quickTask(): Promise<string> {
        return 'quick-done';
      }
    }

    runtime.register(SlowQueueActor);
    const ref = runtime.get(SlowQueueActor, 'queue-1');

    // 1. First task is actively processing
    const firstCall = ref.slowTask();

    // 2. Second task is queued behind it
    let secondError: any;
    const secondCall = ref.quickTask().catch((err) => {
      secondError = err;
    });

    // Small yield so first task starts executing
    await new Promise((r) => setTimeout(r, 10));

    // Reload with policy: fail
    const reloadPromise = runtime.reload({
      policy: 'fail',
      timeoutMs: 2000,
    });

    // First call should complete because it was already executing
    const firstRes = await firstCall;
    expect(firstRes).toBe('slow-done');

    // Second call was pending in queue and should fail with ActorReloadError
    await secondCall;
    expect(secondError).toBeInstanceOf(ActorReloadError);

    await reloadPromise;
  });

  it('releases resources without creating overlapping owners and allows immediate reactivation', async () => {
    @Actor()
    class SessionActor {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async login(username: string): Promise<string> {
        await this.ctx.storage.set('user', username);
        return `logged in as ${username}`;
      }

      @ActorMethod()
      async getUser(): Promise<string> {
        return (await this.ctx.storage.get('user')) ?? 'anonymous';
      }
    }

    runtime.register(SessionActor);
    const session = runtime.get(SessionActor, 'user-42');
    await session.login('alice');

    // Reload runtime (releases lock and connection)
    const res = await runtime.reload();
    expect(res.success).toBe(true);

    // Immediately invoke reloaded actor without lock collision
    const sessionAfter = runtime.get(SessionActor, 'user-42');
    expect(await sessionAfter.getUser()).toBe('alice');
  });

  it('applies pending actor migrations before resuming calls after reload', async () => {
    // Initial version with V1 migration
    @Actor({
      migrations: [
        {
          version: '1',
          description: 'v1 init',
          up: async (ctx) => {
            await ctx.db.run('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT);');
          },
        },
      ],
    })
    class NoteActor {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async addNote(id: string, body: string): Promise<void> {
        await (this.ctx.storage as any)
          .getDatabase()
          .run('INSERT INTO notes (id, body) VALUES (?, ?);', [id, body]);
      }
    }

    runtime.register(NoteActor);
    const ref = runtime.get(NoteActor, 'note-1');
    await ref.addNote('n1', 'First note');

    // Hot reload with updated class containing V2 migration
    @Actor({
      name: 'NoteActor',
      migrations: [
        {
          version: '1',
          description: 'v1 init',
          up: async (ctx) => {
            await ctx.db.run('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT);');
          },
        },
        {
          version: '2',
          description: 'v2 add author column',
          up: async (ctx) => {
            await ctx.db.run("ALTER TABLE notes ADD COLUMN author TEXT DEFAULT 'system';");
          },
        },
      ],
    })
    class NoteActorV2 {
      @ActorContext()
      ctx!: ActorContext;

      @ActorMethod()
      async getNote(id: string): Promise<any> {
        const rows = await (this.ctx.storage as any)
          .getDatabase()
          .query('SELECT * FROM notes WHERE id = ?;')
          .all(id);
        return rows[0];
      }
    }

    // Reload with new NoteActorV2 class
    await runtime.reload({
      actors: [NoteActorV2],
    });

    // Invoke NoteActorV2 - V2 migration must have been automatically applied before call!
    const refV2 = runtime.get(NoteActorV2, 'note-1');
    const note = await refV2.getNote('n1');
    expect(note.id).toBe('n1');
    expect(note.body).toBe('First note');
    expect(note.author).toBe('system');
  });

  it('captures migration failure diagnostics during activation and prevents calls', async () => {
    @Actor({
      migrations: [
        {
          version: '1',
          description: 'bad migration',
          up: async (ctx) => {
            throw new Error('Syntax error in migration schema');
          },
        },
      ],
    })
    class BrokenMigrationActor {
      @ActorMethod()
      async ping(): Promise<string> {
        return 'pong';
      }
    }

    runtime.register(BrokenMigrationActor);
    const ref = runtime.get(BrokenMigrationActor, 'broken-1');

    let thrownError: any;
    try {
      await ref.ping();
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();

    // Inspection should surface the migration failure
    const inspection = await runtime.inspect(BrokenMigrationActor, 'broken-1');
    expect(inspection).not.toBeNull();
    expect(inspection?.migrationStatus?.failedMigration).toBeDefined();
    expect(inspection?.migrationStatus?.failedMigration?.error).toContain('Syntax error');
  });
});
