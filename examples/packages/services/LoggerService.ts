/**
 * Example Logger Service
 *
 * Demonstrates a simple injectable service with lifecycle methods
 */

import { Container, TelemetryListener } from '@di-framework/di-framework/decorators';

@Container()
export class LoggerService {
  private logs: string[] = [];

  constructor() {
    console.log('[LoggerService] Created');
  }

  @TelemetryListener()
  onTelemetry(event: any): void {
    const { className, methodName, startTime, endTime, error } = event;
    const duration = endTime ? (endTime - startTime).toFixed(2) : 'N/A';
    const status = error ? `FAILED (${error.message})` : 'SUCCESS';
    this.log(`[Telemetry] ${className}.${methodName} - ${status} (${duration}ms)`);
  }

  log(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);
    console.log(`[LoggerService] ${logEntry}`);
  }

  error(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ERROR: ${message}`;
    this.logs.push(logEntry);
    console.error(`[LoggerService] ${logEntry}`);
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
    console.log('[LoggerService] Logs cleared');
  }
}
