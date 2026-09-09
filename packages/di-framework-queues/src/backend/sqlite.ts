import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { EnqueueOptions, Job, JobStatus, ListJobsFilter, QueueInfo } from '../types.js';
import type { QueueBackend } from './contract.js';

export class SqliteQueueBackend implements QueueBackend {
  readonly name = 'sqlite';
  private db: Database;
  private nextId = 1;

  constructor(databaseOrPath: string | Database | { path?: string; db?: Database } = ':memory:') {
    let resolved: string | Database = ':memory:';
    if (typeof databaseOrPath === 'string') {
      resolved = databaseOrPath;
    } else if (databaseOrPath instanceof Database) {
      resolved = databaseOrPath;
    } else if (typeof databaseOrPath === 'object' && databaseOrPath !== null) {
      if ('exec' in databaseOrPath) {
        resolved = databaseOrPath as Database;
      } else {
        resolved = databaseOrPath.path ?? databaseOrPath.db ?? ':memory:';
      }
    }

    if (typeof resolved === 'string') {
      if (resolved !== ':memory:' && !resolved.startsWith('file::memory:')) {
        const dir = dirname(resolved);
        if (dir && dir !== '.') {
          try {
            mkdirSync(dir, { recursive: true });
          } catch {
            // directory may already exist
          }
        }
      }
      this.db = new Database(resolved, { create: true });
    } else {
      this.db = resolved;
    }

    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    } catch {
      // WAL might not be supported on in-memory db
    }

