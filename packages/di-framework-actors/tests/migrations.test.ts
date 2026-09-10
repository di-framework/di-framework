import { describe, expect, it } from 'bun:test';
import {
  Actor,
  ActorContext,
  ActorMethod,
  ActorMigration,
  type ActorMigrationContext,
  ActorMigrationError,
  ActorRuntime,
  SqliteActorStorage,
} from '../src/index';

@Actor({
  name: 'MigratedActor',
  migrations: [
    {
      version: 1,
      description: 'create notes table',
      up: async (ctx: ActorMigrationContext) => {
        await ctx.run(`
          CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL
          );
        `);
      },
    },
    {
      version: 2,
      description: 'seed default note',
      up: async (ctx: ActorMigrationContext) => {
        await ctx.run(`
          INSERT INTO notes (id, content) VALUES ('note-1', 'Initial Note Content');
        `);
      },
    },
  ],
})
class MigratedActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async getNote(id: string): Promise<string | null> {
    const db = this.ctx.database;
    const row = db.query('SELECT content FROM notes WHERE id = ?;').get(id) as
      | { content: string }
      | null
      | undefined;
    return row?.content ?? null;
  }

  @ActorMethod()
  async addNote(id: string, content: string): Promise<void> {
    const db = this.ctx.database;
    db.prepare('INSERT INTO notes (id, content) VALUES (?, ?);').run(id, content);
  }
}

@Actor({
  name: 'FailingMigrationActor',
  migrations: [
    {
      version: 1,
      description: 'successful initial step',
      up: async (ctx: ActorMigrationContext) => {
        await ctx.run('CREATE TABLE initial (x INT);');
      },
    },
    {
      version: 2,
      description: 'fatal migration that fails',
      up: async () => {
        throw new Error('Database disk image is corrupt or schema invalid');
      },
    },
  ],
})
class FailingMigrationActor {
  activated = false;

  async onActivate(): Promise<void> {
    this.activated = true;
  }

  @ActorMethod()
  async doSomething(): Promise<string> {
    return 'ok';
  }
}

@Actor({ name: 'DecoratorMigratedActor' })
class DecoratorMigratedActor {
  @ActorContext
  private ctx!: ActorContext;

  @ActorMethod()
  async getSetting(key: string): Promise<string | null> {
    const db = this.ctx.database;
    const row = db.query('SELECT val FROM settings WHERE key = ?;').get(key) as
      | { val: string }
      | null
      | undefined;
    return row?.val ?? null;
  }
}

@ActorMigration({
  actor: DecoratorMigratedActor,
  version: 1,
  description: 'create settings table',
})
class CreateSettingsMigration {
  async up(ctx: ActorMigrationContext): Promise<void> {
    await ctx.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, val TEXT);');
    await ctx.run("INSERT INTO settings (key, val) VALUES ('theme', 'dark');");
  }
}

