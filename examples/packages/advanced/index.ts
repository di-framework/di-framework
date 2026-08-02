/**
 * Advanced di-framework Examples
 *
 * This file demonstrates advanced usage patterns of the DI framework
 */

import { Container as DIContainer, useContainer } from '@di-framework/di-framework/container';
import {
  Component,
  Container,
  Telemetry,
  TelemetryListener,
} from '@di-framework/di-framework/decorators';

// ============================================================================
// Example 1: Multi-Level Dependency Chains
// ============================================================================

@Container()
class EmailService {
  send(to: string, subject: string, body: string): void {
    console.log(`📧 Email sent to ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body: ${body}`);
  }
}

@Container()
export class NotificationService {
  @Component(EmailService)
  private email!: EmailService;

  constructor() {}

  notifyUser(userId: string, message: string): void {
    this.email.send(`user${userId}@example.com`, 'Notification', message);
  }
}

@Container()
class UserRegistrationService {
  @Component(NotificationService)
  private notifications!: NotificationService;

  constructor() {}

  registerUser(name: string): void {
    console.log(`✅ User registered: ${name}`);
    this.notifications.notifyUser('1', `Welcome ${name}!`);
  }
}

// ============================================================================
// Example 2: Custom Container for Testing
// ============================================================================

class TestEmailService extends EmailService {
  send(to: string, subject: string, body: string): void {
    console.log(`[TEST] Email to ${to}: ${subject}`);
  }
}

// ============================================================================
// Example 3: Configuration Service with Factory
// ============================================================================

interface AppConfig {
  apiUrl: string;
  apiKey: string;
  environment: string;
}

@Container()
class ConfigService {
  private config: AppConfig = {
    apiUrl: 'https://api.example.com',
    apiKey: process.env.API_KEY || 'default-key',
    environment: process.env.NODE_ENV || 'development',
  };

  get(key: keyof AppConfig): string {
    return this.config[key];
  }

  getAll(): AppConfig {
    return { ...this.config };
  }
}

@Container()
class ApiService {
  private baseUrl: string = '';

  @Component(ConfigService)
  private config!: ConfigService;

  constructor() {
    // baseUrl will be set after injection
  }

  setConfig(config: ConfigService): void {
    this.config = config;
    this.baseUrl = config.get('apiUrl');
  }

  call(endpoint: string): Promise<any> {
    if (!this.baseUrl) {
      this.baseUrl = this.config.get('apiUrl');
    }
    console.log(`🌐 API Call: ${this.baseUrl}${endpoint}`);
    return Promise.resolve({ success: true });
  }
}

// ============================================================================
// Example 4: Transient Services for Request Scoping
// ============================================================================

@Container({ singleton: false })
class RequestLogger {
  private requestId: string = Math.random().toString(36).substring(7);
  private startTime: number = Date.now();

  @Component(ConfigService)
  private config!: ConfigService;

  constructor() {
    // Config will be injected
  }

  onInit(): void {
    console.log(`🔍 [Request ${this.requestId}] Created in ${this.config.get('environment')}`);
  }

  log(message: string): void {
    const elapsed = Date.now() - this.startTime;
    console.log(`[Request ${this.requestId}] (${elapsed}ms) ${message}`);
  }

  getRequestId(): string {
    return this.requestId;
  }
}

@Container()
class RequestHandler {
  @Component(ApiService)
  private api!: ApiService;

  constructor() {}

  async handle(endpoint: string, logger: RequestLogger): Promise<void> {
    logger.log('Handling request...');
    const result = await this.api.call(endpoint);
    logger.log(`Response received: ${JSON.stringify(result)}`);
  }
}

// ============================================================================
// Example 5: Service with Optional Lifecycle Methods
// ============================================================================

interface Lifecycle {
  onInit?(): void;
  onDestroy?(): void;
}

@Container()
class CacheService implements Lifecycle {
  private cache = new Map<string, any>();
  private hitCount = 0;
  private missCount = 0;

  onInit(): void {
    console.log('🗄️ Cache service initialized');
  }

  onDestroy(): void {
    console.log(`🗄️ Cache service destroyed (${this.hitCount} hits, ${this.missCount} misses)`);
  }

  set(key: string, value: any): void {
    this.cache.set(key, value);
  }

  get(key: string): any {
    if (this.cache.has(key)) {
      this.hitCount++;
      return this.cache.get(key);
    }
    this.missCount++;
    return undefined;
  }

  clear(): void {
    this.cache.clear();
    console.log('🗄️ Cache cleared');
  }
}

@Container()
class CachedDataService {
  @Component(CacheService)
  private cache!: CacheService;

  constructor() {}

