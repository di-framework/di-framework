/**
 * Actionable errors for private service-to-service bindings.
 */

export class ServiceBindingError extends Error {
  public readonly code: string;
  public readonly details: Record<string, unknown>;

  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a caller attempts to invoke a target service without an explicitly authorized binding.
 */
export class UnboundCallerError extends ServiceBindingError {
  public readonly caller: string;
  public readonly bindingName: string;
  public readonly target: string;

  constructor(caller: string, bindingName: string, target: string, extraMessage?: string) {
    const remediation = `Grant access in deployment configuration: add grant from caller '${caller}' to target '${target}'.`;
    const msg = `Unbound caller '${caller}' is not authorized to invoke service '${target}' through binding '${bindingName}'. ${extraMessage ? extraMessage + ' ' : ''}${remediation}`;
    super(msg, 'UNBOUND_CALLER', { caller, bindingName, target, remediation });
    this.caller = caller;
    this.bindingName = bindingName;
    this.target = target;
  }
}

/**
 * Thrown when a caller references a named binding dependency that is not configured in the environment.
 */
export class MissingBindingError extends ServiceBindingError {
  public readonly caller: string;
  public readonly bindingName: string;

  constructor(caller: string, bindingName: string) {
    const remediation = `Configure target mapping for binding '${bindingName}' on caller '${caller}' (e.g. in service-bindings configuration or DI_BINDINGS).`;
    const msg = `Missing service binding '${bindingName}' for caller '${caller}'. ${remediation}`;
    super(msg, 'MISSING_BINDING', { caller, bindingName, remediation });
    this.caller = caller;
    this.bindingName = bindingName;
  }
}

/**
 * Thrown when the target service of a binding is registered/configured but currently unavailable or not running.
 */
export class TargetUnavailableError extends ServiceBindingError {
  public readonly caller: string;
  public readonly bindingName: string;
  public readonly target: string;

  constructor(caller: string, bindingName: string, target: string, reason?: string) {
    const remediation = `Ensure target service '${target}' is running, registered with the service binding runtime, or available in the local mesh.`;
    const reasonText = reason ? ` (Reason: ${reason})` : '';
    const msg = `Target service '${target}' for binding '${bindingName}' (caller: '${caller}') is unavailable${reasonText}. ${remediation}`;
    super(msg, 'TARGET_UNAVAILABLE', { caller, bindingName, target, reason, remediation });
    this.caller = caller;
    this.bindingName = bindingName;
    this.target = target;
  }
}

/**
 * Thrown when the target service does not satisfy the caller's contract (e.g. missing operation).
 */
export class IncompatibleContractError extends ServiceBindingError {
  public readonly caller: string;
  public readonly bindingName: string;
  public readonly target: string;
  public readonly operation?: string;
  public readonly availableOperations: readonly string[];

  constructor(
    caller: string,
    bindingName: string,
    target: string,
    operation: string | undefined,
    availableOperations: readonly string[],
    missingOperations?: readonly string[],
  ) {
    let msg: string;
    let remediation: string;
    if (operation) {
      remediation = `Available operations on '${target}': [${availableOperations.join(', ')}]. Update caller code or export the required operation on the target.`;
      msg = `Incompatible contract on binding '${bindingName}': target service '${target}' does not export operation '${operation}'. ${remediation}`;
    } else if (missingOperations && missingOperations.length > 0) {
      remediation = `Missing required operations: [${missingOperations.join(', ')}]. Available on target: [${availableOperations.join(', ')}].`;
      msg = `Incompatible contract for binding '${bindingName}' on caller '${caller}': target service '${target}' is missing operations: [${missingOperations.join(', ')}]. ${remediation}`;
    } else {
      remediation = `Check contract compatibility between caller '${caller}' and target '${target}'.`;
      msg = `Incompatible contract between caller '${caller}' and target service '${target}' on binding '${bindingName}'. ${remediation}`;
    }
    super(msg, 'INCOMPATIBLE_CONTRACT', {
      caller,
      bindingName,
      target,
      operation,
      availableOperations,
      missingOperations,
      remediation,
    });
    this.caller = caller;
    this.bindingName = bindingName;
    this.target = target;
    this.operation = operation;
    this.availableOperations = availableOperations;
  }
}

/**
 * Thrown when a caller is authorized for a target service, but restricted from calling a specific operation.
 */
export class UnauthorizedOperationError extends ServiceBindingError {
  public readonly caller: string;
  public readonly bindingName: string;
  public readonly target: string;
  public readonly operation: string;
  public readonly allowedOperations: readonly string[];

  constructor(
    caller: string,
    bindingName: string,
    target: string,
    operation: string,
    allowedOperations: readonly string[],
  ) {
    const remediation = `Authorized operations for caller '${caller}' on '${target}': [${allowedOperations.join(', ')}]. Update grant permissions in configuration.`;
    const msg = `Operation '${operation}' is not permitted for caller '${caller}' on binding '${bindingName}' (target: '${target}'). ${remediation}`;
    super(msg, 'UNAUTHORIZED_OPERATION', {
      caller,
      bindingName,
      target,
      operation,
      allowedOperations,
      remediation,
    });
    this.caller = caller;
    this.bindingName = bindingName;
    this.target = target;
    this.operation = operation;
    this.allowedOperations = allowedOperations;
  }
}