describe('Actor Migrations', () => {
  it('applies pending migrations before allowing an activation to process calls', async () => {
    const storage = SqliteActorStorage.temporary();
    const runtime = new ActorRuntime({ storage });
    runtime.register(MigratedActor);

    try {
      const actor = runtime.get(MigratedActor, 'actor-1');

      // The migrations should have run automatically, creating the table and inserting note-1
      const initialNote = await actor.getNote('note-1');
      expect(initialNote).toBe('Initial Note Content');

      // Now add a note
      await actor.addNote('note-2', 'Second Note');
      expect(await actor.getNote('note-2')).toBe('Second Note');

      // Check migration history in the actor database
      const db = await storage.getDatabase('MigratedActor:actor-1');
      const history = db
        .query('SELECT version, description FROM "_migrations" ORDER BY version ASC;')
        .all() as any[];
      expect(history.length).toBe(2);
      expect(history[0].version).toBe('1');
      expect(history[0].description).toBe('create notes table');
      expect(history[1].version).toBe('2');
      expect(history[1].description).toBe('seed default note');
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });

  it('does not re-execute applied migrations upon actor deactivation and reactivation', async () => {
    const storage = SqliteActorStorage.temporary();
    const runtime = new ActorRuntime({ storage });
    runtime.register(MigratedActor);

    try {
      const actor = runtime.get(MigratedActor, 'actor-reactivate');
      expect(await actor.getNote('note-1')).toBe('Initial Note Content');

      // Deactivate the actor instance
      await runtime.deactivate(MigratedActor, 'actor-reactivate');

      // Reactivate
      const reactivated = runtime.get(MigratedActor, 'actor-reactivate');
      // If migrations re-ran with INSERT INTO, it would fail with duplicate primary key!
      expect(await reactivated.getNote('note-1')).toBe('Initial Note Content');
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });

  it('fails activation and identifies the affected actor and migration when migration fails', async () => {
    const storage = SqliteActorStorage.temporary();
    const runtime = new ActorRuntime({ storage });
    runtime.register(FailingMigrationActor);

    try {
      const actor = runtime.get(FailingMigrationActor, 'actor-bad-migration');

      let caughtError: any;
      try {
        await actor.doSomething();
      } catch (err) {
        caughtError = err;
      }

      // 1. Error must be ActorMigrationError
      expect(caughtError).toBeInstanceOf(ActorMigrationError);

      // 2. Error identifies the affected actor and migration
      expect(caughtError.actorType).toBe('FailingMigrationActor');
      expect(caughtError.actorKey).toBe('actor-bad-migration');
      expect(caughtError.migrationVersion).toBe('2');
      expect(caughtError.message).toContain('Database disk image is corrupt or schema invalid');

      // 3. Activation was prevented; instance was not activated or cached
      expect(runtime.isRegistered(FailingMigrationActor)).toBe(true);

      // 4. Subsequent calls continue to be rejected
      await expect(actor.doSomething()).rejects.toThrow(ActorMigrationError);
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });

  it('supports migrations registered via @ActorMigration decorator', async () => {
    const storage = SqliteActorStorage.temporary();
    const runtime = new ActorRuntime({ storage });
    runtime.register(DecoratorMigratedActor);

    try {
      const actor = runtime.get(DecoratorMigratedActor, 'user-prefs');
      const theme = await actor.getSetting('theme');
      expect(theme).toBe('dark');
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });

  it('supports actor migrations in inMemory mode', async () => {
    const storage = new SqliteActorStorage({ inMemory: true });
    const runtime = new ActorRuntime({ storage });
    runtime.register(MigratedActor);

    try {
      const actor = runtime.get(MigratedActor, 'mem-actor');
      expect(await actor.getNote('note-1')).toBe('Initial Note Content');
    } finally {
      await runtime.clear();
      await storage.close();
    }
  });
});

it('runs non-SQL migrations in order once per storage instance and reports failures', async () => {
  const { InMemoryActorStorage, runActorMigrations, clearInMemoryActorMigrationHistory } =
    await import('../src/index');
  const storage = new InMemoryActorStorage();
  const calls: string[] = [];
  const migrations = [
    {
      version: '1.10',
      description: 'later',
      up: async (ctx: ActorMigrationContext) => {
        calls.push(ctx.version);
        expect(await ctx.sql('')).toEqual([]);
        expect(await ctx.run('')).toEqual({ changes: 0 });
      },
    },
    {
      version: '1.2',
      description: 'earlier',
      up: async (ctx: ActorMigrationContext) => {
        calls.push(ctx.version);
        await ctx.storage.set(ctx.actorId, 'ready', true);
      },
    },
  ];
  const options = {
    actorType: 'Fallback',
    actorKey: 'key',
    compositeId: 'Fallback:key',
    storage,
    migrations,
  };
  await runActorMigrations(options);
  await runActorMigrations(options);
  expect(calls).toEqual(['1.2', '1.10']);
  const isolated = new InMemoryActorStorage();
  await runActorMigrations({ ...options, storage: isolated });
  expect(await isolated.get<boolean>('Fallback:key', 'ready')).toBe(true);
  clearInMemoryActorMigrationHistory();
  await expect(
    runActorMigrations({
      ...options,
      migrations: [
        {
          version: '3',
          description: 'failure',
          up: async () => {
            throw new Error('failed fallback');
          },
        },
      ],
    }),
  ).rejects.toThrow(ActorMigrationError);
});

it('discovers repo migrations with matching actor bindings', async () => {
  const { Migration, clearMigrationRegistry } = await import('@di-framework/repo');
  const { runActorMigrations } = await import('../src/index');
  @Migration({ version: 1, description: 'repo actor schema', binding: 'RepoActor' })
  class RepoActorMigration {
    async up(ctx: any) {
      await ctx.sql('CREATE TABLE migrated (id INT)');
    }
  }
  const storage = SqliteActorStorage.temporary();
  try {
    await runActorMigrations({
      actorType: 'RepoActor',
      actorKey: 'key',
      compositeId: 'RepoActor:key',
      storage,
    });
    const db = await storage.getDatabase('RepoActor:key');
    expect(db.query("SELECT name FROM sqlite_master WHERE name='migrated'").get()).toEqual({
      name: 'migrated',
    });
  } finally {
    clearMigrationRegistry();
    await storage.close();
  }
});

it('maps down migration contexts and preserves integrity error versions', async () => {
  const { spyOn } = await import('bun:test');
  const { MigrationRunner, MigrationIntegrityError } = await import('@di-framework/repo');
  const { runActorMigrations } = await import('../src/index');
  const storage = SqliteActorStorage.temporary();
  let context: ActorMigrationContext | undefined;
  const migrations = [
    {
      version: '1',
      description: 'reversible',
      up: async () => {},
      down: async (ctx: ActorMigrationContext) => {
        context = ctx;
      },
    },
  ];
  const options = {
    actorType: 'Reversible',
    actorKey: 'key',
    compositeId: 'Reversible:key',
    storage,
    migrations,
  };
  const execute = spyOn(MigrationRunner.prototype, 'execute').mockImplementation(async function (
    this: any,
  ) {
    const definition = this.configuredMigrations[0];
    await definition.down({
      version: '1',
      description: 'reversible',
      db: await this.getDb(),
      sql: async () => [],
      run: async () => ({ changes: 0 }),
    });
    return {} as any;
  });
  try {
    await runActorMigrations(options);
    expect(context?.actorId).toBe('Reversible:key');
    expect(context?.storage).toBe(storage);
    execute.mockImplementation(async () => {
      throw new MigrationIntegrityError('changed migration', '1');
    });
    await expect(runActorMigrations(options)).rejects.toMatchObject({ migrationVersion: '1' });
  } finally {
    execute.mockRestore();
    await storage.close();
  }
});

it('registers namespaced actors and clears actor migration registration', async () => {
  const { clearRegisteredActorMigrations, getRegisteredActorMigrations, InMemoryActorStorage } =
    await import('../src/index');
  @Actor({ namespace: 'test', name: 'Namespaced' })
  class Namespaced {
    read() {
      return 42;
    }
  }
  const runtime = new ActorRuntime({ actors: [Namespaced], storage: new InMemoryActorStorage() });
  expect(await runtime.get(Namespaced, 'key').read()).toBe(42);
  clearRegisteredActorMigrations();
  expect(getRegisteredActorMigrations(Namespaced)).toEqual([]);
});
