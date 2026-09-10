import { container } from '@di-framework/core';
import { AuditLogger } from './services/AuditLogger';
import { DatabaseRepository } from './services/DatabaseRepository';
import { MaintenanceService } from './services/MaintenanceService';

export * from './services/AuditLogger';
export * from './services/DatabaseRepository';
export * from './services/MaintenanceService';

// Register services in DI container
container.register(AuditLogger);
container.register(DatabaseRepository);
container.register(MaintenanceService);

export { container };
