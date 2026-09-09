import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearMigrationRegistry,
  compareVersions,
  createMigrationDatabase,
  discoverManifestMigrations,
  discoverSqlMigrations,
  getMigrationMetadata,
  getRegisteredMigrations,
  isMigration,
  Migration,
  MigrationIntegrityError,
  MigrationLockError,
  MigrationOrderError,
  MigrationRunner,
  parseFilename,
  parseSqlContent,
  sortMigrations,
} from '../src/index';

describe('Database Migrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearMigrationRegistry();
    tmpDir = mkdtempSync(join(tmpdir(), 'di-migrations-test-'));
  });

  afterEach(() => {
    clearMigrationRegistry();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('compareVersions and sorting', () => {
    test('compares integer versions numerically', () => {
      expect(compareVersions(1, 2)).toBeLessThan(0);
      expect(compareVersions(2, 1)).toBeGreaterThan(0);
      expect(compareVersions(2, 10)).toBeLessThan(0);
      expect(compareVersions(10, 2)).toBeGreaterThan(0);
      expect(compareVersions(5, 5)).toBe(0);
    });

    test('compares padded and semantic versions', () => {
      expect(compareVersions('001', '002')).toBeLessThan(0);
      expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
      expect(compareVersions('20240101', '20240102')).toBeLessThan(0);
    });

    test('sorts migration definitions in version order', () => {
      const list: any[] = [
        { version: '10', description: 'ten' },
        { version: '2', description: 'two' },
        { version: '1', description: 'one' },
        { version: '20', description: 'twenty' },
      ];
      const sorted = sortMigrations(list);
      expect(sorted.map((m) => m.version)).toEqual(['1', '2', '10', '20']);
    });
  });

  describe('@Migration decorator', () => {
    test('records metadata and registers class', async () => {
      @Migration({
        version: 1,
        description: 'create users table',
        binding: 'users-db',
      })
      class CreateUsersMigration {
        async up(ctx: any) {
          await ctx.sql('CREATE TABLE users (id INTEGER PRIMARY KEY);');
        }
      }

      expect(isMigration(CreateUsersMigration)).toBe(true);
      const meta = getMigrationMetadata(CreateUsersMigration);
      expect(meta).toMatchObject({
        version: '1',
        description: 'create users table',
        binding: 'users-db',
      });

      const registered = getRegisteredMigrations();
      expect(registered.length).toBe(1);
      expect(registered[0]!.version).toBe('1');
      expect(registered[0]!.description).toBe('create users table');
      expect(registered[0]!.binding).toBe('users-db');
      expect(registered[0]!.checksum).toBeDefined();
    });

    test('throws if version or description is missing', () => {
      expect(() => {
        // @ts-expect-error
        Migration({ description: 'no version' })(class A {});
      }).toThrow();

      expect(() => {
        // @ts-expect-error
        Migration({ version: 1 })(class B {});
      }).toThrow();
    });
  });

  describe('SQL and manifest discovery', () => {
    test('parses SQL headers and delimiters', () => {
      const sql = `
-- migration:version 10
-- migration:description create posts table
-- migration:binding default

-- migrate:up
CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);

-- migrate:down
DROP TABLE posts;
`;
      const parsed = parseSqlContent(sql);
      expect(parsed.headerVersion).toBe('10');
      expect(parsed.headerDescription).toBe('create posts table');
      expect(parsed.headerBinding).toBe('default');
      expect(parsed.upSql).toBe('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);');
      expect(parsed.downSql).toBe('DROP TABLE posts;');
    });

    test('parses filenames with standard patterns', () => {
      expect(parseFilename('001_create_users.sql')).toEqual({
        version: '001',
        description: 'create users',
      });
      expect(parseFilename('V2__add_index.sql')).toEqual({
        version: '2',
        description: 'add index',
      });
      expect(parseFilename('20240101120000-init.up.sql')).toEqual({
        version: '20240101120000',
        description: 'init',
      });
    });

    test('discovers SQL migrations from directory', async () => {
      const dir = join(tmpDir, 'sql-migrations');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE test1 (id INT);');
      writeFileSync(join(dir, '002_add_field.sql'), 'ALTER TABLE test1 ADD COLUMN name TEXT;');

      const discovered = await discoverSqlMigrations(dir, 'main');
      expect(discovered.length).toBe(2);
      expect(discovered[0]!.version).toBe('001');
      expect(discovered[0]!.description).toBe('init');
      expect(discovered[0]!.binding).toBe('main');
      expect(discovered[1]!.version).toBe('002');
      expect(discovered[1]!.description).toBe('add field');
    });

    test('discovers migrations from manifest JSON file', async () => {
      const manifestPath = join(tmpDir, 'migrations.manifest.json');
      const sqlPath = join(tmpDir, 'schema.sql');
      writeFileSync(sqlPath, 'CREATE TABLE orders (id INT PRIMARY KEY);');
      writeFileSync(
        manifestPath,
        JSON.stringify({
          binding: 'ecommerce',
          migrations: [
            {
              version: '1.0',
              description: 'orders table',
              file: 'schema.sql',
            },
            {
              version: '1.1',
              description: 'inline migration',
              sql: 'CREATE TABLE items (id INT);',
            },
          ],
        }),
      );

      const discovered = await discoverManifestMigrations({ manifestPath });
      expect(discovered.length).toBe(2);
      expect(discovered[0]!.version).toBe('1.0');
      expect(discovered[0]!.binding).toBe('ecommerce');
      expect(discovered[1]!.version).toBe('1.1');
      expect(discovered[1]!.binding).toBe('ecommerce');
    });
  });

  describe('MigrationRunner execution and lifecycle', () => {
    test('applies pending migrations in version order and tracks history', async () => {
      const db = new Database(':memory:');
      const runner = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '2',
            description: 'second migration',
            binding: 'test',
            checksum: 'chk2',
            up: async (ctx) => {
              await ctx.sql('INSERT INTO items (name) VALUES (?)', ['item-2']);
            },
          },
          {
            version: '1',
            description: 'first migration',
            binding: 'test',
            checksum: 'chk1',
            up: async (ctx) => {
              await ctx.sql('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
              await ctx.sql('INSERT INTO items (name) VALUES (?)', ['item-1']);
            },
          },
        ],
      });

      const initialStatus = await runner.status();
      expect(initialStatus.isUpToDate).toBe(false);
      expect(initialStatus.pending.length).toBe(2);
      expect(initialStatus.applied.length).toBe(0);

      const result = await runner.execute();
      expect(result.applied.length).toBe(2);
      expect(result.applied[0]!.version).toBe('1');
      expect(result.applied[1]!.version).toBe('2');

      const statusAfter = await runner.status();
      expect(statusAfter.isUpToDate).toBe(true);
      expect(statusAfter.applied.length).toBe(2);
      expect(statusAfter.pending.length).toBe(0);

      const items = db.query('SELECT * FROM items ORDER BY id ASC').all() as any[];
      expect(items.length).toBe(2);
      expect(items[0]!.name).toBe('item-1');
      expect(items[1]!.name).toBe('item-2');
    });

    test('step option applies only requested count of migrations', async () => {
      const db = new Database(':memory:');
      const runner = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '1',
            description: 'v1',
            binding: 'test',
            checksum: 'c1',
            up: async (ctx) => {
              await ctx.sql('CREATE TABLE t (id INT)');
            },
          },
          {
            version: '2',
            description: 'v2',
            binding: 'test',
            checksum: 'c2',
            up: async (ctx) => {
              await ctx.sql('INSERT INTO t VALUES (1)');
            },
          },
        ],
      });

      const step1 = await runner.execute({ step: 1 });
      expect(step1.applied.length).toBe(1);
      expect(step1.applied[0]!.version).toBe('1');

      const midStatus = await runner.status();
      expect(midStatus.isUpToDate).toBe(false);
      expect(midStatus.applied.length).toBe(1);
      expect(midStatus.pending.length).toBe(1);

      const step2 = await runner.execute({ step: 1 });
      expect(step2.applied.length).toBe(1);
      expect(step2.applied[0]!.version).toBe('2');

      const finalStatus = await runner.status();
      expect(finalStatus.isUpToDate).toBe(true);
    });

    test('dryRun does not execute or record migrations', async () => {
      const db = new Database(':memory:');
      const runner = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '1',
            description: 'create t',
            binding: 'test',
            checksum: 'c1',
            up: async (ctx) => {
              await ctx.sql('CREATE TABLE t (id INT)');
            },
          },
        ],
      });

      const result = await runner.execute({ dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.applied.length).toBe(0);
      expect(result.pending.length).toBe(1);

      const status = await runner.status();
      expect(status.applied.length).toBe(0);
      expect(status.pending.length).toBe(1);
    });

    test('DB-backed locking prevents concurrent execution and cleans up', async () => {
      const db = new Database(':memory:');
      const runner1 = new MigrationRunner({
        db,
        binding: 'test',
        lockTimeoutMs: 5000,
      });
      const runner2 = new MigrationRunner({
        db,
        binding: 'test',
        lockTimeoutMs: 5000,
      });

      await runner1.initTables();
      await runner1.acquireLock('test');

      // Runner 2 must fail to acquire lock while runner 1 holds it
      await expect(runner2.acquireLock('test')).rejects.toThrow(MigrationLockError);

      await runner1.releaseLock('test');

      // Runner 2 can acquire after release
      await expect(runner2.acquireLock('test')).resolves.toBeUndefined();
      await runner2.releaseLock('test');
    });

    test('integrity validation detects checksum modification of applied migration', async () => {
      const db = new Database(':memory:');
      const runner1 = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '1',
            description: 'init',
            binding: 'test',
            checksum: 'original-checksum',
            up: async (ctx) => {
              await ctx.sql('CREATE TABLE init (id INT)');
            },
          },
        ],
      });

      await runner1.execute();

      // Tampered checksum
      const runnerTampered = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '1',
            description: 'init',
            binding: 'test',
            checksum: 'tampered-checksum',
            up: async () => {},
          },
        ],
      });

      await expect(runnerTampered.status()).rejects.toThrow(MigrationIntegrityError);
      await expect(runnerTampered.execute()).rejects.toThrow(MigrationIntegrityError);
    });

    test('order validation rejects out-of-order pending migrations', async () => {
      const db = new Database(':memory:');
      const runner = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '2',
            description: 'second',
            binding: 'test',
            checksum: 'c2',
            up: async (ctx) => {
              await ctx.sql('CREATE TABLE v2 (id INT)');
            },
          },
        ],
      });

      await runner.execute();

      // Now add version 1 (which is lower than version 2 already applied)
      const runnerWithBackfilled = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '1',
            description: 'backfilled first',
            binding: 'test',
            checksum: 'c1',
            up: async () => {},
          },
          {
            version: '2',
            description: 'second',
            binding: 'test',
            checksum: 'c2',
            up: async () => {},
          },
        ],
      });

      await expect(runnerWithBackfilled.status()).rejects.toThrow(MigrationOrderError);
    });

    test('autoApply runs migrations in development/test', async () => {
      const db = new Database(':memory:');
      const runner = new MigrationRunner({
        db,
        binding: 'test',
        migrations: [
          {
            version: '1',
            description: 'auto applied',
            binding: 'test',
            checksum: 'c1',
            up: async (ctx) => {
              await ctx.sql('CREATE TABLE auto_test (id INT)');
            },
          },
        ],
      });

      const res = await runner.autoApply({ enabled: true });
      expect(res.applied.length).toBe(1);
      const st = await runner.status();
      expect(st.isUpToDate).toBe(true);
    });

    test('works seamlessly with @Migration decorated classes', async () => {
      const db = new Database(':memory:');

      @Migration({
        version: 1,
        description: 'class migration test',
        binding: 'accounts',
      })
      class AccountMigration {
        async up(ctx: any) {
          await ctx.sql('CREATE TABLE accounts (id INT, balance REAL)');
          await ctx.sql('INSERT INTO accounts VALUES (1, 100.5)');
        }
      }

      const runner = new MigrationRunner({
        db,
        binding: 'accounts',
      });

      const res = await runner.execute();
      expect(res.applied.length).toBe(1);
      expect(res.applied[0]!.version).toBe('1');

      const rows = db.query('SELECT * FROM accounts').all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.balance).toBe(100.5);
    });
  });
});

