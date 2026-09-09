/**
 * File-based lock and single-writer check for actor SQLite databases.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export class ActorLockError extends Error {
  readonly actorId: string;
  readonly heldByPid?: number;
  readonly lockPath: string;

  constructor(actorId: string, lockPath: string, heldByPid?: number) {
    super(
      `Actor database '${actorId}' is locked by another process (PID: ${heldByPid ?? 'unknown'}, lock: ${lockPath}).`,
    );
    this.name = 'ActorLockError';
    this.actorId = actorId;
    this.heldByPid = heldByPid;
    this.lockPath = lockPath;
  }
}

export interface LockOptions {
  /** Retained for compatibility; live process locks never expire by age. */
  lockTimeoutMs?: number;
  inMemory?: boolean;
}

const activeInProcessLocks = new Set<string>();

/**
 * Checks if a process with the given PID is currently alive on the system.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      return false;
    }
    // EPERM or other errors indicate the process exists
    return true;
  }
}

/**
 * Attempts to acquire an exclusive lock on an actor's database.
 * Returns an asynchronous release function when acquired.
 */
export async function acquireActorLock(
  targetPath: string,
  actorId: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const inMemory = options.inMemory === true || targetPath.startsWith('file:');

  if (inMemory) {
    if (activeInProcessLocks.has(targetPath)) {
      throw new ActorLockError(actorId, targetPath, process.pid);
    }
    activeInProcessLocks.add(targetPath);
    return async () => {
      activeInProcessLocks.delete(targetPath);
    };
  }

  const lockPath = `${targetPath}.lock`;

  // Check in-process ownership first
  if (activeInProcessLocks.has(lockPath)) {
    throw new ActorLockError(actorId, lockPath, process.pid);
  }

  // Ensure target directory exists before writing lock
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tryCreateLock = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const payload = JSON.stringify({
        pid: process.pid,
        actorId,
        acquiredAt: Date.now(),
      });
      fs.writeFileSync(fd, payload, 'utf-8');
      fs.closeSync(fd);
      activeInProcessLocks.add(lockPath);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  };

  if (!tryCreateLock()) {
    // Lock file already exists on disk. Inspect it for stale or active ownership.
    let lockInfo: { pid?: number; actorId?: string; acquiredAt?: number } | null = null;
    try {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      lockInfo = JSON.parse(raw);
    } catch {
      lockInfo = null;
    }

    // Invalid or partially written payloads are not evidence that the owner died.
    if (!lockInfo || typeof lockInfo.pid !== 'number' || isPidAlive(lockInfo.pid)) {
      throw new ActorLockError(actorId, lockPath, lockInfo?.pid);
    }

    // Serialize recovery separately from ownership. Re-read under this guard so
    // another recovering process cannot unlink a newly acquired ownership lock.
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryFd: number;
    try {
      recoveryFd = fs.openSync(recoveryPath, 'wx', 0o600);
    } catch (error: any) {
      if (error.code === 'EEXIST') throw new ActorLockError(actorId, lockPath, lockInfo.pid);
      throw error;
    }
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (typeof current.pid !== 'number' || isPidAlive(current.pid)) {
        throw new ActorLockError(actorId, lockPath, current.pid);
      }
      fs.unlinkSync(lockPath);
      if (!tryCreateLock()) throw new ActorLockError(actorId, lockPath);
    } finally {
      fs.closeSync(recoveryFd);
      fs.unlinkSync(recoveryPath);
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    activeInProcessLocks.delete(lockPath);
    try {
      if (fs.existsSync(lockPath)) {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const info = JSON.parse(raw);
        if (info.pid === process.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {}
  };
}