    this.initSchema();
  }

  getDatabase(): Database {
    return this.db;
  }

  private initSchema(): void {
    this.db.exec(`
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

  async enqueue<T>(queueName: string, payload: T, options?: EnqueueOptions): Promise<Job<T>> {
    const enqueuedAt = Date.now();
    const idempotencyKey = options?.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      const existing = this.db
        .prepare(
          `SELECT * FROM di_queue_jobs WHERE queue_name = ? AND idempotency_key = ? AND status != 'dead-letter' LIMIT 1`,
        )
        .get(queueName, idempotencyKey);
      if (existing) {
        return this.rowToJob<T>(existing);
      }
    }

    const id =
      options?.jobId ??
      `job_${enqueuedAt}_${this.nextId++}_${Math.random().toString(36).substring(2, 9)}`;

    const priority = options?.priority ?? 0;
    const maxRetries = options?.maxRetries ?? 3;
    const backoffMs = options?.backoffMs ?? 1000;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const availableAt = enqueuedAt + (options?.delayMs ?? 0);
    const serializedPayload = JSON.stringify(payload);

    this.db
      .prepare(
        `INSERT INTO di_queue_jobs (
          id, queue_name, idempotency_key, payload, status, priority, attempts,
          max_retries, backoff_ms, timeout_ms, enqueued_at, available_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        queueName,
        idempotencyKey,
        serializedPayload,
        priority,
        maxRetries,
        backoffMs,
        timeoutMs,
        enqueuedAt,
        availableAt,
      );

    return {
      id,
      queueName,
      payload,
      status: 'pending',
      priority,
      attempts: 0,
      maxRetries,
      backoffMs,
      timeoutMs,
      enqueuedAt,
      availableAt,
      idempotencyKey: idempotencyKey ?? undefined,
    };
  }

  async dequeue(queueName: string, leaseTimeoutMs = 30000): Promise<Job<any> | null> {
    const now = Date.now();
    const leaseExpiresAt = now + leaseTimeoutMs;

    const tx = this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT * FROM di_queue_jobs
           WHERE queue_name = ? AND status = 'pending' AND available_at <= ?
           ORDER BY priority DESC, available_at ASC, enqueued_at ASC
           LIMIT 1`,
        )
        .get(queueName, now) as any;

      if (!candidate) return null;

      this.db
        .prepare(
          `UPDATE di_queue_jobs
           SET status = 'processing',
               attempts = attempts + 1,
               started_at = ?,
               lease_expires_at = ?
           WHERE id = ?`,
        )
        .run(now, leaseExpiresAt, candidate.id);

      candidate.status = 'processing';
      candidate.attempts += 1;
      candidate.started_at = now;
      candidate.lease_expires_at = leaseExpiresAt;
      return this.rowToJob(candidate);
    });

    return tx();
  }

  async complete(jobId: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE di_queue_jobs
         SET status = 'completed', completed_at = ?, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(now, jobId);
  }

  async fail(jobId: string, error: Error | string, retryAfterMs?: number): Promise<void> {
    const now = Date.now();
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack ?? null : null;

    const tx = this.db.transaction(() => {
      const job = this.db
        .prepare('SELECT attempts, max_retries, backoff_ms FROM di_queue_jobs WHERE id = ?')
        .get(jobId) as any;
      if (!job) return;

      if (job.attempts < job.max_retries) {
        const backoff =
          retryAfterMs !== undefined
            ? retryAfterMs
            : Math.min(job.backoff_ms * Math.pow(2, job.attempts - 1), 60000);
        const nextAvailable = now + backoff;

        this.db
          .prepare(
            `UPDATE di_queue_jobs
             SET status = 'pending',
                 available_at = ?,
                 failed_at = ?,
                 error_message = ?,
                 error_stack = ?,
                 lease_expires_at = NULL
             WHERE id = ?`,
          )
          .run(nextAvailable, now, errorMsg, errorStack, jobId);
      } else {
        this.db
          .prepare(
            `UPDATE di_queue_jobs
             SET status = 'dead-letter',
                 failed_at = ?,
                 error_message = ?,
                 error_stack = ?,
                 lease_expires_at = NULL
             WHERE id = ?`,
          )
          .run(now, errorMsg, errorStack, jobId);
      }
    });

    tx();
  }

  async recoverUnacknowledged(queueName?: string, leaseTimeoutMs = 30000): Promise<number> {
    const now = Date.now();

    const tx = this.db.transaction(() => {
      let query = `SELECT id, attempts, max_retries FROM di_queue_jobs WHERE status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`;
      const params: any[] = [now];
      if (queueName) {
        query += ` AND queue_name = ?`;
        params.push(queueName);
      }

      const stuckJobs = this.db.prepare(query).all(...params) as Array<{
        id: string;
        attempts: number;
        max_retries: number;
      }>;

      let count = 0;
      for (const job of stuckJobs) {
        if (job.attempts >= job.max_retries) {
          this.db
            .prepare(
              `UPDATE di_queue_jobs SET status = 'dead-letter', lease_expires_at = NULL WHERE id = ?`,
            )
            .run(job.id);
        } else {
          this.db
            .prepare(
              `UPDATE di_queue_jobs SET status = 'pending', available_at = ?, lease_expires_at = NULL WHERE id = ?`,
            )
            .run(now, job.id);
        }
        count += 1;
      }
      return count;
    });

    return tx();
  }

  async getJob(jobId: string): Promise<Job<any> | null> {
    const row = this.db.prepare('SELECT * FROM di_queue_jobs WHERE id = ?').get(jobId);
    return row ? this.rowToJob(row) : null;
  }

  async listJobs(queueName: string, filter?: ListJobsFilter): Promise<Job<any>[]> {
    let sql = 'SELECT * FROM di_queue_jobs WHERE queue_name = ?';
    const params: any[] = [queueName];

    if (filter?.status) {
      if (Array.isArray(filter.status)) {
        if (filter.status.length > 0) {
          const placeholders = filter.status.map(() => '?').join(', ');
          sql += ` AND status IN (${placeholders})`;
          params.push(...filter.status);
        }
      } else {
        sql += ` AND status = ?`;
        params.push(filter.status);
      }
    }

    sql += ' ORDER BY enqueued_at ASC';

    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter?.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    } else if (filter?.offset !== undefined) {
      sql += ' LIMIT -1 OFFSET ?';
      params.push(filter.offset);
    }

    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r) => this.rowToJob(r));
  }

  async listQueues(): Promise<QueueInfo[]> {
    const rows = this.db
      .prepare(
        `SELECT
           queue_name as name,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
           COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
           COALESCE(SUM(CASE WHEN status = 'dead-letter' THEN 1 ELSE 0 END), 0) as deadLetter,
           COUNT(*) as total
         FROM di_queue_jobs
         GROUP BY queue_name
         ORDER BY queue_name ASC`,
      )
      .all() as any[];

    return rows.map((r) => ({
      name: r.name,
      pending: Number(r.pending),
      processing: Number(r.processing),
      completed: Number(r.completed),
      deadLetter: Number(r.deadLetter),
      total: Number(r.total),
    }));
  }

  async retryJob(queueName: string, jobId?: string): Promise<Job<any>[]> {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      let selectSql = `SELECT * FROM di_queue_jobs WHERE queue_name = ? AND status = 'dead-letter'`;
      const params: any[] = [queueName];
      if (jobId !== undefined) {
        selectSql += ` AND id = ?`;
        params.push(jobId);
      }

      const rows = this.db.prepare(selectSql).all(...params);
      if (rows.length === 0) return [];

      let updateSql = `UPDATE di_queue_jobs SET status = 'pending', available_at = ?, error_message = NULL, error_stack = NULL WHERE queue_name = ? AND status = 'dead-letter'`;
      const updateParams: any[] = [now, queueName];
      if (jobId !== undefined) {
        updateSql += ` AND id = ?`;
        updateParams.push(jobId);
      }

      this.db.prepare(updateSql).run(...updateParams);
      return rows.map((r: any) => ({
        ...this.rowToJob(r),
        status: 'pending' as JobStatus,
        availableAt: now,
        errorMessage: undefined,
        errorStack: undefined,
      }));
    });

    return tx();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
