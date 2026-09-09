import { Container as Injectable } from '@di-framework/core/decorators';

export interface AuditEntry {
  action: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

@Injectable()
export class AuditLogger {
  public logs: AuditEntry[] = [];

  public recordAction(action: string, details: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = {
      action,
      details,
      timestamp: new Date(),
    };
    this.logs.push(entry);
    return entry;
  }

  public getLogCount(): number {
    return this.logs.length;
  }

  public clear(): void {
    this.logs = [];
  }
}
