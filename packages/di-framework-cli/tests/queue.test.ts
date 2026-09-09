import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteQueueBackend } from '@di-framework/queues';
import { runQueueInspect } from '../cmd/queue/inspect.js';
import { runQueueList } from '../cmd/queue/list.js';
import { runQueueRetry } from '../cmd/queue/retry.js';
import type { CliIo } from '../command.js';

function createCaptureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (msg: string) => stdout.push(msg) },
      stderr: { write: (msg: string) => stderr.push(msg) },
    },
  };
}

describe('Queue CLI Commands', () => {
  it('lists queues and outputs formatted table and json', async () => {
    const dbPath = join(
      tmpdir(),
      `queue-cli-list-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      const backend = new SqliteQueueBackend(dbPath);
      await backend.enqueue('receipts', { id: 'r-1' }, { maxRetries: 1 });
      await backend.enqueue('receipts', { id: 'r-2' }, { maxRetries: 1 });
      const d = await backend.dequeue('receipts');
      await backend.fail(d!.id, 'Test failure'); // dead-letter
      await backend.enqueue('notifications', { text: 'hi' });
      await backend.close();

      // Text table output
      const { stdout: textOut, io: textIo } = createCaptureIo();
      const res1 = await runQueueList(['--db', dbPath], textIo);
      expect(res1.exitCode).toBe(0);
      const text = textOut.join('');
      expect(text).toContain('Queue');
      expect(text).toContain('receipts');
      expect(text).toContain('notifications');

      // JSON output
      const { stdout: jsonOut, io: jsonIo } = createCaptureIo();
      const res2 = await runQueueList(['--db', dbPath, '--json'], jsonIo);
      expect(res2.exitCode).toBe(0);
      const data = JSON.parse(jsonOut.join(''));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
      const receipts = data.find((q: any) => q.name === 'receipts');
      expect(receipts.deadLetter).toBe(1);
    } finally {
      try {
        rmSync(dbPath, { force: true });
      } catch {}
    }
  });

  it('inspects queue jobs and filters by status', async () => {
    const dbPath = join(
      tmpdir(),
      `queue-cli-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      const backend = new SqliteQueueBackend(dbPath);
      await backend.enqueue('orders', { orderId: '101' }, { maxRetries: 1 });
      await backend.enqueue('orders', { orderId: '102' }, { maxRetries: 1 });
      const d = await backend.dequeue('orders');
      await backend.fail(d!.id, 'Processing error');
      await backend.close();

      // Text table output
      const { stdout: textOut, io: textIo } = createCaptureIo();
      const res1 = await runQueueInspect(['orders', '--db', dbPath], textIo);
      expect(res1.exitCode).toBe(0);
      expect(textOut.join('')).toContain('orders');

      // JSON output with status filter
      const { stdout: jsonOut, io: jsonIo } = createCaptureIo();
      const res2 = await runQueueInspect(
        ['orders', '--status', 'dead-letter', '--db', dbPath, '--json'],
        jsonIo,
      );
      expect(res2.exitCode).toBe(0);
      const jobs = JSON.parse(jsonOut.join(''));
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('dead-letter');
      expect(jobs[0].errorMessage).toBe('Processing error');
    } finally {
      try {
        rmSync(dbPath, { force: true });
      } catch {}
    }
  });

  it('retries dead-letter jobs in queue', async () => {
    const dbPath = join(
      tmpdir(),
      `queue-cli-retry-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      const backend = new SqliteQueueBackend(dbPath);
      const j = await backend.enqueue(
        'webhooks',
        { url: 'https://example.com' },
        { maxRetries: 1 },
      );
      const d = await backend.dequeue('webhooks');
      await backend.fail(d!.id, 'HTTP 500');
      await backend.close();

      const { stdout: textOut, io: textIo } = createCaptureIo();
      const res = await runQueueRetry(['webhooks', '--db', dbPath], textIo);
      expect(res.exitCode).toBe(0);
      expect(textOut.join('')).toContain('Retried 1 dead-letter job(s) in queue "webhooks"');

      // Verify it is pending now
      const verifyBackend = new SqliteQueueBackend(dbPath);
      const job = await verifyBackend.getJob(j.id);
      expect(job!.status).toBe('pending');
      expect(job!.errorMessage).toBeUndefined();
      await verifyBackend.close();
    } finally {
      try {
        rmSync(dbPath, { force: true });
      } catch {}
    }
  });

  it('validates invalid options and arguments', async () => {
    const { io } = createCaptureIo();
    expect(runQueueInspect([], io)).rejects.toThrow('Missing queue name argument');
    expect(runQueueInspect(['q1', '--status', 'invalid-status'], io)).rejects.toThrow(
      'Invalid status',
    );
    expect(runQueueRetry([], io)).rejects.toThrow('Missing queue name argument');
    expect(runQueueList(['--unknown-flag'], io)).rejects.toThrow('Unknown option');
  });
});
