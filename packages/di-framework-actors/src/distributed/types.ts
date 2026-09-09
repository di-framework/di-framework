/**
 * Types for distributed actor invocation, RPC dispatch, and ownership protocols.
 */

export interface ActorRpcRequest<TArgs = any[]> {
  /**
   * Unique client-generated identifier for this request.
   * Used for deduplication and idempotency caching.
   */
  requestId: string;

  /**
   * Application namespace partitioning the actor (e.g. 'tenant-a', 'billing').
   */
  namespace?: string;

  /**
   * Actor type or registered class name.
   */
  actorType: string;

  /**
   * Unique instance key for the actor.
   */
  actorKey: string;

  /**
   * Method name to invoke on the actor.
   */
  method: string;

  /**
   * Method arguments array.
   */
  args: TArgs;

  /**
   * Identity of the caller or client service.
   */
  callerId?: string;

  /**
   * Epoch timestamp in ms after which the request is considered expired.
   */
  deadline?: number;

  /**
   * Expected or known generation fencing token of the target actor.
   */
  expectedGeneration?: number;

  /**
   * Optional custom transport metadata / headers.
   */
  headers?: Record<string, string>;
}

export interface ActorRpcResponseError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  staleOwner?: boolean;
  ownerGeneration?: number;
  storageGeneration?: number;
}

export interface ActorRpcResponse<TResult = any> {
  /**
   * Request ID matching the corresponding ActorRpcRequest.
   */
  requestId: string;

  /**
   * Whether the invocation succeeded.
   */
  success: boolean;

  /**
   * Result returned by the actor method on success.
   */
  result?: TResult;

  /**
   * Error details on failure.
   */
  error?: ActorRpcResponseError;

  /**
   * Current ownership generation / fencing token when the invocation completed.
   */
  generation?: number;

  /**
   * Indicates if this response was served from the idempotency cache
   * rather than executing a new invocation.
   */
  cached?: boolean;
}

export interface ActorOwnershipRecord {
  /**
   * Composite identity: `${namespace}:${actorType}:${actorKey}` or `${actorType}:${actorKey}`.
   */
  actorId: string;

  /**
   * Host or node ID currently holding ownership.
   */
  ownerId: string;

  /**
   * Monotonically increasing generation number (fencing token).
   */
  generation: number;

  /**
   * Epoch timestamp in ms when ownership was acquired or last renewed.
   */
  acquiredAt: number;

  /**
   * Optional epoch timestamp in ms when the lease expires.
   */
  leaseExpiresAt?: number | null;
}

export interface IdempotencyRecord {
  requestId: string;
  actorId: string;
  response: ActorRpcResponse;
  createdAt: number;
}

export interface ActorAuthorizationPolicy {
  /**
   * Authorizes an incoming RPC request.
   * Returns true to allow, false or throws ActorAuthorizationError to reject.
   */
  authorize(request: ActorRpcRequest): boolean | Promise<boolean>;
}

export interface ActorBindingRules {
  /**
   * Whitelisted application namespaces. If undefined, all namespaces are allowed.
   */
  allowedNamespaces?: string[];

  /**
   * Whitelisted actor types. If undefined, all actor types are allowed.
   */
  allowedActorTypes?: string[];

  /**
   * Whitelisted methods per actor type: { ActorType: ['methodA', 'methodB'] }.
   * If an actor type is not listed or undefined, all methods are allowed.
   */
  allowedMethods?: Record<string, string[]>;

  /**
   * Whitelisted caller IDs. If undefined, all callers are allowed.
   */
  allowedCallers?: string[];
}

export interface InvokeOptions {
  /**
   * Request identity for idempotency deduplication.
   */
  requestId?: string;

  /**
   * Identity of the caller.
   */
  callerId?: string;

  /**
   * Application namespace.
   */
  namespace?: string;

  /**
   * Epoch timestamp in ms after which the request is dropped.
   */
  deadline?: number;

  /**
   * Generation token to enforce for this invocation.
   */
  generation?: number;
}

export interface ActorTransport {
  /**
   * Sends an ActorRpcRequest to the target actor host and awaits the response.
   */
  send(request: ActorRpcRequest): Promise<ActorRpcResponse>;
}

export interface RemoteRefOptions {
  /**
   * Custom caller ID to include in outgoing requests.
   */
  callerId?: string;

  /**
   * Application namespace for this actor instance.
   */
  namespace?: string;

  /**
   * Timeout in ms for remote calls. Defaults to 30000 ms.
   */
  timeoutMs?: number;

  /**
   * Maximum number of retry attempts for network/transport failures or timeouts.
   * Defaults to 3.
   */
  maxRetries?: number;

  /**
   * Initial delay between retries in ms. Defaults to 50 ms.
   */
  retryDelayMs?: number;
}
