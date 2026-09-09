import type { BindingGrant, CallerBindingConfig, ExportedServiceDefinition } from './types.js';

export class ServiceBindingRegistry {
  private services = new Map<string, ExportedServiceDefinition>();
  private callerBindings = new Map<string, Map<string, CallerBindingConfig>>();
  private grants = new Map<string, BindingGrant>();
  private mocks = new Map<string, any>();
  private callerMocks = new Map<string, Map<string, any>>();

  /**
   * Register an exported service.
   */
  public registerService(service: ExportedServiceDefinition): void {
    this.services.set(service.name, service);
  }

  /**
   * Unregister an exported service.
   */
  public unregisterService(name: string): boolean {
    return this.services.delete(name);
  }

  /**
   * Retrieve an exported service by name.
   */
  public getService(name: string): ExportedServiceDefinition | undefined {
    return this.services.get(name);
  }

  /**
   * Check if an exported service is registered.
   */
  public hasService(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Update service runtime status (e.g. running or stopped).
   */
  public setServiceStatus(name: string, status: 'running' | 'stopped'): void {
    const service = this.services.get(name);
    if (service) {
      service.status = status;
    }
  }

  /**
   * Map a caller's named binding to a target service.
   */
  public setCallerBinding(caller: string, bindingName: string, config: CallerBindingConfig): void {
    if (!this.callerBindings.has(caller)) {
      this.callerBindings.set(caller, new Map());
    }
    this.callerBindings.get(caller)!.set(bindingName, config);
  }

  /**
   * Retrieve a caller's named binding configuration.
   */
  public getCallerBinding(caller: string, bindingName: string): CallerBindingConfig | undefined {
    return this.callerBindings.get(caller)?.get(bindingName);
  }

  /**
   * Add an authorization grant from caller to target.
   */
  public addGrant(grant: BindingGrant): void {
    const key = `${grant.caller}->${grant.target}`;
    this.grants.set(key, grant);
  }

  /**
   * Remove an authorization grant.
   */
  public removeGrant(caller: string, target: string): boolean {
    const key = `${caller}->${target}`;
    return this.grants.delete(key);
  }

  /**
   * Check if a caller is authorized to invoke a target service.
   */
  public isCallerAuthorized(caller: string, target: string): boolean {
    const targetService = this.services.get(target);
    if (targetService && !targetService.requiresAuthorization) {
      return true;
    }
    const directKey = `${caller}->${target}`;
    const wildcardKey = `*->${target}`;
    return this.grants.has(directKey) || this.grants.has(wildcardKey);
  }

  /**
   * Check if a caller is authorized to invoke a target service and specific operation.
   */
  public isAuthorized(caller: string, target: string, operation?: string): boolean {
    if (!this.isCallerAuthorized(caller, target)) {
      return false;
    }
    if (operation) {
      const allowed = this.getAllowedOperations(caller, target);
      if (allowed && allowed.length > 0) {
        return allowed.includes(operation);
      }
    }
    return true;
  }

  /**
   * Get list of allowed operations for caller on target.
   */
  public getAllowedOperations(caller: string, target: string): string[] | undefined {
    const directKey = `${caller}->${target}`;
    const wildcardKey = `*->${target}`;
    const grant = this.grants.get(directKey) ?? this.grants.get(wildcardKey);
    return grant?.allowedOperations;
  }

  /**
   * Explicitly substitute a bound service with a mock instance.
   */
  public registerMock(bindingName: string, mock: any, caller?: string): void {
    if (caller) {
      if (!this.callerMocks.has(caller)) {
        this.callerMocks.set(caller, new Map());
      }
      this.callerMocks.get(caller)!.set(bindingName, mock);
    } else {
      this.mocks.set(bindingName, mock);
    }
  }

  /**
   * Retrieve registered mock for binding.
   */
  public getMock(bindingName: string, caller?: string): any | undefined {
    if (caller && this.callerMocks.has(caller)) {
      const callerMock = this.callerMocks.get(caller)!.get(bindingName);
      if (callerMock !== undefined) return callerMock;
    }
    return this.mocks.get(bindingName);
  }

  /**
   * Remove mock substitution.
   */
  public removeMock(bindingName: string, caller?: string): void {
    if (caller && this.callerMocks.has(caller)) {
      this.callerMocks.get(caller)!.delete(bindingName);
    }
    this.mocks.delete(bindingName);
  }

  /**
   * Clear all registered mocks.
   */
  public clearMocks(): void {
    this.mocks.clear();
    this.callerMocks.clear();
  }

  /**
   * Return all registered services.
   */
  public getAllServices(): ExportedServiceDefinition[] {
    return Array.from(this.services.values());
  }

  /**
   * Return all authorization grants.
   */
  public getAllGrants(): BindingGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * Return all caller binding mappings.
   */
  public getAllBindings(): Array<{
    caller: string;
    bindingName: string;
    config: CallerBindingConfig;
  }> {
    const list: Array<{ caller: string; bindingName: string; config: CallerBindingConfig }> = [];
    this.callerBindings.forEach((bindingsMap, caller) => {
      bindingsMap.forEach((config, bindingName) => {
        list.push({ caller, bindingName, config });
      });
    });
    return list;
  }

  /**
   * Reset the entire registry.
   */
  public clear(): void {
    this.services.clear();
    this.callerBindings.clear();
    this.grants.clear();
    this.clearMocks();
  }
}
