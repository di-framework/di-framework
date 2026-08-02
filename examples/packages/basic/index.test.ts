import { expect, test } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import { ApplicationContext } from '../services/ApplicationContext';

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
