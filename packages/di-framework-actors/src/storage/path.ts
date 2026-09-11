/**
 * Safe mapping and validation between actor identity and storage paths.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '_') start++;
  while (end > start && value[end - 1] === '_') end--;
  return value.slice(start, end);
}

export interface ActorIdentity {
  namespace?: string;
  actorName: string;
  actorKey: string;
}

/**
 * Thrown when two distinct actor identities resolve to the same database file,
 * or when an existing database's stored identity does not match the opener.
 */
export class ActorIdentityCollisionError extends Error {
  readonly requestedId: string;
  readonly storedId: string;
  readonly filePath: string;

  constructor(requestedId: string, storedId: string, filePath: string) {
    super(
      `Actor identity collision: database at '${filePath}' belongs to '${storedId}', not '${requestedId}'.`,
    );
    this.name = 'ActorIdentityCollisionError';
    this.requestedId = requestedId;
    this.storedId = storedId;
    this.filePath = filePath;
  }
}

/** Stable fingerprint of an identity; NUL-separated so fields cannot alias. */
export function canonicalActorIdentity(identity: ActorIdentity): string {
  return `${identity.namespace ?? ''}\0${identity.actorName}\0${identity.actorKey}`;
}

export function assertStoredActorIdentity(
  storedId: string | null | undefined,
  requestedId: string,
  filePath: string,
): void {
  if (storedId != null && storedId !== requestedId) {
    throw new ActorIdentityCollisionError(requestedId, storedId, filePath);
  }
}

/**
 * Parses a composite string ID or ActorIdentity object into structured ActorIdentity.
 */
export function parseActorIdentity(input: string | ActorIdentity): ActorIdentity {
  if (typeof input === 'object' && input !== null) {
    return {
      namespace: input.namespace,
      actorName: input.actorName,
      actorKey: input.actorKey ?? '',
    };
  }

  const parts = String(input).split(':');
  if (parts.length === 1) {
    return {
      actorName: parts[0] ?? '',
      actorKey: '',
    };
  }

  if (parts.length === 2) {
    return {
      actorName: parts[0] ?? '',
      actorKey: parts[1] ?? '',
    };
  }

  // 3 or more parts: [namespace, actorName, ...actorKey]
  return {
    namespace: parts[0],
    actorName: parts[1] ?? '',
    actorKey: parts.slice(2).join(':'),
  };
}

export interface PathMappingOptions {
  baseDir?: string;
  inMemory?: boolean;
}

/**
 * Maps an actor identity safely to a filesystem path or shared memory SQLite URI.
 * Guarantees that the resulting path is strictly contained within baseDir and cannot
 * escape via directory traversal or invalid filesystem characters.
 */
export function actorIdentityToPath(
  identityInput: string | ActorIdentity,
  options: PathMappingOptions = {},
): string {
  const identity = parseActorIdentity(identityInput);
  const inMemory = options.inMemory === true || options.baseDir === ':memory:';

  // Sanitize namespace and actor name: allow only alphanumeric, underscores, dashes
  const safeNamespace =
    trimUnderscores((identity.namespace || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')) || 'default';

  const safeActorName =
    trimUnderscores(identity.actorName.replace(/[^a-zA-Z0-9_-]/g, '_')) || 'actor';

  // Hash the full identity so sanitized namespace/name collisions cannot share a file.
  const identityHash = createHash('sha256')
    .update(canonicalActorIdentity(identity))
    .digest('hex');
  const hashPrefix = identityHash.slice(0, 32);

  // In-memory mode: return a dedicated shared memory URI
  if (inMemory) {
    return `file:actor_${safeNamespace}_${safeActorName}_${hashPrefix}?mode=memory&cache=shared`;
  }

  const baseDir = options.baseDir ?? '.actors';
  const resolvedBase = path.resolve(baseDir);

  // Human-readable sanitized prefix (up to 32 chars) for ease of disk inspection
  const safePrefix = identity.actorKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const fileName = safePrefix ? `${safePrefix}_${hashPrefix}.db` : `${hashPrefix}.db`;

  const targetPath = path.resolve(resolvedBase, safeNamespace, safeActorName, fileName);

  // Path traversal guard: verify that target path is strictly inside baseDir
  const relativePath = path.relative(resolvedBase, targetPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Security violation: Path traversal attempt detected for actor '${identity.actorName}:${identity.actorKey}'.`,
    );
  }

  return targetPath;
}
