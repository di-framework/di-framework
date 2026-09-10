import { container } from '@di-framework/core';
import { AuditLogger } from './services/AuditLogger.js';
import { DatabaseRepository } from './services/DatabaseRepository.js';
import { MaintenanceService } from './services/MaintenanceService.js';

export * from './services/AuditLogger.js';
export * from './services/DatabaseRepository.js';
export * from './services/MaintenanceService.js';

// Register services in DI container
container.register(AuditLogger);
container.register(DatabaseRepository);
container.register(MaintenanceService);

export { container };
