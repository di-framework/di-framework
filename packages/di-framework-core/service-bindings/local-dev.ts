import { ServiceBindingRuntime } from './runtime.js';
import type { BindingStatusReport, ServiceDiagnostic, ServiceExportOptions } from './types.js';

export interface LocalDevServiceRegistration {
  name: string;
  instance: any;
  options: ServiceExportOptions;
}

/**
 * Local development coordinator for running and testing multiple bound services
 * without deploying them or exposing public network endpoints.
 */
export class LocalServiceDevManager {
  public readonly runtime: ServiceBindingRuntime;

  constructor(runtime?: ServiceBindingRuntime) {
    this.runtime = runtime ?? ServiceBindingRuntime.current;
    this.runtime.setEnvironment('development');
  }

  /**
   * Register a local service in the dev mesh.
   */
  public registerService(
    name: string,
    classOrInstance: any,
    options: Partial<ServiceExportOptions> = {},
  ): this {
    const fullOptions: ServiceExportOptions = {
      name,
      operations: options.operations,
      version: options.version ?? 'local-dev',
      description: options.description,
      requiresAuthorization: options.requiresAuthorization ?? true,
    };
    this.runtime.registerExportedService(classOrInstance, fullOptions);
    return this;
  }

  /**
   * Bind a caller service's named dependency to a target service in local development.
   * By default, automatically creates an authorized grant unless grantAccess is set to false.
   */
  public bind(
    caller: string,
    bindingName: string,
    target: string,
    options: {
      allowedOperations?: string[];
      grantAccess?: boolean;
      mock?: any;
    } = {},
  ): this {
    this.runtime.registry.setCallerBinding(caller, bindingName, {
      target,
      allowedOperations: options.allowedOperations,
      mock: options.mock,
    });

    if (options.grantAccess !== false) {
      this.grant(caller, target, options.allowedOperations);
    }
    return this;
  }

  /**
   * Explicitly grant access from a caller to a target service.
   */
  public grant(caller: string, target: string, allowedOperations?: string[]): this {
    this.runtime.registry.addGrant({
      caller,
      target,
      allowedOperations,
      environment: 'development',
    });
    return this;
  }

  /**
   * Revoke access from a caller to a target service (to test unbound caller rejection).
   */
  public revoke(caller: string, target: string): this {
    this.runtime.registry.removeGrant(caller, target);
    return this;
  }

  /**
   * Stop a running service (to test unavailable target error handling).
   */
  public stopService(name: string): this {
    this.runtime.registry.setServiceStatus(name, 'stopped');
    return this;
  }

  /**
   * Start a stopped service.
   */
  public startService(name: string): this {
    this.runtime.registry.setServiceStatus(name, 'running');
    return this;
  }

  /**
   * Reload a service implementation with a new version without restarting callers.
   */
  public reloadService(
    name: string,
    newClassOrInstance: any,
    options: Partial<ServiceExportOptions> = {},
  ): this {
    this.registerService(name, newClassOrInstance, options);
    return this;
  }

  /**
   * Explicitly substitute a mock for isolated unit testing.
   */
  public substituteMock(bindingName: string, mock: any, caller?: string): this {
    this.runtime.substituteMock(bindingName, mock, caller);
    return this;
  }

  /**
   * Remove all mocks.
   */
  public clearMocks(): this {
    this.runtime.clearMocks();
    return this;
  }

  /**
   * Retrieve the current binding status report across all local services.
   */
  public getStatus(): BindingStatusReport[] {
    return this.runtime.getStatus();
  }

  /**
   * Run diagnostics and return actionable findings.
   */
  public diagnose(): ServiceDiagnostic[] {
    return this.runtime.diagnose();
  }

  /**
   * Render a human-readable table summarizing local service binding statuses.
   */
  public formatStatusTable(): string {
    const reports = this.getStatus();
    if (reports.length === 0) {
      return 'No active service bindings registered.';
    }

    const lines: string[] = [
      'Local Service Bindings Status:',
      '---------------------------------------------------------------------------------',
      'Caller               Binding         Target          Status       Operations',
      '---------------------------------------------------------------------------------',
    ];

    for (const r of reports) {
      const caller = r.caller.padEnd(20).slice(0, 20);
      const binding = r.bindingName.padEnd(15).slice(0, 15);
      const target = r.target.padEnd(15).slice(0, 15);
      const status = r.status.padEnd(12).slice(0, 12);
      const ops = r.exportedOperations.join(', ');
      lines.push(`${caller} ${binding} ${target} ${status} ${ops}`);
      if (r.diagnostics) {
        lines.push(`  ↳ [Diag] ${r.diagnostics}`);
      }
    }

    lines.push('---------------------------------------------------------------------------------');
    return lines.join('\n');
  }

  /**
   * Reset the local development mesh.
   */
  public reset(): void {
    this.runtime.registry.clear();
  }
}