describe('Migration review regressions and discovery edge cases', () => {
  afterEach(() => clearMigrationRegistry());

  test('compares segmented versions without treating them as decimal fractions', () => {
    expect(compareVersions('1.2', '1.10')).toBeLessThan(0);
    expect(compareVersions('1_2', '1_10')).toBeLessThan(0);
    expect(compareVersions('1-2', '1-10')).toBeLessThan(0);
    expect(compareVersions('1.2', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.2')).toBeGreaterThan(0);
    expect(compareVersions('1.alpha', '1.beta')).toBeLessThan(0);
    expect(compareVersions('1.alpha', '1.alpha')).toBe(0);
  });

  test('does not release a lock owned by another runner after takeover', async () => {
    const db = new Database(':memory:');
    try {
      const a = new MigrationRunner({ db });
      const b = new MigrationRunner({ db });
      await a.initTables();
      await a.acquireLock();
      db.run('UPDATE "_migrations_lock" SET acquired_at = ?', ['2000-01-01T00:00:00.000Z']);
      await b.acquireLock();
      await a.releaseLock();
      await expect(a.acquireLock()).rejects.toThrow(MigrationLockError);
      await b.releaseLock();
      await a.acquireLock();
      await a.releaseLock();
    } finally {
      db.close();
    }
  });

  test('requires explicit auto-apply opt-in outside development and test', async () => {
    const previous = process.env.NODE_ENV;
    const db = new Database(':memory:');
    try {
      const runner = new MigrationRunner({
        db,
        migrations: [
          {
            version: '1',
            description: 'init',
            binding: 'default',
            checksum: '1',
            up: async () => {},
          },
        ],
      });
      for (const env of [undefined, '', 'production']) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        expect((await runner.autoApply()).applied).toEqual([]);
        await expect(runner.autoApply({ throwIfPending: true })).rejects.toThrow(
          'autoApply is disabled',
        );
      }
      expect((await runner.autoApply({ enabled: true })).applied).toHaveLength(1);
    } finally {
      db.close();
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  test('parses reversed and up-only SQL sections and long header whitespace', () => {
    expect(
      parseSqlContent('-- migrate:down\nDROP TABLE t;\n-- migrate:up\nCREATE TABLE t (id INT);'),
    ).toMatchObject({ upSql: 'CREATE TABLE t (id INT);', downSql: 'DROP TABLE t;' });
    expect(parseSqlContent('-- migrate:up\nSELECT 1;')).toMatchObject({ upSql: 'SELECT 1;' });
    expect(parseSqlContent('--version:' + ' '.repeat(100000))).toMatchObject({
      headerVersion: undefined,
    });
    expect(
      parseSqlContent('-- description: example\n-- binding=main\n-- version 2\nSELECT 1;'),
    ).toMatchObject({ headerDescription: 'example', headerBinding: 'main', headerVersion: '2' });
    expect(parseFilename('123.sql')).toEqual({ version: '123', description: 'migration 123' });
    expect(parseFilename('custom.sql')).toEqual({ description: 'custom' });
    expect(parseFilename('0-' + '0-'.repeat(10000) + 'init.sql').description).toBe('init');
  });

  test('discovers separate down scripts and reports missing manifests and files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-discovery-'));
    const db = await createMigrationDatabase(':memory:');
    try {
      mkdirSync(join(dir, 'directory.sql'));
      writeFileSync(join(dir, '1_init.up.sql'), 'CREATE TABLE t (id INT);');
      writeFileSync(join(dir, '1_init.down.sql'), 'DROP TABLE t;');
      expect(await discoverSqlMigrations(join(dir, 'absent'))).toEqual([]);
      const migrations = await discoverSqlMigrations(dir);
      expect(migrations).toHaveLength(1);
      const ctx = { db, binding: 'default', sql: async () => {} } as any;
      await migrations[0]!.up(ctx);
      await migrations[0]!.down!(ctx);
      expect(await db.first("SELECT name FROM sqlite_master WHERE name = 't'")).toBeNull();
      await expect(
        discoverManifestMigrations({ manifestPath: join(dir, 'missing.json') }),
      ).rejects.toThrow('manifest not found');
      await expect(
        discoverManifestMigrations({
          cwd: dir,
          manifest: { migrations: [{ version: '2', description: 'missing', file: 'missing.sql' }] },
        }),
      ).rejects.toThrow('SQL file not found');
      const merged = await discoverManifestMigrations({
        cwd: dir,
        directory: '.',
        manifest: { migrations: [{ version: '1', description: 'override', up: '' }] },
      });
      expect(merged).toHaveLength(1);
      await merged[0]!.up(ctx);
    } finally {
      await db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('supports execute/run migration classes, down hooks, and execution failures', async () => {
    const { createMigrationFromClass, MigrationExecutionError } = await import(
      '../src/migrations/index'
    );
    expect(getMigrationMetadata(null)).toBeUndefined();
    expect(getMigrationMetadata(1)).toBeUndefined();
    expect(() => createMigrationFromClass(class Plain {})).toThrow('not decorated');
    const calls: string[] = [];
    @Migration({ version: 1, description: 'execute' })
    class Execute {
      async execute() {
        calls.push('execute');
      }
      async down() {
        calls.push('down');
      }
    }
    @Migration({ version: 2, description: 'run' })
    class Run {
      async run() {
        calls.push('run');
      }
    }
    @Migration({ version: 3, description: 'invalid' })
    class Invalid {}
    const ctx = {} as any;
    const execute = createMigrationFromClass(Execute);
    await execute.up(ctx);
    await execute.down!(ctx);
    const run = createMigrationFromClass(Run);
    await run.up(ctx);
    await run.down!(ctx);
    await expect(createMigrationFromClass(Invalid).up(ctx)).rejects.toThrow('must implement');
    expect(calls).toEqual(['execute', 'down', 'run']);
    clearMigrationRegistry();
    const db = new Database(':memory:');
    try {
      const runner = new MigrationRunner({
        db,
        migrations: [
          {
            version: '1',
            description: 'failure',
            binding: 'default',
            checksum: 'c',
            up: async () => {
              throw new Error('failure');
            },
          },
        ],
      });
      await expect(runner.execute()).rejects.toBeInstanceOf(MigrationExecutionError);
      expect(await runner.getHistory()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
