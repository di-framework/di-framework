import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Actor,
  ActorLockError,
  ActorMethod,
  actorIdentityToPath,
  parseActorIdentity,
  SqliteActorStorage,
} from '../src/index.js';

@Actor()
class LockedActor {
  @ActorMethod()
  async ping(): Promise<string> {
    return 'pong';
  }
}

describe('Safe Identity Mapping and File Locking', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    cleanupDirs.length = 0;
  });

  describe('Safe Identity Mapping (Path Traversal & Sanitization)', () => {
    it('parses composite actor identities with and without namespaces', () => {
      expect(parseActorIdentity('UserActor:user-123')).toEqual({
        actorName: 'UserActor',
        actorKey: 'user-123',
      });

      expect(parseActorIdentity('prod:OrderActor:ord-999')).toEqual({
        namespace: 'prod',
        actorName: 'OrderActor',
        actorKey: 'ord-999',
      });

      expect(parseActorIdentity('auth:Session:sess:abc:xyz')).toEqual({
        namespace: 'auth',
        actorName: 'Session',
        actorKey: 'sess:abc:xyz',
      });
    });

    it('safely maps actor keys and prevents path traversal', () => {
      const baseDir = '/tmp/actors_test';

      // 1. Normal identity
      const normalPath = actorIdentityToPath(
        { actorName: 'UserActor', actorKey: 'john' },
        { baseDir },
      );
      expect(normalPath.startsWith(path.resolve(baseDir))).toBe(true);
      expect(normalPath).toContain('john_');
      expect(normalPath.endsWith('.db')).toBe(true);

      // 2. Traversal attempts in actorKey: ../../etc/passwd
      const traversalKey = '../../etc/passwd';
      const safePath = actorIdentityToPath(
        { actorName: 'UserActor', actorKey: traversalKey },
        { baseDir },
      );
      expect(safePath.startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
      expect(safePath).not.toContain('/etc/passwd');

      // 3. Traversal attempts in namespace
      const evilNamespace = '../../sensitive';
      const evilPath = actorIdentityToPath(
        { namespace: evilNamespace, actorName: 'Actor', actorKey: '1' },
        { baseDir },
      );
      expect(evilPath.startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
      expect(evilPath).toContain('sensitive');

      // 4. Special characters and spaces
      const weirdKey = 'key with spaces / and : and * ? < > | quotes';
      const weirdPath = actorIdentityToPath(
        { actorName: 'WeirdActor', actorKey: weirdKey },
        { baseDir },
      );
      expect(weirdPath.startsWith(path.resolve(baseDir) + path.sep)).toBe(true);
      expect(weirdPath).not.toContain('?');
      expect(weirdPath).not.toContain('*');
      expect(weirdPath).not.toContain('<');
      expect(weirdPath).not.toContain('>');
    });

    it('returns dedicated memory URIs in inMemory mode', () => {
      const uri1 = actorIdentityToPath(
        { actorName: 'MemActor', actorKey: 'key1' },
        { inMemory: true },
      );
      const uri2 = actorIdentityToPath(
        { actorName: 'MemActor', actorKey: 'key2' },
        { inMemory: true },
      );

      expect(uri1.startsWith('file:actor_default_MemActor_')).toBe(true);
      expect(uri1).toContain('mode=memory&cache=shared');
      expect(uri1).not.toEqual(uri2);
    });
  });

  describe('File Locking and Single-Writer Ownership', () => {
    it('prevents concurrent database ownership within the same process and releases on close', async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-lock-test-'));
      cleanupDirs.push(baseDir);

      const storage1 = new SqliteActorStorage({ baseDir });
      const storage2 = new SqliteActorStorage({ baseDir });

      try {
        const actorId = 'LockedActor:instance-1';

        // Runtime 1 acquires connection and lock
        await storage1.set(actorId, 'held', true);

        // Runtime 2 attempts to own the same actor database while Runtime 1 holds it
        await expect(storage2.get(actorId, 'held')).rejects.toThrow(ActorLockError);

        // Runtime 1 closes the actor connection, releasing the lock
        await storage1.closeActor(actorId);

        // Runtime 2 can now acquire the actor database and read the committed data
        expect(await storage2.get<boolean>(actorId, 'held')).toBe(true);
      } finally {
        await storage1.close();
        await storage2.close();
      }
    });

    it('detects and recovers from stale locks left by terminated processes', async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-stale-lock-'));
      cleanupDirs.push(baseDir);

      const actorId = 'LockedActor:stale-instance';
      const targetDb = actorIdentityToPath(actorId, { baseDir });
      const lockPath = `${targetDb}.lock`;

      fs.mkdirSync(path.dirname(lockPath), { recursive: true });

      // Create a simulated stale lock with a PID that does not exist (e.g. 9999999)
      const fakeDeadPid = 9999999;
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: fakeDeadPid,
          actorId,
          acquiredAt: Date.now() - 60000,
        }),
      );

      const storage = new SqliteActorStorage({ baseDir, lockTimeoutMs: 10000 });
      try {
        // Storage should detect that fakeDeadPid is dead, break the stale lock, and succeed
        await storage.set(actorId, 'recovered', true);
        expect(await storage.get<boolean>(actorId, 'recovered')).toBe(true);
      } finally {
        await storage.close();
      }
    });

    it('rejects ownership across multiple processes holding an active lock', async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-multiprocess-'));
      cleanupDirs.push(baseDir);

      const actorId = 'LockedActor:worker-1';
      const dbPath = actorIdentityToPath(actorId, { baseDir });
      const lockPath = `${dbPath}.lock`;

      // Spawn child process that holds the lock file
      const childScript = `
        import * as fs from "node:fs";
        import * as path from "node:path";
        const lockPath = ${JSON.stringify(lockPath)};
        const actorId = ${JSON.stringify(actorId)};
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, actorId, acquiredAt: Date.now() }));
        process.stdout.write("LOCKED\\n");
        setTimeout(() => {
          try { fs.unlinkSync(lockPath); } catch {}
          process.exit(0);
        }, 1200);
      `;

      const child = Bun.spawn(['bun', '-e', childScript], {
        stdout: 'pipe',
      });

      // Wait until child confirms lock is written
      const reader = child.stdout.getReader();
      let output = '';
      while (!output.includes('LOCKED')) {
        const { value } = await reader.read();
        if (value) {
          output += new TextDecoder().decode(value);
        }
      }

      const storage = new SqliteActorStorage({ baseDir });
      try {
        // Attempting to access while child is actively running MUST throw ActorLockError
        let caughtError: any;
        try {
          await storage.set(actorId, 'test', 'value');
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(ActorLockError);
        expect(caughtError.heldByPid).toBe(child.pid);

        // Wait for child to exit and release lock
        await child.exited;

        // Now parent process can acquire lock and write
        await storage.set(actorId, 'test', 'value');
        expect(await storage.get<string>(actorId, 'test')).toBe('value');
      } finally {
        await storage.close();
      }
    });
  });
});

