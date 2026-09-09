import type { Job, JobStatus } from '@di-framework/queues';
import { CommandFailure, type CliIo, type CommandResult } from '../../command.js';
import { inspectQueue, openQueueBackend, resolveQueueDbPath } from './options.js';

export { inspectQueue };

export type QueueInspectOperations = {
  readonly inspectQueue: typeof inspectQueue;
};

const DEFAULT_OPERATIONS: QueueInspectOperations = { inspectQueue };

const VALID_STATUSES = new Set(['pending', 'processing', 'completed', 'dead-letter']);

export type QueueInspectOptions = {
  queueName: string;
  status?: JobStatus;
  limit?: number;
  db?: string;
  json?: boolean;
};

export function parseQueueInspectArgs(args: readonly string[]): QueueInspectOptions {
  let queueName: string | undefined;
  let status: JobStatus | undefined;
  let limit: number | undefined;
  let db: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--status') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        throw new CommandFailure('INVALID_USAGE', 'Missing value for --status option', 2);
      }
      if (!VALID_STATUSES.has(next)) {
        throw new CommandFailure(
          'INVALID_USAGE',
          `Invalid status "${next}". Expected one of: pending, processing, completed, dead-letter`,
          2,
        );
      }
      status = next as JobStatus;
    } else if (arg === '--limit') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        throw new CommandFailure('INVALID_USAGE', 'Missing value for --limit option', 2);
      }
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed <= 0) {
        throw new CommandFailure('INVALID_USAGE', '--limit must be a positive integer', 2);
      }
      limit = parsed;
    } else if (arg === '--db') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        throw new CommandFailure('INVALID_USAGE', 'Missing value for --db option', 2);
      }
      db = next;
    } else if (!arg.startsWith('--') && queueName === undefined) {
      queueName = arg;
    } else {
      throw new CommandFailure('INVALID_USAGE', `Unknown option or argument: ${arg}`, 2);
    }
  }

  if (!queueName) {
    throw new CommandFailure('INVALID_USAGE', 'Missing queue name argument', 2);
  }

  return { queueName, status, limit, db, json };
}

export async function runQueueInspect(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  operations: QueueInspectOperations = DEFAULT_OPERATIONS,
): Promise<CommandResult> {
  const options = parseQueueInspectArgs(args);
  const dbPath = resolveQueueDbPath(options.db);
  const backend = await openQueueBackend(dbPath);
  const api = operations;

  try {
    const jobs = await api.inspectQueue(backend, options.queueName, {
      status: options.status,
      limit: options.limit ?? 50,
    });

    if (options.json) {
      io.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
      return { exitCode: 0, data: jobs as any };
    }

    if (jobs.length === 0) {
      io.stdout.write(`No jobs found in queue "${options.queueName}".\n`);
      return { exitCode: 0, data: { jobs: [] } };
    }

    io.stdout.write(`Queue: ${options.queueName} (${jobs.length} jobs)\n\n`);

    const pad = (str: string | number, width: number, right = false) => {
      const s = String(str);
      return right ? s.padStart(width) : s.padEnd(width);
    };

    const header = [
      pad('ID', 32),
      pad('Status', 12),
      pad('Attempts', 9, true),
      pad('Enqueued', 20),
      'Error',
    ].join('  ');

    const separator = '-'.repeat(Math.max(header.length, 80));

    io.stdout.write(`${header}\n${separator}\n`);
    for (const job of jobs) {
      const enqueuedStr = new Date(job.enqueuedAt).toISOString().replace('T', ' ').slice(0, 19);
      const attemptsStr = `${job.attempts}/${job.maxRetries}`;
      const errStr = job.errorMessage ? job.errorMessage.slice(0, 30) : '-';

      const row = [
        pad(job.id, 32),
        pad(job.status, 12),
        pad(attemptsStr, 9, true),
        pad(enqueuedStr, 20),
        errStr,
      ].join('  ');

      io.stdout.write(`${row}\n`);
    }

    return { exitCode: 0, data: { jobs } as any as any };
  } finally {
    await backend.close();
  }
}
