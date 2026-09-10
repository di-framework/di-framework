import { useContainer } from '../container';
import {
  IncompatibleContractError,
  MissingBindingError,
  TargetUnavailableError,
  UnauthorizedOperationError,
  UnboundCallerError,
} from './errors';
import { serviceBindingToken } from './proxy';
import { ServiceBindingRegistry } from './registry';
import type {
  BindingStatusReport,
  CallerBindingConfig,
  ExportedServiceDefinition,
  ServiceBindingConfiguration,
  ServiceDiagnostic,
  ServiceExportOptions,
} from './types';

export class ServiceBindingRuntime {
  private static instance: ServiceBindingRuntime | undefined;

  public readonly registry: ServiceBindingRegistry;
  private currentServiceId: string;
  private environment: string;
  private enforceAuthorization: boolean = true;
  private enforceAuthorizationOnMocks: boolean = false;

  constructor(registry?: ServiceBindingRegistry) {
    this.registry = registry ?? new ServiceBindingRegistry();
    this.currentServiceId = process.env.DI_SERVICE_ID ?? 'default-service';
    this.environment = process.env.DI_SERVICE_ENV ?? process.env.NODE_ENV ?? 'development';
    this.loadFromEnvironment();
  }

  public static get current(): ServiceBindingRuntime {
    if (!ServiceBindingRuntime.instance) {
      ServiceBindingRuntime.instance = new ServiceBindingRuntime();
    }
    return ServiceBindingRuntime.instance;
  }

  public static reset(): void {
    if (ServiceBindingRuntime.instance) {
      ServiceBindingRuntime.instance.registry.clear();
      ServiceBindingRuntime.instance = undefined;
    }
  }

  public setCurrentServiceId(id: string): void {
    this.currentServiceId = id;
  }

  public getCurrentServiceId(): string {
    return this.currentServiceId;
  }

  public setEnvironment(env: string): void {
    this.environment = env;
  }

  public getEnvironment(): string {
    return this.environment;
  }

  public setEnforceAuthorization(enforce: boolean): void {
    this.enforceAuthorization = enforce;
  }

  public setEnforceAuthorizationOnMocks(enforce: boolean): void {
    this.enforceAuthorizationOnMocks = enforce;
  }

  /**
   * Load service bindings and grants from configuration.
   */
  public configure(config: ServiceBindingConfiguration): this {
    if (config.currentServiceId) {
      this.currentServiceId = config.currentServiceId;
    }
    if (config.environment) {
      this.environment = config.environment;
    }
    if (config.enforceAuthorization !== undefined) {
      this.enforceAuthorization = config.enforceAuthorization;
    }

    // Configure caller-specific bindings
    if (config.callers) {
      for (const [caller, bindings] of Object.entries(config.callers)) {
        for (const [bindingName, bindingConfig] of Object.entries(bindings)) {
          this.registry.setCallerBinding(caller, bindingName, bindingConfig);
          if (bindingConfig.mock !== undefined) {
            this.registry.registerMock(bindingName, bindingConfig.mock, caller);
          }
        }
      }
    }

    // Configure bindings for current service
    if (config.bindings) {
      for (const [bindingName, entry] of Object.entries(config.bindings)) {
        const callerConfig: CallerBindingConfig =
          typeof entry === 'string' ? { target: entry } : entry;
        this.registry.setCallerBinding(this.currentServiceId, bindingName, callerConfig);
        if (typeof entry !== 'string' && entry.mock !== undefined) {
          this.registry.registerMock(bindingName, entry.mock, this.currentServiceId);
        }
      }
    }

    // Configure grants
    if (config.grants) {
      for (const grant of config.grants) {
        if (!grant.environment || grant.environment === this.environment) {
          this.registry.addGrant(grant);
        }
      }
    }

    return this;
  }

