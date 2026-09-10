import type { SqlDatabase } from '@di-framework/repo';
import { createWasmSqliteDatabase } from '@di-framework/repo';
import { queueRegistry } from '../decorators';
import type { EnqueueOptions, Job, JobStatus, ListJobsFilter, QueueInfo } from '../types';
import type { QueueBackend } from './contract';

/**
 * SQLite queue backend for Wasm guests. Uses the composed di-framework:sqlite
 * component with rollback journals and synchronous FULL persistence.
 * Status values match the native SqliteQueueBackend (`processing`, `dead-letter`).
 */
export class WasmSqliteQueueBackend implements QueueBackend {
  readonly name = 'sqlite-wasm';
  private db!: SqlDatabase;
  private ready: Promise<void>;
  private nextId = 1;

  constructor(path = ':memory:') {
    this.ready = createWasmSqliteDatabase(path, {
      create: true,
      journalMode: 'delete',
      synchronous: 'full',
    }).then(async (db) => {
      this.db = db;
      await this.initSchema();
    });
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  private async initSchema(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS di_queue_jobs (
        id TEXT PRIMARY KEY,
        queue_name TEXT NOT NULL,
        idempotency_key TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        backoff_ms INTEGER NOT NULL DEFAULT 1000,
        timeout_ms INTEGER NOT NULL DEFAULT 30000,
        enqueued_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        failed_at INTEGER,
        error_message TEXT,
        error_stack TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_di_queue_jobs_dequeue
        ON di_queue_jobs (queue_name, status, available_at, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_di_queue_jobs_idempotency
        ON di_queue_jobs (queue_name, idempotency_key);
    `);
  }

  private rowToJob<T>(row: any): Job<T> {
    return {
      id: row.id,
      queueName: row.queue_name,
      payload: JSON.parse(row.payload),
      status: row.status as JobStatus,
      priority: row.priority,
      attempts: row.attempts,
      maxRetries: row.max_retries,
      backoffMs: row.backoff_ms,
      timeoutMs: row.timeout_ms,
      enqueuedAt: row.enqueued_at,
      availableAt: row.available_at,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
      errorMessage: row.error_message ?? undefined,
      errorStack: row.error_stack ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
    };
  }

  async enqueue<T>(queueName: string, payload: T, options: EnqueueOptions = {}): Promise<Job<T>> {
    await this.ensureReady();
    if (options.idempotencyKey) {
      const existing = await this.db.first(
        `SELECT * FROM di_queue_jobs WHERE queue_name = ? AND idempotency_key = ? AND status != 'dead-letter' LIMIT 1`,
        [queueName, options.idempotencyKey],
      );
      if (existing) return this.rowToJob<T>(existing);
    }
    const now = Date.now();
    const defaults = queueRegistry.getForQueue(queueName)[0]?.options;
    const id =
      options.jobId ?? `job_${now}_${this.nextId++}_${Math.random().toString(36).substring(2, 9)}`;
    const job: Job<T> = {
      id,
      queueName,
      payload,
      status: 'pending',
      priority: options.priority ?? 0,
      attempts: 0,
      maxRetries: options.maxRetries ?? defaults?.maxRetries ?? 3,
      backoffMs: options.backoffMs ?? defaults?.backoffMs ?? 1000,
      timeoutMs: options.timeoutMs ?? defaults?.timeoutMs ?? 30_000,
      enqueuedAt: now,
      availableAt: now + (options.delayMs ?? 0),
      idempotencyKey: options.idempotencyKey,
    };
    await this.db.run(
      `INSERT INTO di_queue_jobs (
        id, queue_name, idempotency_key, payload, status, priority, attempts,
        max_retries, backoff_ms, timeout_ms, enqueued_at, available_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.queueName,
        options.idempotencyKey ?? null,
        JSON.stringify(payload),
        job.status,
        job.priority,
        job.attempts,
        job.maxRetries,
        job.backoffMs,
        job.timeoutMs,
        job.enqueuedAt,
        job.availableAt,
      ],
    );
    return job;
  }

  async dequeue(queueName: string, leaseTimeoutMs = 30_000): Promise<Job<any> | null> {
    await this.ensureReady();
    const now = Date.now();
    return this.db.transaction(async (tx) => {
      const row = await tx.first(
        `SELECT * FROM di_queue_jobs
         WHERE queue_name = ? AND status = 'pending' AND available_at <= ?
         ORDER BY priority DESC, available_at ASC, enqueued_at ASC LIMIT 1`,
        [queueName, now],
      );
      if (!row) return null;
      const leaseExpiresAt = now + leaseTimeoutMs;
      await tx.run(
        `UPDATE di_queue_jobs SET status = 'processing', attempts = attempts + 1,
         started_at = ?, lease_expires_at = ? WHERE id = ?`,
        [now, leaseExpiresAt, row.id],
      );
      return this.rowToJob({
        ...row,
        status: 'processing',
        attempts: Number(row.attempts) + 1,
        started_at: now,
        lease_expires_at: leaseExpiresAt,
      });
    });
  }

  async complete(jobId: string): Promise<void> {
    await this.ensureReady();
    await this.db.run(
      `UPDATE di_queue_jobs SET status = 'completed', completed_at = ?, lease_expires_at = NULL WHERE id = ?`,
      [Date.now(), jobId],
    );
  }

  async fail(jobId: string, error: Error | string, retryAfterMs?: number): Promise<void> {
    await this.ensureReady();
    const message = typeof error === 'string' ? error : error.message;
    const stack = typeof error === 'string' ? null : (error.stack ?? null);
    const job = await this.getJob(jobId);
    if (!job) return;
    if (job.attempts < job.maxRetries) {
      const delay =
        retryAfterMs !== undefined
          ? retryAfterMs
          : Math.min(job.backoffMs * 2 ** (job.attempts - 1), 60_000);
      await this.db.run(
        `UPDATE di_queue_jobs SET status = 'pending', available_at = ?, failed_at = ?,
         error_message = ?, error_stack = ?, lease_expires_at = NULL WHERE id = ?`,
        [Date.now() + delay, Date.now(), message, stack, jobId],
      );
      return;
    }
    await this.db.run(
      `UPDATE di_queue_jobs SET status = 'dead-letter', failed_at = ?, error_message = ?,
       error_stack = ?, lease_expires_at = NULL WHERE id = ?`,
      [Date.now(), message, stack, jobId],
    );
  }

  async recoverUnacknowledged(queueName?: string, _leaseTimeoutMs = 30_000): Promise<number> {
    await this.ensureReady();
    const now = Date.now();
    return this.db.transaction(async (tx) => {
      let query = `SELECT id, attempts, max_retries FROM di_queue_jobs
        WHERE status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`;
      const params: unknown[] = [now];
      if (queueName) {
        query += ` AND queue_name = ?`;
        params.push(queueName);
      }
      const stuck = await tx.query(query, params);
      let count = 0;
      for (const job of stuck) {
        if (Number(job.attempts) >= Number(job.max_retries)) {
          await tx.run(
            `UPDATE di_queue_jobs SET status = 'dead-letter', lease_expires_at = NULL WHERE id = ?`,
            [job.id],
          );
        } else {
          await tx.run(
            `UPDATE di_queue_jobs SET status = 'pending', available_at = ?, lease_expires_at = NULL WHERE id = ?`,
            [now, job.id],
          );
        }
        count += 1;
      }
      return count;
    });
  }

  async getJob(jobId: string): Promise<Job<any> | null> {
    await this.ensureReady();
    const row = await this.db.first(`SELECT * FROM di_queue_jobs WHERE id = ?`, [jobId]);
    return row ? this.rowToJob(row) : null;
  }

  async listJobs(queueName: string, filter: ListJobsFilter = {}): Promise<Job<any>[]> {
    await this.ensureReady();
    let sql = 'SELECT * FROM di_queue_jobs WHERE queue_name = ?';
    const params: unknown[] = [queueName];
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        if (filter.status.length > 0) {
          sql += ` AND status IN (${filter.status.map(() => '?').join(', ')})`;
          params.push(...filter.status);
        }
      } else {
        sql += ` AND status = ?`;
        params.push(filter.status);
      }
    }
    sql += ' ORDER BY enqueued_at ASC';
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    } else if (filter.offset !== undefined) {
      sql += ' LIMIT -1 OFFSET ?';
      params.push(filter.offset);
    }
    const rows = await this.db.query(sql, params);
    return rows.map((row) => this.rowToJob(row));
  }

  async listQueues(): Promise<QueueInfo[]> {
    await this.ensureReady();
    const rows = await this.db.query(
      `SELECT queue_name as name,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
              COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
              COALESCE(SUM(CASE WHEN status = 'dead-letter' THEN 1 ELSE 0 END), 0) as deadLetter,
              COUNT(*) as total
       FROM di_queue_jobs GROUP BY queue_name ORDER BY queue_name ASC`,
    );
    const infos: QueueInfo[] = rows.map((row: any) => ({
      name: row.name as string,
      pending: Number(row.pending ?? 0),
      processing: Number(row.processing ?? 0),
      completed: Number(row.completed ?? 0),
      deadLetter: Number(row.deadLetter ?? 0),
      total: Number(row.total ?? 0),
    }));
    const declared = new Set(queueRegistry.getAll().map((handler) => handler.queueName));
    for (const name of declared) {
      if (!infos.some((info) => info.name === name)) {
        infos.push({ name, pending: 0, processing: 0, completed: 0, deadLetter: 0, total: 0 });
      }
    }
    return infos;
  }

  async retryJob(queueName: string, jobId?: string): Promise<Job<any>[]> {
    await this.ensureReady();
    const now = Date.now();
    return this.db.transaction(async (tx) => {
      let selectSql = `SELECT * FROM di_queue_jobs WHERE queue_name = ? AND status = 'dead-letter'`;
      const params: unknown[] = [queueName];
      if (jobId !== undefined) {
        selectSql += ` AND id = ?`;
        params.push(jobId);
      }
      const rows = await tx.query(selectSql, params);
      if (rows.length === 0) return [];

      let updateSql = `UPDATE di_queue_jobs SET status = 'pending', available_at = ?,
        error_message = NULL, error_stack = NULL WHERE queue_name = ? AND status = 'dead-letter'`;
      const updateParams: unknown[] = [now, queueName];
      if (jobId !== undefined) {
        updateSql += ` AND id = ?`;
        updateParams.push(jobId);
      }
      await tx.run(updateSql, updateParams);
      return rows.map((r) => ({
        ...this.rowToJob(r),
        status: 'pending' as JobStatus,
        availableAt: now,
        errorMessage: undefined,
        errorStack: undefined,
      }));
    });
  }

  async close(): Promise<void> {
    await this.ensureReady();
    await this.db.close?.();
  }
}

export function createSqliteQueueBackend(
  options: string | { path?: string; durableWasi?: boolean } = ':memory:',
): QueueBackend {
  if (
    typeof options === 'object' &&
    options &&
    (options.durableWasi || process.env.DI_SQLITE_BACKEND === 'wasm')
  ) {
    return new WasmSqliteQueueBackend(options.path ?? ':memory:');
  }
  throw new Error(
    'Native SqliteQueueBackend must be constructed directly; use WasmSqliteQueueBackend for WASI',
  );
}