it('never steals a live or incomplete lock and serializes stale recovery', async () => {
  const { acquireActorLock } = await import('../src/storage/lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-recovery-review-'));
  const target = path.join(dir, 'actor.db');
  const lock = target + '.lock';
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: 0 }));
    await expect(acquireActorLock(target, 'actor', { lockTimeoutMs: 1 })).rejects.toThrow(
      ActorLockError,
    );
    fs.writeFileSync(lock, '');
    await expect(acquireActorLock(target, 'actor')).rejects.toThrow(ActorLockError);
    fs.writeFileSync(lock, JSON.stringify({ pid: 9999999 }));
    fs.writeFileSync(lock + '.recovery', '');
    await expect(acquireActorLock(target, 'actor')).rejects.toThrow(ActorLockError);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(9999999);
    fs.writeFileSync(lock + '.recovery', JSON.stringify({ pid: 9999999 }));
    const release = await acquireActorLock(target, 'actor');
    await expect(acquireActorLock(target, 'actor')).rejects.toThrow(ActorLockError);
    await release();
    await release();
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(lock + '.recovery')).toBe(false);
    expect(fs.existsSync(lock + '.recovery.recovery')).toBe(false);
    const releaseMemory = await acquireActorLock('file:review-lock', 'actor');
    await expect(acquireActorLock('file:review-lock', 'actor')).rejects.toThrow(ActorLockError);
    await releaseMemory();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('bounds underscore sanitization and handles empty identity segments', () => {
  const result = actorIdentityToPath({
    namespace: '_'.repeat(100000),
    actorName: '_'.repeat(100000),
    actorKey: '',
  });
  expect(result).toContain(path.join('default', 'actor'));
  expect(parseActorIdentity('Name')).toEqual({ actorName: 'Name', actorKey: '' });
});

it('validates mapped containment and supports a filesystem-root base directory', async () => {
  const { spyOn } = await import('bun:test');
  expect(actorIdentityToPath('Root:key', { baseDir: path.parse(process.cwd()).root })).toContain(
    path.join('default', 'Root'),
  );
  const root = path.resolve('safe-base');
  const outside = path.resolve('outside.db');
  const resolver = spyOn(path, 'resolve').mockReturnValueOnce(root).mockReturnValueOnce(outside);
  try {
    expect(() => actorIdentityToPath('Actor:key', { baseDir: root })).toThrow(
      'Path traversal attempt',
    );
  } finally {
    resolver.mockRestore();
  }
});

it('handles ownership changes while acquiring the recovery guard', async () => {
  const { acquireActorLock } = await import('../src/storage/lock');
  const { spyOn } = await import('bun:test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-recovery-change-'));
  const target = path.join(dir, 'actor.db');
  const lock = target + '.lock';
  const read = fs.readFileSync;
  try {
    for (const replacement of [undefined, '', JSON.stringify({ pid: process.pid })]) {
      fs.writeFileSync(lock, JSON.stringify({ pid: 9999999 }));
      let observed = false;
      const spy = spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
        const result = (read as any)(file, ...args);
        if (file === lock && !observed) {
          observed = true;
          if (replacement === undefined) fs.unlinkSync(lock);
          else fs.writeFileSync(lock, replacement);
        }
        return result;
      }) as typeof fs.readFileSync);
      try {
        if (replacement === undefined) {
          const release = await acquireActorLock(target, 'actor');
          await release();
        } else {
          await expect(acquireActorLock(target, 'actor')).rejects.toThrow(ActorLockError);
        }
        expect(fs.existsSync(lock + '.recovery')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