  /**
   * Register an exported service implementation.
   */
  public registerExportedService(
    targetClassOrInstance: any,
    options: ServiceExportOptions,
  ): ExportedServiceDefinition {
    const isClass = typeof targetClassOrInstance === 'function';
    const instance = isClass ? targetClassOrInstance.prototype : targetClassOrInstance;

    // Discover operations
    const operations = new Set<string>();
    if (options.operations && options.operations.length > 0) {
      for (const op of options.operations) {
        operations.add(op);
      }
    } else {
      // Auto-discover prototype methods
      const proto = isClass ? instance : Object.getPrototypeOf(instance);
      if (proto) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (name !== 'constructor' && typeof (instance as any)[name] === 'function') {
            operations.add(name);
          }
        }
      }
      // Also discover own properties that are functions
      for (const name of Object.getOwnPropertyNames(instance)) {
        if (name !== 'constructor' && typeof (instance as any)[name] === 'function') {
          operations.add(name);
        }
      }
    }

    const definition: ExportedServiceDefinition = {
      name: options.name,
      get instance() {
        if (!isClass) return instance;
        const container = useContainer();
        if (!container.has(targetClassOrInstance)) container.register(targetClassOrInstance);
        return container.resolve(targetClassOrInstance);
      },
      operations,
      version: options.version,
      description: options.description,
      requiresAuthorization: options.requiresAuthorization ?? true,
      status: 'running',
    };

    this.registry.registerService(definition);
    return definition;
  }

  /**
   * Invoke an exported operation on a target service through a named binding.
   */
  public async invoke<T = any>(
    caller: string,
    bindingName: string,
    operation: string,
    args: any[] = [],
    explicitTarget?: string,
  ): Promise<T> {
    const effectiveCaller = caller || this.currentServiceId;

    // 1. Resolve target mapping
    const callerConfig = this.registry.getCallerBinding(effectiveCaller, bindingName);
    let mock = this.registry.getMock(bindingName, effectiveCaller);
    if (mock === undefined) {
      try {
        const container = useContainer();
        const callerToken = serviceBindingToken(bindingName, effectiveCaller);
        const globalToken = serviceBindingToken(bindingName);
        if (container.has(callerToken)) {
          const resolved = container.resolve(callerToken);
          if (resolved && !(resolved as any).$bindingMeta) {
            mock = resolved;
          }
        }
        if (mock === undefined && container.has(globalToken)) {
          const resolved = container.resolve(globalToken);
          if (resolved && !(resolved as any).$bindingMeta) {
            mock = resolved;
          }
        }
      } catch {
        // ignore resolution error
      }
    }

    const targetName = explicitTarget ?? callerConfig?.target ?? bindingName;

    // 2. If mock is registered
    if (mock !== undefined) {
      // If enforcing authorization on mocks, ensure caller has access
      if (this.enforceAuthorization && this.enforceAuthorizationOnMocks) {
        const isCallerAuth = this.registry.isCallerAuthorized(effectiveCaller, targetName);
        if (!isCallerAuth) {
          throw new UnboundCallerError(
            effectiveCaller,
            bindingName,
            targetName,
            '(Access check failed before mock substitution)',
          );
        }
      }

      if (typeof mock[operation] !== 'function') {
        throw new IncompatibleContractError(
          effectiveCaller,
          bindingName,
          targetName,
          operation,
          Object.keys(mock).filter((k) => typeof mock[k] === 'function'),
        );
      }
      return await mock[operation](...args);
    }

    // If no mock and no configured target found in registry
    if (!callerConfig && !explicitTarget && !this.registry.hasService(targetName)) {
      throw new MissingBindingError(effectiveCaller, bindingName);
    }

    // 3. Authorization check
    if (this.enforceAuthorization) {
      const isCallerAuth = this.registry.isCallerAuthorized(effectiveCaller, targetName);
      if (!isCallerAuth) {
        throw new UnboundCallerError(effectiveCaller, bindingName, targetName);
      }
    }

    // 4. Target availability check
    const targetService = this.registry.getService(targetName);
    if (!targetService || targetService.status !== 'running') {
      const reason = !targetService ? 'Service is not registered' : 'Service is currently stopped';
      throw new TargetUnavailableError(effectiveCaller, bindingName, targetName, reason);
    }

    // 5. Contract compatibility check
    if (!targetService.operations.has(operation)) {
      throw new IncompatibleContractError(
        effectiveCaller,
        bindingName,
        targetName,
        operation,
        Array.from(targetService.operations),
      );
    }

    // 6. Check restricted allowedOperations on grant
    const allowed = this.registry.getAllowedOperations(effectiveCaller, targetName);
    if (allowed && allowed.length > 0 && !allowed.includes(operation)) {
      throw new UnauthorizedOperationError(
        effectiveCaller,
        bindingName,
        targetName,
        operation,
        allowed,
      );
    }

    // 7. Invoke target operation
    const targetInstance = targetService.instance;
    const method = targetInstance[operation];
    if (typeof method !== 'function') {
      throw new IncompatibleContractError(
        effectiveCaller,
        bindingName,
        targetName,
        operation,
        Array.from(targetService.operations),
      );
    }

    return await method.apply(targetInstance, args);
  }

  /**
   * Substitute a mock for a named binding.
   */
  public substituteMock(bindingName: string, mock: any, caller?: string): void {
    this.registry.registerMock(bindingName, mock, caller);
  }

  /**
   * Clear all mocks.
   */
  public clearMocks(): void {
    this.registry.clearMocks();
  }

  /**
   * Get binding status report across all configured bindings.
   */
  public getStatus(): BindingStatusReport[] {
    const reports: BindingStatusReport[] = [];
    const allBindings = this.registry.getAllBindings();

    for (const { caller, bindingName, config } of allBindings) {
      const target = config.target;
      const targetService = this.registry.getService(target);
      const isMocked = this.registry.getMock(bindingName, caller) !== undefined;
      const isAuth = this.registry.isAuthorized(caller, target);

      let status: BindingStatusReport['status'];
      let diagnostics: string | undefined;

      if (isMocked) {
        status = 'MOCKED';
        diagnostics = 'Substituted with local test mock';
      } else if (!isAuth && this.enforceAuthorization) {
        status = 'UNBOUND';
        diagnostics = `Caller '${caller}' is not authorized to invoke '${target}'`;
      } else if (!targetService || targetService.status !== 'running') {
        status = 'UNAVAILABLE';
        diagnostics = `Target service '${target}' is not registered or running`;
      } else {
        status = 'CONNECTED';
      }

      reports.push({
        caller,
        bindingName,
        target,
        status,
        exportedOperations: targetService ? Array.from(targetService.operations) : [],
        allowedOperations: config.allowedOperations,
        isMocked,
        diagnostics,
      });
    }

    return reports;
  }

  /**
   * Diagnose binding configuration issues.
   */
  public diagnose(): ServiceDiagnostic[] {
    const diagnostics: ServiceDiagnostic[] = [];
    const statusList = this.getStatus();

    for (const report of statusList) {
      if (report.status === 'UNBOUND') {
        diagnostics.push({
          level: 'error',
          code: 'UNBOUND_CALLER',
          caller: report.caller,
          bindingName: report.bindingName,
          target: report.target,
          message: `Caller '${report.caller}' has no authorized grant for '${report.target}'.`,
          remediation: `Add authorization grant: { caller: '${report.caller}', target: '${report.target}' }`,
        });
      } else if (report.status === 'UNAVAILABLE') {
        diagnostics.push({
          level: 'error',
          code: 'TARGET_UNAVAILABLE',
          caller: report.caller,
          bindingName: report.bindingName,
          target: report.target,
          message: `Target service '${report.target}' is unavailable.`,
          remediation: `Ensure '${report.target}' is running and registered before invoking binding '${report.bindingName}'.`,
        });
      }
    }

    return diagnostics;
  }

  private loadFromEnvironment(): void {
    // Parse DI_BINDINGS JSON if available
    if (process.env.DI_BINDINGS) {
      try {
        const parsed = JSON.parse(process.env.DI_BINDINGS);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [bindingName, val] of Object.entries(parsed)) {
            const config: CallerBindingConfig =
              typeof val === 'string' ? { target: val } : (val as CallerBindingConfig);
            this.registry.setCallerBinding(this.currentServiceId, bindingName, config);
          }
        }
      } catch (e) {
        console.warn('Failed to parse DI_BINDINGS environment variable:', e);
      }
    }

    // Parse DI_SERVICE_GRANTS JSON if available
    if (process.env.DI_SERVICE_GRANTS) {
      try {
        const parsed = JSON.parse(process.env.DI_SERVICE_GRANTS);
        if (Array.isArray(parsed)) {
          for (const grant of parsed) {
            if (!grant.environment || grant.environment === this.environment) {
              this.registry.addGrant(grant);
            }
          }
        }
      } catch (e) {
        console.warn('Failed to parse DI_SERVICE_GRANTS environment variable:', e);
      }
    }
  }
}

export function useServiceBindingRuntime(): ServiceBindingRuntime {
  return ServiceBindingRuntime.current;
}
