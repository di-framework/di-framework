/**
 * Example Database Service
 *
 * Demonstrates a simple injectable service
 */

import { Container } from '@di-framework/di-framework/decorators';

@Container()
export class DatabaseService {
  private connected: boolean = false;

  constructor() {
    console.log('[DatabaseService] Created');
  }

  connect(): void {
    this.connected = true;
    console.log('[DatabaseService] Connected to database');
  }

  disconnect(): void {
    this.connected = false;
    console.log('[DatabaseService] Disconnected from database');
  }

  isConnected(): boolean {
    return this.connected;
  }

  query(sql: string): any {
    if (!this.connected) {
      throw new Error('Database not connected');
    }
    console.log(`[DatabaseService] Executing query: ${sql}`);
    return { success: true };
  }
}
