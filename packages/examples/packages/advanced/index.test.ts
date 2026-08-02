import { expect, test } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import * as advanced from './index';

test('advanced example - NotificationService uses EmailService', () => {
  const container = useContainer();
  const notificationService = container.resolve<any>(advanced.NotificationService);

  if (notificationService) {
    expect(notificationService.email).toBeDefined();
    expect(notificationService.email.send).toBeInstanceOf(Function);
  }
});

test('advanced example - runs successfully and exercises remaining paths', async () => {
  await expect(advanced.runAdvancedExamples()).resolves.toBeUndefined();
});
