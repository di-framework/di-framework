/**
 * Error classes for distributed actors, RPC dispatch, and ownership fencing.
 */

/**
 * Thrown when an obsolete or stale owner attempts to commit a transaction
 * whose generation is older than the authoritative storage generation.
 */
export class StaleOwnerWriteError extends Error {
  readonly actorId: string;
  readonly ownerGeneration: number;
  readonly storageGeneration: number;
  readonly currentOwnerId?: string;

  constructor(
    actorId: string,
    ownerGeneration: number,
    storageGeneration: number,
    currentOwnerId?: string,
  ) {
    super(
      `Stale owner write rejected for actor '${actorId}'. Owner generation ${ownerGeneration} is superseded by storage generation ${storageGeneration}${
        currentOwnerId ? ` (current owner: ${currentOwnerId})` : ''
      }.`,
    );
    this.name = 'StaleOwnerWriteError';
    this.actorId = actorId;
    this.ownerGeneration = ownerGeneration;
    this.storageGeneration = storageGeneration;
    this.currentOwnerId = currentOwnerId;
  }
}

/**
 * Thrown when an incoming RPC request violates authorization boundaries
 * (e.g. unauthorized namespace, actor type, or method).
 */
export class ActorAuthorizationError extends Error {
  readonly callerId?: string;
  readonly namespace?: string;
  readonly actorType: string;
  readonly method: string;
  readonly reason: string;

  constructor(
    actorType: string,
    method: string,
    reason: string,
    options?: { callerId?: string; namespace?: string },
  ) {
    super(
      `Authorization rejected for actor invocation '${actorType}.${method}'${
        options?.callerId ? ` by caller '${options.callerId}'` : ''
      }${options?.namespace ? ` in namespace '${options.namespace}'` : ''}: ${reason}`,
    );
    this.name = 'ActorAuthorizationError';
    this.actorType = actorType;
    this.method = method;
    this.reason = reason;
    this.callerId = options?.callerId;
    this.namespace = options?.namespace;
  }
}

/**
 * Thrown when an actor invocation deadline is exceeded before or during processing.
 */
export class ActorDeadlineExceededError extends Error {
  readonly actorId: string;
  readonly deadline: number;
  readonly requestId?: string;

  constructor(actorId: string, deadline: number, requestId?: string) {
    super(
      `Request deadline exceeded for actor '${actorId}' (deadline: ${deadline}, current: ${Date.now()}${
        requestId ? `, requestId: ${requestId}` : ''
      }).`,
    );
    this.name = 'ActorDeadlineExceededError';
    this.actorId = actorId;
    this.deadline = deadline;
    this.requestId = requestId;
  }
}

/**
 * Thrown when an actor mailbox reaches its bounded queue admission capacity.
 */
export class ActorBackpressureError extends Error {
  readonly actorId: string;
  readonly queueLength: number;
  readonly maxCapacity: number;

  constructor(actorId: string, queueLength: number, maxCapacity: number) {
    super(
      `Backpressure limit reached for actor '${actorId}'. Mailbox queue length (${queueLength}) exceeded maximum capacity of ${maxCapacity}.`,
    );
    this.name = 'ActorBackpressureError';
    this.actorId = actorId;
    this.queueLength = queueLength;
    this.maxCapacity = maxCapacity;
  }
}

/**
 * Thrown when competing activation attempts fail because the actor is currently
 * owned by another host with an active lease.
 */
export class ActorOwnershipConflictError extends Error {
  readonly actorId: string;
  readonly currentOwnerId: string;
  readonly currentGeneration: number;
  readonly leaseExpiresAt?: number | null;

  constructor(
    actorId: string,
    currentOwnerId: string,
    currentGeneration: number,
    leaseExpiresAt?: number | null,
  ) {
    super(
      `Activation conflict for actor '${actorId}'. Currently owned by host '${currentOwnerId}' at generation ${currentGeneration}${
        leaseExpiresAt ? ` until ${new Date(leaseExpiresAt).toISOString()}` : ''
      }.`,
    );
    this.name = 'ActorOwnershipConflictError';
    this.actorId = actorId;
    this.currentOwnerId = currentOwnerId;
    this.currentGeneration = currentGeneration;
    this.leaseExpiresAt = leaseExpiresAt;
  }
}

/**
 * Thrown when an invocation is routed to a node that does not own the actor.
 */
export class ActorNotOwnerError extends Error {
  readonly actorId: string;
  readonly currentOwnerId?: string;

  constructor(actorId: string, currentOwnerId?: string) {
    super(
      `Host is not the owner of actor '${actorId}'${
        currentOwnerId ? ` (current owner: ${currentOwnerId})` : ''
      }.`,
    );
    this.name = 'ActorNotOwnerError';
    this.actorId = actorId;
    this.currentOwnerId = currentOwnerId;
  }
}
