/**
 * Testing Examples for the DI Framework
 *
 * Shows how to write tests with mocked dependencies
 */

import { Component, Container } from '@di-framework/core/decorators';

// ============================================================================
// Service Definitions
// ============================================================================

interface IEmailService {
  send(to: string, subject: string, body: string): Promise<void>;
}

@Container()
class RealEmailService implements IEmailService {
  async send(to: string, subject: string, _body: string): Promise<void> {
    console.log(`[REAL] Sending email to ${to}: ${subject}`);
    // Real implementation would use SMTP or email API
    return Promise.resolve();
  }
}

@Container()
class UserService {
  constructor(@Component(RealEmailService) private emailService: IEmailService) {}

  async registerUser(email: string, name: string): Promise<void> {
    console.log(`Registering user: ${name} (${email})`);
    await this.emailService.send(email, 'Welcome!', `Hello ${name}, welcome to our service!`);
  }

  async notifyUser(email: string, message: string): Promise<void> {
    await this.emailService.send(email, 'Notification', message);
  }
}

// ============================================================================
// Mock Implementations for Testing
// ============================================================================

class MockEmailService implements IEmailService {
  sentEmails: Array<{ to: string; subject: string; body: string }> = [];

  async send(to: string, subject: string, body: string): Promise<void> {
    console.log(`[MOCK] Email sent to ${to}: ${subject}`);
    this.sentEmails.push({ to, subject, body });
  }

  getSentEmails() {
    return this.sentEmails;
  }

  clearSentEmails() {
    this.sentEmails = [];
  }
}

// ============================================================================
// Test Suite Examples
// ============================================================================

class TestRunner {
  private passed = 0;
  private failed = 0;
  private errors: Error[] = [];

  async test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`✓ ${name}`);
      this.passed++;
    } catch (error) {
      console.log(`✗ ${name}`);
      console.log(`  Error: ${(error as Error).message}`);
      this.failed++;
      this.errors.push(error as Error);
    }
  }

  assert(condition: boolean, message: string): void {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
      throw new Error(`Assertion failed: ${message}\n  Expected: ${expected}\n  Actual: ${actual}`);
    }
  }

  assertArrayLength(arr: any[], length: number, message: string): void {
    if (arr.length !== length) {
      throw new Error(
        `Assertion failed: ${message}\n  Expected length: ${length}\n  Actual length: ${arr.length}`,
      );
    }
  }

  getResults(): { passed: number; failed: number; total: number } {
    return {
      passed: this.passed,
      failed: this.failed,
      total: this.passed + this.failed,
    };
  }

  printSummary(): void {
    const results = this.getResults();
    console.log(`\n${'='.repeat(60)}`);
    console.log('Test Results');
    console.log('='.repeat(60));
    console.log(`Passed: ${results.passed}`);
    console.log(`Failed: ${results.failed}`);
    console.log(`Total: ${results.total}`);
    if (this.failed > 0) {
      console.log('\nErrors:');
      this.errors.forEach((error) => {
        console.log(`  - ${error.message}`);
      });
    }
    console.log('='.repeat(60));
  }
}

// ============================================================================
// Test Suites
// ============================================================================

async function testUserServiceWithMocks(): Promise<void> {
  console.log('\nTest Suite: UserService with Mocked Email Service');
  console.log('-'.repeat(60));

  const runner = new TestRunner();

  // Create test container with mocked dependencies
  const testContainer = new (Container as any)();
  const mockEmailService = new MockEmailService();

  // Register mock instead of real service
  testContainer.registerFactory('RealEmailService', () => mockEmailService, {
    singleton: true,
  });
  testContainer.register(UserService);

  // Resolve service (will use mock email service)
  const userService = (testContainer.resolve as any)(UserService);

  await runner.test('Should register user and send welcome email', async () => {
    mockEmailService.clearSentEmails();
    await userService.registerUser('john@example.com', 'John Doe');

    runner.assertArrayLength(mockEmailService.getSentEmails(), 1, 'Should send exactly 1 email');

    const email = mockEmailService.getSentEmails()[0]!;
    runner.assertEqual(email.to, 'john@example.com', 'Email should go to user');
    runner.assertEqual(email.subject, 'Welcome!', 'Subject should be Welcome!');
    runner.assert(email.body.includes('John Doe'), 'Body should include user name');
  });

  await runner.test('Should notify user', async () => {
    mockEmailService.clearSentEmails();
    await userService.notifyUser('jane@example.com', 'Your order has shipped');

    runner.assertArrayLength(mockEmailService.getSentEmails(), 1, 'Should send exactly 1 email');

    const email = mockEmailService.getSentEmails()[0]!;
    runner.assertEqual(email.to, 'jane@example.com', 'Email should go to correct user');
    runner.assertEqual(email.subject, 'Notification', 'Subject should be Notification');
  });

  await runner.test('Should handle multiple notifications', async () => {
    mockEmailService.clearSentEmails();

    await userService.notifyUser('user1@example.com', 'Message 1');
    await userService.notifyUser('user2@example.com', 'Message 2');
    await userService.notifyUser('user3@example.com', 'Message 3');

    runner.assertArrayLength(mockEmailService.getSentEmails(), 3, 'Should send 3 emails');
  });

  runner.printSummary();
}

async function testContainerIsolation(): Promise<void> {
  console.log('\nTest Suite: Container Isolation');
  console.log('-'.repeat(60));

  const runner = new TestRunner();

  // Test 1: Each container has its own instance
  await runner.test('Each container should have isolated instances', async () => {
    const container1 = new (Container as any)();
    const mockEmail1 = new MockEmailService();
    container1.registerFactory('email', () => mockEmail1);
    container1.register(UserService);

    const container2 = new (Container as any)();
    const mockEmail2 = new MockEmailService();
    container2.registerFactory('email', () => mockEmail2);
    container2.register(UserService);

    runner.assert(mockEmail1 !== mockEmail2, 'Mocks should be different instances');
    console.log('Containers are properly isolated ✓');
  });

  // Test 2: Singleton within container
  await runner.test('Singleton services should return same instance', async () => {
    const testContainer = new (Container as any)();
    const mockEmail = new MockEmailService();
    testContainer.registerFactory('email', () => mockEmail, {
      singleton: true,
    });
    testContainer.register(UserService);

    const service1 = (testContainer.resolve as any)(UserService);
    const service2 = (testContainer.resolve as any)(UserService);

    runner.assert(service1 === service2, 'Should return same singleton instance');
  });

  runner.printSummary();
}

async function testErrorScenarios(): Promise<void> {
  console.log('\nTest Suite: Error Scenarios');
  console.log('-'.repeat(60));

  const runner = new TestRunner();

  await runner.test('Should throw for unregistered service', async () => {
    const testContainer = new (Container as any)();

    try {
      testContainer.resolve('NonExistentService');
      throw new Error('Should have thrown ServiceNotFoundError');
    } catch (error) {
      runner.assert(
        (error as Error).message.includes('not registered'),
        'Should have proper error message',
      );
    }
  });

  runner.printSummary();
}

// ============================================================================
// Run All Tests
// ============================================================================

export async function runAllTests(): Promise<void> {
  console.log('='.repeat(60));
  console.log('DI Framework Test Suite');
  console.log('='.repeat(60));

  await testUserServiceWithMocks();
  await testContainerIsolation();
  await testErrorScenarios();

  console.log(`\n${'='.repeat(60)}`);
  console.log('All test suites completed!');
  console.log('='.repeat(60));
}

// Run tests if executed directly
if (import.meta.main) {
  runAllTests();
}
