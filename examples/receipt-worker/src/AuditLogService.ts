import { Component } from '@di-framework/core/decorators';

export type AuditEntry = {
  timestamp: number;
  action: string;
  details: unknown;
};

@Component()
export class AuditLogService {
  private readonly records: AuditEntry[] = [];

  log(action: string, details: unknown): void {
    this.records.push({ timestamp: Date.now(), action, details });
  }

  getRecords(): readonly AuditEntry[] {
    return this.records;
  }
}
