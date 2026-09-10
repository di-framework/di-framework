import type { QueueInfo } from '@di-framework/queues';
import { CommandFailure, type CliIo, type CommandResult } from '../../command';
import { listQueueStats, openQueueBackend, resolveQueueDbPath } from './options';

export { listQueueStats };

export type QueueListOperations = {
  readonly listQueueStats: typeof listQueueStats;
};

const DEFAULT_OPERATIONS: QueueListOperations = { listQueueStats };

export type QueueListOptions = {
  db?: string;
  json?: boolean;
};

export function parseQueueListArgs(args: readonly string[]): QueueListOptions {
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
    } else {
      throw new CommandFailure('INVALID_USAGE', `Unknown option: ${arg}`, 2);
    }
  }

  return { db, json };
}

export async function runQueueList(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  operations: QueueListOperations = DEFAULT_OPERATIONS,
): Promise<CommandResult> {
  const options = parseQueueListArgs(args);
  const dbPath = resolveQueueDbPath(options.db);
  const backend = await openQueueBackend(dbPath);
  const api = operations;

  try {
    const queues = await api.listQueueStats(backend);

    if (options.json) {
      io.stdout.write(`${JSON.stringify(queues, null, 2)}\n`);
      return { exitCode: 0, data: queues as any };
    }

    if (queues.length === 0) {
      io.stdout.write('No durable queues found.\n');
      return { exitCode: 0, data: { queues: [] } };
    }

    const colWidths = {
      name: Math.max(16, ...queues.map((q) => q.name.length)),
      pending: 8,
      processing: 11,
      completed: 10,
      deadLetter: 12,
      total: 8,
    };

    const pad = (str: string | number, width: number, right = false) => {
      const s = String(str);
      return right ? s.padStart(width) : s.padEnd(width);
    };

    const header = [
      pad('Queue', colWidths.name),
      pad('Pending', colWidths.pending, true),
      pad('Processing', colWidths.processing, true),
      pad('Completed', colWidths.completed, true),
      pad('Dead-Letter', colWidths.deadLetter, true),
      pad('Total', colWidths.total, true),
    ].join('  ');

    const separator = '-'.repeat(header.length);

    io.stdout.write(`${header}\n${separator}\n`);
    for (const q of queues) {
      const row = [
        pad(q.name, colWidths.name),
        pad(q.pending, colWidths.pending, true),
        pad(q.processing, colWidths.processing, true),
        pad(q.completed, colWidths.completed, true),
        pad(q.deadLetter, colWidths.deadLetter, true),
        pad(q.total, colWidths.total, true),
      ].join('  ');
      io.stdout.write(`${row}\n`);
    }

    return { exitCode: 0, data: { queues } as any as any };
  } finally {
    await backend.close();
  }
}
