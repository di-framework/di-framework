/**
 * Example Application Context
 *
 * Demonstrates a complex service with multiple dependencies
 * Similar to the SAMPLE.ts ApplicationContext but using DI framework
 */

import { Component, Container } from '@di-framework/di-framework/decorators';
import { DatabaseService } from './DatabaseService';
import { LoggerService } from './LoggerService';
import { UserService } from './UserService';

@Container()
export class ApplicationContext {
  private env: Record<string, any> = {};
  private executionContext: any = null;

  constructor(
    @Component(DatabaseService) public readonly db: DatabaseService,
    @Component(UserService) public readonly users: UserService,
    @Component(LoggerService) public readonly logger: LoggerService,
  ) {
    console.log('[ApplicationContext] Created with all dependencies');
  }

  /**
   * Initialize environment variables
   * Similar to setEnv in SAMPLE.ts
   */
  setEnv(env: Record<string, any>): void {
    this.env = env;
    this.logger.log(`Environment initialized: ${JSON.stringify(Object.keys(env))}`);

    // Initialize services with environment
    if (typeof (this.db as any).setEnv === 'function') {
      (this.db as any).setEnv(env);
    }
    if (typeof (this.users as any).setEnv === 'function') {
      (this.users as any).setEnv(env);
    }
  }

  /**
   * Set execution context
   * Similar to setCtx in SAMPLE.ts
   */
  setCtx(ctx: any): void {
    this.executionContext = ctx;
    this.logger.log('Execution context set');

    // Pass context to services
    if (typeof (this.db as any).setCtx === 'function') {
      (this.db as any).setCtx(ctx);
    }
    if (typeof (this.users as any).setCtx === 'function') {
      (this.users as any).setCtx(ctx);
    }
  }

  /**
   * Get the current environment
   */
  getEnv(): Record<string, any> {
    return { ...this.env };
  }

  /**
   * Get the current execution context
   */
  getCtx(): any {
    return this.executionContext;
  }
}
