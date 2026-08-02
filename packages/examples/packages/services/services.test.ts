import { describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import { DatabaseService } from './DatabaseService';
import { LoggerService } from './LoggerService';
import { UserService } from './UserService';

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

  test('LoggerService stores logs', () => {
    const logger = useContainer().resolve(LoggerService);
    logger.log('first');
    logger.log('second');
    const logs = logger.getLogs();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.some((l) => l.includes('first'))).toBe(true);
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
});
