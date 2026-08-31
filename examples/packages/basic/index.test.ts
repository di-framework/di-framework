import { beforeEach, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core';
import { ApplicationContext } from '@di-framework/services-example';
import { DatabaseService } from '@di-framework/services-example/DatabaseService';
import { LoggerService } from '@di-framework/services-example/LoggerService';
import { UserService } from '@di-framework/services-example/UserService';

beforeEach(() => {
  const container = useContainer();
  if (!container.has(DatabaseService)) container.register(DatabaseService, { singleton: true });
  if (!container.has(LoggerService)) container.register(LoggerService, { singleton: true });
  if (!container.has(UserService)) container.register(UserService, { singleton: true });
  if (!container.has(ApplicationContext))
    container.register(ApplicationContext, { singleton: true });
});

test('basic example resolves ApplicationContext', () => {
  const container = useContainer();
  const appContext = container.resolve<ApplicationContext>(ApplicationContext);

  expect(appContext).toBeDefined();
  expect(appContext.db).toBeDefined();
  expect(appContext.logger).toBeDefined();
  expect(appContext.users).toBeDefined();
});

test('basic example usage', () => {
  const container = useContainer();
  const appContext = container.resolve<ApplicationContext>(ApplicationContext);

  appContext.db.connect();
  appContext.logger.log('Test log');

  const user = appContext.users.createUser('test-1', 'Test User', 'test@example.com');
  expect(user.id).toBe('test-1');

  const retrievedUser = appContext.users.getUser('test-1');
  expect(retrievedUser).toEqual(user);
});
