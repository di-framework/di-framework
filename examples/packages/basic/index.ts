/**
 * di-framework Demo
 *
 * This demonstrates how the DI framework simplifies service management
 * compared to the manual approach shown in SAMPLE.ts
 */

import { useContainer } from '@di-framework/di-framework/container';
import { ApplicationContext } from '../services/ApplicationContext';

console.log('='.repeat(60));
console.log('di-framework Demo');
console.log('='.repeat(60));
console.log();

// Get the global DI container
// All @Container decorated classes are automatically registered
const container = useContainer();

console.log('Registered services:', container.getServiceNames());
console.log();

// Resolve services - dependencies are automatically injected
console.log('--- Resolving ApplicationContext (with all dependencies) ---');
const appContext = container.resolve<ApplicationContext>(ApplicationContext);
console.log();

// Use the application context
console.log('--- Using the application context ---');
appContext.db.connect();
appContext.logger.log('Application started');
console.log();

// Create a user
console.log('--- Creating a user ---');
const user = appContext.users.createUser('1', 'John Doe', 'john@example.com');
console.log(`Created user: ${JSON.stringify(user)}`);
console.log();

// Get the user
console.log('--- Retrieving the user ---');
const retrievedUser = appContext.users.getUser('1');
console.log(`Retrieved user: ${JSON.stringify(retrievedUser)}`);
console.log();

// Create more users
console.log('--- Creating more users ---');
appContext.users.createUser('2', 'Jane Smith', 'jane@example.com');
appContext.users.createUser('3', 'Bob Johnson', 'bob@example.com');
console.log();

// List all users
console.log('--- Listing all users ---');
const users = appContext.users.listUsers();
console.log(`Total users: ${users.length}`);
users.forEach((u: any) => {
  console.log(`  - ${u.name} (${u.email})`);
});
console.log();

// Set environment
console.log('--- Setting environment ---');
appContext.setEnv({
  DATABASE_URL: 'postgres://localhost/myapp',
  LOG_LEVEL: 'debug',
  API_KEY: 'secret123',
});
console.log();

// Get logs
console.log('--- Application logs ---');
const logs = appContext.logger.getLogs();
console.log(`Total log entries: ${logs.length}`);
logs.forEach((log: any) => {
  console.log(`  ${log}`);
});
console.log();

// Disconnect
console.log('--- Disconnecting ---');
appContext.db.disconnect();
console.log();

console.log('='.repeat(60));
console.log('Demo complete! The DI framework automatically:');
console.log('  ✓ Registered all @Container services');
console.log('  ✓ Resolved dependencies automatically');
console.log('  ✓ Created singleton instances');
console.log('  ✓ Injected dependencies into constructors');
console.log('='.repeat(60));