  getData(key: string): any {
    let data = this.cache.get(key);
    if (!data) {
      data = { id: key, timestamp: Date.now() };
      this.cache.set(key, data);
    }
    return data;
  }
}

// ============================================================================
// Example 6: Composite Services
// ============================================================================

@Container()
class AuthService {
  authenticate(username: string, password: string): boolean {
    console.log(`🔐 Authenticating user: ${username}`);
    return username === 'admin' && password === 'password';
  }
}

@Container()
class PermissionService {
  hasPermission(userId: string, action: string): boolean {
    console.log(`✓ Checking permission for ${userId} to ${action}`);
    return true;
  }
}

@Container()
class SecureApiService {
  @Component(ApiService)
  private api!: ApiService;

  @Component(AuthService)
  private auth!: AuthService;

  @Component(PermissionService)
  private permissions!: PermissionService;

  constructor() {}

  async secureCall(endpoint: string, username: string, password: string): Promise<any> {
    if (!this.auth.authenticate(username, password)) {
      throw new Error('Authentication failed');
    }

    if (!this.permissions.hasPermission(username, 'api:call')) {
      throw new Error('Permission denied');
    }

    return this.api.call(endpoint);
  }
}

// ============================================================================
// Example 7: Telemetry and Event Monitoring
// ============================================================================

@Container()
class AnalyticsService {
  @TelemetryListener()
  trackMethodCall(event: any): void {
    const { className, methodName, startTime, endTime, error } = event;
    const duration = endTime ? (endTime - startTime).toFixed(2) : 'N/A';
    console.log(
      `📊 [Analytics] ${className}.${methodName} - ${error ? 'FAILED' : 'SUCCESS'} (${duration}ms)`,
    );
  }
}

@Container()
class PaymentProcessor {
  @Component(AnalyticsService)
  private analytics!: AnalyticsService;

  @Telemetry({ logging: true })
  async processPayment(amount: number): Promise<boolean> {
    console.log(`💳 Processing payment of $${amount}...`);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 100));
    return true;
  }
}

// ============================================================================
// Demo: Running all examples
// ============================================================================

export async function runAdvancedExamples(): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('Advanced di-framework Examples');
  console.log('='.repeat(70) + '\n');

  const container = useContainer();

  // Example 1: Multi-level dependency chains
  console.log('--- Example 1: Multi-Level Dependency Chains ---\n');
  const registration = container.resolve(UserRegistrationService);
  registration.registerUser('Alice');
  console.log();

  // Example 2: Testing with custom container
  console.log('--- Example 2: Custom Container for Testing ---\n');
  const testContainer = new DIContainer();
  testContainer.register(ConfigService);
  testContainer.register(TestEmailService);
  const testEmail = testContainer.resolve(TestEmailService);
  testEmail.send('tester@example.com', 'Ping', 'from test container');
  console.log('✓ Test container created with mock services\n');

  // Example 3: Configuration Service
  console.log('--- Example 3: Configuration Service ---\n');
  const config = container.resolve(ConfigService);
  console.log('Config:', config.getAll());
  const api = container.resolve(ApiService);
  api.setConfig(config);
  await api.call('/users');
  console.log();

  // Example 4: Transient Services
  console.log('--- Example 4: Transient Services for Requests ---\n');
  const handler = container.resolve(RequestHandler);
  const logger1 = container.resolve(RequestLogger);
  const logger2 = container.resolve(RequestLogger);
  logger1.onInit();
  console.log(`Same instance? ${logger1.getRequestId() === logger2.getRequestId()}`); // false
  await handler.handle('/data', logger1);
  console.log();

  // Example 5: Lifecycle Methods
  console.log('--- Example 5: Service Lifecycle ---\n');
  const cache = container.resolve(CacheService);
  (cache as any).onInit?.();
  const cachedData = container.resolve(CachedDataService);
  console.log('First call:', cachedData.getData('user:1'));
  console.log('Second call (cached):', cachedData.getData('user:1'));
  console.log('New data:', cachedData.getData('user:2'));
  cache.clear();
  (cache as any).onDestroy?.();
  console.log();

  // Example 6: Composite Services
  console.log('--- Example 6: Composite Services ---\n');
  const secureApi = container.resolve(SecureApiService);
  try {
    await secureApi.secureCall('/protected', 'admin', 'password');
  } catch (error) {
    console.log('Error:', (error as Error).message);
  }
  console.log();

  // Example 7: Telemetry
  console.log('--- Example 7: Telemetry and Event Monitoring ---\n');
  const processor = container.resolve(PaymentProcessor);
  await processor.processPayment(49.99);
  console.log();

  console.log('='.repeat(70));
  console.log('All examples completed successfully!');
  console.log('='.repeat(70));
}

// Run examples if this file is executed directly
if (import.meta.main) {
  runAdvancedExamples();
}
