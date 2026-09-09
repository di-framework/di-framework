import { Container as Injectable } from '@di-framework/core/decorators';

export interface PruneSummary {
  deletedCount: number;
  table: string;
}

@Injectable()
export class DatabaseRepository {
  public records = new Map<string, { id: string; expiresAt: number }>();
  public queryCount = 0;

  constructor() {
    this.seed();
  }

  public seed(): void {
    const now = Date.now();
    this.records.set('rec-1', { id: 'rec-1', expiresAt: now - 5000 }); // expired
    this.records.set('rec-2', { id: 'rec-2', expiresAt: now - 1000 }); // expired
    this.records.set('rec-3', { id: 'rec-3', expiresAt: now + 60000 }); // valid
  }

  public async deleteExpiredRecords(): Promise<PruneSummary> {
    this.queryCount++;
    const now = Date.now();
    let deleted = 0;

    for (const [key, item] of this.records.entries()) {
      if (item.expiresAt <= now) {
        this.records.delete(key);
        deleted++;
      }
    }

    return { deletedCount: deleted, table: 'sessions' };
  }

  public async rebalancePartitions(): Promise<{ rebalanced: number }> {
    this.queryCount++;
    return { rebalanced: this.records.size };
  }
}
