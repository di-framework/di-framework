import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core';
import { ApplicationContext } from './ApplicationContext';
import { DatabaseService } from './DatabaseService';
import { LoggerService } from './LoggerService';
import { UserService } from './UserService';

beforeEach(() => {
  const container = useContainer();
  // Re-register after other suites call clear() — @Container() only runs once at import time.
  if (!container.has(DatabaseService)) container.register(DatabaseService, { singleton: true });
  if (!container.has(LoggerService)) container.register(LoggerService, { singleton: true });
  if (!container.has(UserService)) container.register(UserService, { singleton: true });
  if (!container.has(ApplicationContext))
    container.register(ApplicationContext, { singleton: true });
});

describe('services example', () => {
  test('DatabaseService connects and queries', () => {
    const db = useContainer().resolve(DatabaseService);
    // Ensure clean state regardless of previous tests
    if (db.isConnected()) db.disconnect();
    db.connect();
    expect(db.isConnected()).toBe(true);
    const res = db.query('SELECT 1');
    expect(res).toEqual({ success: true });
    db.disconnect();
    expect(db.isConnected()).toBe(false);
  });

  test('LoggerService stores logs and handles error logs', () => {
    const logger = useContainer().resolve(LoggerService);
    logger.log('first');
    logger.error('something failed');
    const logs = logger.getLogs();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.some((l) => l.includes('first'))).toBe(true);
    expect(logs.some((l) => l.includes('ERROR: something failed'))).toBe(true);
  });

  test('UserService create/get/list users', () => {
    const container = useContainer();
    const db = container.resolve(DatabaseService);
    // Ensure DB is connected for queries
    if (!db.isConnected()) db.connect();

    const users = container.resolve(UserService);
    const u = users.createUser('u1', 'Alice', 'alice@example.com');
    expect(u).toEqual({ id: 'u1', name: 'Alice', email: 'alice@example.com' });

    const got = users.getUser('u1');
    expect(got).toEqual(u);

    const all = users.listUsers();
    expect(all.find((x) => x.id === 'u1')).toBeDefined();
  });

  test('ApplicationContext manages environment and context', () => {
    const appCtx = useContainer().resolve(ApplicationContext);

    appCtx.setEnv({ FOO: 'bar' });
    expect(appCtx.getEnv()).toEqual({ FOO: 'bar' });

    const ctxObj = { waitUntil: () => {} };
    appCtx.setCtx(ctxObj);
    expect(appCtx.getCtx()).toBe(ctxObj);
  });

  test('LoggerService clearLogs clears stored logs', () => {
    const logger = useContainer().resolve(LoggerService);
    logger.log('test clear');
    logger.clearLogs();
    expect(logger.getLogs().length).toBe(0);
  });
});
