/**
 * Types for Private Service-to-Service Bindings in @di-framework
 */

export interface ExportedOperationMetadata {
  name: string;
  description?: string;
}

export interface ServiceExportOptions {
  /**
   * The logical name of the exported service.
   * Target services are identified by this name.
   */
  name: string;

  /**
   * Operations exposed to bound callers.
   * If omitted, all public instance methods (or methods decorated with @ExportOperation) are exported.
   */
  operations?: string[];

  /**
   * Optional version of the service contract (e.g. '1.0.0').
   */
  version?: string;

  /**
   * Optional human-readable description of the service.
   */
  description?: string;

  /**
   * Whether caller authorization is enforced.
   * Defaults to true.
   */
  requiresAuthorization?: boolean;
}

export interface ServiceBindingOptions {
  /**
   * The identifier of the calling service (e.g. 'checkout').
   * If omitted, defaults to the caller's class name or current application service ID.
   */
  caller?: string;

  /**
   * Target service name. If omitted, maps to bindingName or configured deployment target.
   */
  target?: string;

  /**
   * Expected operations that the target must support.
   * Used for contract compatibility validation.
   */
  expectedOperations?: string[];

  /**
   * Whether this binding is strictly required. Defaults to true.
   */
  required?: boolean;

  /**
   * Timeout in milliseconds for invocations on this binding.
   */
  timeoutMs?: number;
}

export interface BindingGrant {
  /**
   * The caller service identifier granted access.
   * Can be '*' to grant access to all callers.
   */
  caller: string;

  /**
   * The target service name being accessed.
   */
  target: string;

  /**
   * Optional binding name used by the caller.
   */
  bindingName?: string;

  /**
   * Optional subset of operations granted to this caller.
   * If omitted, all exported operations are allowed.
   */
  allowedOperations?: string[];

  /**
   * Target environment (e.g., 'development', 'staging', 'production').
   */
  environment?: string;
}

export interface CallerBindingConfig {
  /**
   * Target service name.
   */
  target: string;

  /**
   * Optional restricted operations for this binding.
   */
  allowedOperations?: string[];

  /**
   * Optional mock or fake instance to substitute for this binding.
   */
  mock?: any;

  /**
   * Optional timeout override for this binding.
   */
  timeoutMs?: number;
}

export interface ServiceBindingConfiguration {
  /**
   * Identity of the current running service/application.
   */
  currentServiceId?: string;

  /**
   * Current deployment environment (e.g. 'development', 'production', 'test').
   */
  environment?: string;

  /**
   * Map of caller service ID to its named bindings configuration.
   * Example:
   * {
   *   checkout: {
   *     inventory: { target: 'inventory-service' }
   *   }
   * }
   */
  callers?: Record<string, Record<string, CallerBindingConfig>>;

  /**
   * Simplified bindings map for the current service.
   * Example: { inventory: { target: 'inventory-service' } }
   */
  bindings?: Record<string, CallerBindingConfig | string>;

  /**
   * Explicit authorization grants between callers and targets.
   */
  grants?: BindingGrant[];

  /**
   * Whether to enforce caller authorization locally (default: true).
   */
  enforceAuthorization?: boolean;
}

export interface InvocationContext {
  caller: string;
  bindingName: string;
  target: string;
  operation: string;
  args: any[];
  timestamp: number;
}

export interface ExportedServiceDefinition {
  name: string;
  instance: any;
  operations: Set<string>;
  version?: string;
  description?: string;
  requiresAuthorization: boolean;
  status: 'running' | 'stopped';
}

export type BindingStatusKind =
  | 'CONNECTED'
  | 'UNBOUND'
  | 'UNAVAILABLE'
  | 'INCOMPATIBLE'
  | 'MISSING_BINDING'
  | 'MOCKED';

export interface BindingStatusReport {
  caller: string;
  bindingName: string;
  target: string;
  status: BindingStatusKind;
  exportedOperations: string[];
  allowedOperations?: string[];
  expectedOperations?: string[];
  isMocked: boolean;
  diagnostics?: string;
}

export interface ServiceDiagnostic {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  caller?: string;
  bindingName?: string;
  target?: string;
  remediation?: string;
}
