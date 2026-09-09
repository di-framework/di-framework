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
} from '../src/index.js';

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
