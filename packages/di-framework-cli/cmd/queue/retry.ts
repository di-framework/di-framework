import type { Job } from '@di-framework/queues';
import { type CliIo, CommandFailure, type CommandResult } from '../../command';
import { openQueueBackend, resolveQueueDbPath, retryQueueJobs } from './options';

export { retryQueueJobs };

export type QueueRetryOperations = {
  readonly retryQueueJobs: typeof retryQueueJobs;
};

const DEFAULT_OPERATIONS: QueueRetryOperations = { retryQueueJobs };

export type QueueRetryOptions = {
  queueName: string;
  jobId?: string;
  db?: string;
  json?: boolean;
};

export function parseQueueRetryArgs(args: readonly string[]): QueueRetryOptions {
  let queueName: string | undefined;
  let jobId: string | undefined;
  let db: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--db') {
      const next = args[++i];
      if (!next || next.startsWith('--')) {
        throw new CommandFailure('INVALID_USAGE', 'Missing value for --db option', 2);
      }
      db = next;
    } else if (!arg.startsWith('--')) {
      if (queueName === undefined) {
        queueName = arg;
      } else if (jobId === undefined) {
        jobId = arg;
      } else {
        throw new CommandFailure('INVALID_USAGE', `Unexpected extra argument: ${arg}`, 2);
      }
    } else {
      throw new CommandFailure('INVALID_USAGE', `Unknown option: ${arg}`, 2);
    }
  }

  if (!queueName) {
    throw new CommandFailure('INVALID_USAGE', 'Missing queue name argument', 2);
  }

  return { queueName, jobId, db, json };
}

export async function runQueueRetry(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  operations: QueueRetryOperations = DEFAULT_OPERATIONS,
): Promise<CommandResult> {
  const options = parseQueueRetryArgs(args);
  const dbPath = resolveQueueDbPath(options.db);
  const backend = await openQueueBackend(dbPath);
  const api = operations;

  try {
    const retried = await api.retryQueueJobs(backend, options.queueName, options.jobId);

    if (options.json) {
      io.stdout.write(`${JSON.stringify({ retried: retried.map((j) => j.id) }, null, 2)}\n`);
      return { exitCode: 0, data: { retried } as any as any as any as any };
    }

    if (retried.length === 0) {
      if (options.jobId) {
        io.stdout.write(
          `No dead-letter job found with ID "${options.jobId}" in queue "${options.queueName}".\n`,
        );
      } else {
        io.stdout.write(`No dead-letter jobs found to retry in queue "${options.queueName}".\n`);
      }
      return { exitCode: 0, data: { retried: [] } };
    }

    io.stdout.write(
      `Retried ${retried.length} dead-letter job(s) in queue "${options.queueName}":\n`,
    );
    for (const j of retried) {
      io.stdout.write(`  - ${j.id}\n`);
    }

    return { exitCode: 0, data: { retried } as any };
  } finally {
    await backend.close();
  }
}
