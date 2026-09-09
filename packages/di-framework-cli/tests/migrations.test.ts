import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../command';
import { main } from '../main';

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
  };
  return { stdout, stderr, io };
}

describe('CLI Migrations Commands', () => {
  let tmpDir: string;
  let dbPath: string;
  let migDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(import.meta.dir, '.tmp-cli-migrations-'));
    dbPath = join(tmpDir, 'test.db');
    migDir = join(tmpDir, 'migrations');
    mkdirSync(migDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('status reports pending migrations in human text and json', async () => {
    writeFileSync(
      join(migDir, '001_create_users.sql'),
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    );
    writeFileSync(join(migDir, '002_add_email.sql'), 'ALTER TABLE users ADD COLUMN email TEXT;');

    const c1 = captureIo();
    const code = await main(['migrations', 'status', '--db', dbPath, '--dir', migDir], c1.io);
    expect(code).toBe(0);
    const text = c1.stdout.join('');
    expect(text).toContain('Applied migrations: 0');
    expect(text).toContain('Pending migrations: 2');
    expect(text).toContain('001: create users');
    expect(text).toContain('002: add email');

    // JSON mode
    const c2 = captureIo();
    const jsonCode = await main(
      ['migrations', 'status', '--db', dbPath, '--dir', migDir, '--json'],
      c2.io,
    );
    expect(jsonCode).toBe(0);
    const payload = JSON.parse(c2.stdout.join(''));
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('migrations status');
    expect(payload.data.isUpToDate).toBe(false);
    expect(payload.data.applied.length).toBe(0);
    expect(payload.data.pending.length).toBe(2);
    expect(payload.data.pending[0].version).toBe('001');
  });

  test('execute applies pending migrations sequentially and updates database', async () => {
    writeFileSync(
      join(migDir, '001_create_posts.sql'),
      'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);\nINSERT INTO posts (title) VALUES ("First");',
    );
    writeFileSync(
      join(migDir, '002_add_content.sql'),
      'ALTER TABLE posts ADD COLUMN content TEXT;\nUPDATE posts SET content = "Hello World" WHERE id = 1;',
    );

    const execCap = captureIo();
    const execCode = await main(
      ['migrations', 'execute', '--db', dbPath, '--dir', migDir],
      execCap.io,
    );
    expect(execCode).toBe(0);
    const execText = execCap.stdout.join('');
    expect(execText).toContain('Successfully applied 2 migration(s)');
    expect(execText).toContain('001: create posts');
    expect(execText).toContain('002: add content');

    // Verify DB state
    const db = new Database(dbPath);
    const rows = db.query('SELECT * FROM posts').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe('First');
    expect(rows[0]!.content).toBe('Hello World');
    db.close();

    // Verify status is now up to date
    const statusCap = captureIo();
    const statusCode = await main(
      ['migrations', 'status', '--db', dbPath, '--dir', migDir],
      statusCap.io,
    );
    expect(statusCode).toBe(0);
    expect(statusCap.stdout.join('')).toContain('Status: Up-to-date');
  });

  test('execute with --dry-run plans without writing to database', async () => {
    writeFileSync(join(migDir, '001_init.sql'), 'CREATE TABLE dry_test (id INT);');

    const dryCap = captureIo();
    const dryCode = await main(
      ['migrations', 'execute', '--db', dbPath, '--dir', migDir, '--dry-run'],
      dryCap.io,
    );
    expect(dryCode).toBe(0);
    expect(dryCap.stdout.join('')).toContain('Dry run mode');
    expect(dryCap.stdout.join('')).toContain('001: init');

    // Status is still pending
    const statusCap = captureIo();
    await main(['migrations', 'status', '--db', dbPath, '--dir', migDir], statusCap.io);
    expect(statusCap.stdout.join('')).toContain('Pending migrations: 1');
  });

  test('execute with --step applies only requested count of migrations', async () => {
    writeFileSync(join(migDir, '001_step1.sql'), 'CREATE TABLE s1 (id INT);');
    writeFileSync(join(migDir, '002_step2.sql'), 'CREATE TABLE s2 (id INT);');

    const step1Cap = captureIo();
    const step1Code = await main(
      ['migrations', 'execute', '--db', dbPath, '--dir', migDir, '--step', '1'],
      step1Cap.io,
    );
    expect(step1Code).toBe(0);
    expect(step1Cap.stdout.join('')).toContain('Successfully applied 1 migration(s)');

    const statusCap = captureIo();
    await main(['migrations', 'status', '--db', dbPath, '--dir', migDir], statusCap.io);
    expect(statusCap.stdout.join('')).toContain('Applied migrations: 1');
    expect(statusCap.stdout.join('')).toContain('Pending migrations: 1');
  });

  test('discovers migrations via --manifest JSON file', async () => {
    const manifestPath = join(tmpDir, 'custom-manifest.json');
    const sqlFile = join(tmpDir, 'custom.sql');
    writeFileSync(sqlFile, 'CREATE TABLE manifest_table (id INT);');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        migrations: [
          {
            version: '1',
            description: 'manifest table',
            file: 'custom.sql',
          },
        ],
      }),
    );

    const execCap = captureIo();
    const code = await main(
      ['migrations', 'execute', '--db', dbPath, '--manifest', manifestPath],
      execCap.io,
    );
    expect(code).toBe(0);
    expect(execCap.stdout.join('')).toContain('Successfully applied 1 migration(s)');
  });

  test('executes migrations loaded from module with @Migration decorator', async () => {
    const modPath = join(tmpDir, 'decorated-migration.ts');
    writeFileSync(
      modPath,
      `
import { Migration } from '${join(import.meta.dir, '../../di-framework-repo/src/index.ts')}';

@Migration({
  version: '100',
  description: 'decorated class migration',
  binding: 'default',
})
export class CustomModMigration {
  async up(ctx) {
    await ctx.sql('CREATE TABLE decorated (id INT, val TEXT)');
    await ctx.sql('INSERT INTO decorated VALUES (1, "decorated-value")');
  }
}
`,
    );

    const execCap = captureIo();
    const code = await main(
      ['migrations', 'execute', '--db', dbPath, '--module', modPath],
      execCap.io,
    );
    if (code !== 0) {
      console.error('Test error output:', execCap.stderr.join(''));
    }
    expect(code).toBe(0);
    expect(execCap.stdout.join('')).toContain('100: decorated class migration');

    const db = new Database(dbPath);
    const rows = db.query('SELECT * FROM decorated').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.val).toBe('decorated-value');
    db.close();
  });

  test('rejects unknown options with code 2', async () => {
    const cap = captureIo();
    const code = await main(['migrations', 'status', '--foo-bar'], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.join('')).toContain('Unknown migration option or argument: --foo-bar');
  });

  test('rejects missing value for option with code 2', async () => {
    const cap = captureIo();
    const code = await main(['migrations', 'status', '--db'], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.join('')).toContain('Missing value for --db');
  });
});
