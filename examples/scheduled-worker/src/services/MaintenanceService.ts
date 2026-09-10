import { Component, Cron, Container as Injectable } from '@di-framework/core/decorators';
import { AuditLogger } from './AuditLogger.js';
import { DatabaseRepository, type PruneSummary } from './DatabaseRepository.js';

export interface MaintenanceReport {
  job: string;
  pruned: number;
  auditCount: number;
  timestamp: string;
}

@Injectable()
export class MaintenanceService {
  @Component(DatabaseRepository)
  public db!: DatabaseRepository;

  @Component(AuditLogger)
  public audit!: AuditLogger;

  /**
   * Daily prune job executed by external scheduler at 02:00.
   * Concurrency is disabled to prevent overlapping executions on slow runs.
   */
  @Cron('0 2 * * *', {
    name: 'nightly-prune',
    description: 'Purges expired database session records nightly',
    allowConcurrent: false,
    timeoutMs: 10000,
  })
  public async purgeExpiredSessions(): Promise<MaintenanceReport> {
    const summary: PruneSummary = await this.db.deleteExpiredRecords();
    this.audit.recordAction('prune_expired_sessions', {
      deletedCount: summary.deletedCount,
      table: summary.table,
    });

    return {
      job: 'nightly-prune',
      pruned: summary.deletedCount,
      auditCount: this.audit.getLogCount(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Periodic rebalance job executed every 15 minutes.
   */
  @Cron('*/15 * * * *', {
    name: 'partition-rebalance',
    description: 'Rebalances active storage partitions',
    allowConcurrent: false,
  })
  public async rebalanceStorage(): Promise<{ rebalanced: number }> {
    const result = await this.db.rebalancePartitions();
    this.audit.recordAction('rebalance_storage', { count: result.rebalanced });
    return result;
  }
}
