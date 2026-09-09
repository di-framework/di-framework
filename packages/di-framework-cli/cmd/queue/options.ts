import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Job, ListJobsFilter, QueueBackend, QueueInfo } from '@di-framework/queues';
import { CommandFailure } from '../../command.js';

export function resolveQueueDbPath(explicitDb?: string, cwd = process.cwd()): string {
  if (explicitDb) {
    return isAbsolute(explicitDb) ? explicitDb : resolve(cwd, explicitDb);
  }

  if (process.env.DI_QUEUE_DB) {
    const envPath = process.env.DI_QUEUE_DB;
    return isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
  }

  const dotDiDb = join(cwd, '.di-framework', 'queue.db');
  if (existsSync(dotDiDb)) return dotDiDb;

  const localDb = join(cwd, 'queue.db');
  if (existsSync(localDb)) return localDb;

  return dotDiDb;
}

export async function openQueueBackend(dbPath: string): Promise<QueueBackend> {
  try {
    const { SqliteQueueBackend } = await import('@di-framework/queues');
    return new SqliteQueueBackend(dbPath);
  } catch (cause) {
    throw new CommandFailure(
      'QUEUES_PACKAGE_UNAVAILABLE',
      'Unable to load @di-framework/queues from the current project',
      3,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export async function listQueueStats(backend: QueueBackend): Promise<QueueInfo[]> {
  return backend.listQueues();
}

export async function inspectQueue(
  backend: QueueBackend,
  queueName: string,
  filter?: ListJobsFilter,
): Promise<Job<any>[]> {
  return backend.listJobs(queueName, filter);
}

export async function retryQueueJobs(
  backend: QueueBackend,
  queueName: string,
  jobId?: string,
): Promise<Job<any>[]> {
  return backend.retryJob(queueName, jobId);
}
