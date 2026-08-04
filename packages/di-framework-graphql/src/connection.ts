/**
 * Relay cursor connections.
 *
 * The connection, edge and `PageInfo` types are generated from the domain field
 * that returns them, so pagination does not force a parallel hierarchy of
 * hand-written connection classes alongside the entities.
 *
 * A field declared with `@Connection` may return a plain array — the common
 * case, sliced here — or an already-shaped {@link Connection} when the data
 * source paginates natively.
 */

/** Opaque, base64 cursor prefix used for offset-based slicing of an array. */
const ARRAY_CURSOR_PREFIX = 'arrayconnection:';

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode an opaque cursor. Cursors are base64 so clients treat them as opaque. */
export function encodeCursor(value: string | number): string {
  return toBase64(String(value));
}

/** Decode a cursor produced by {@link encodeCursor}. */
export function decodeCursor(cursor: string): string {
  try {
    return fromBase64(cursor);
  } catch {
    throw new Error('Invalid cursor.');
  }
}

/** Cursor for the item at `index` of an array-backed connection. */
export function offsetToCursor(index: number): string {
  return encodeCursor(`${ARRAY_CURSOR_PREFIX}${index}`);
}

/** Index encoded by {@link offsetToCursor}, or `-1` when it is not one. */
export function cursorToOffset(cursor: string): number {
  const decoded = decodeCursor(cursor);
  if (!decoded.startsWith(ARRAY_CURSOR_PREFIX)) return -1;
  const offset = Number.parseInt(decoded.slice(ARRAY_CURSOR_PREFIX.length), 10);
  return Number.isNaN(offset) ? -1 : offset;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Edge<T> {
  node: T;
  cursor: string;
}

export interface Connection<T> {
  edges: Array<Edge<T>>;
  pageInfo: PageInfo;
  /** Size of the full result set, before slicing. */
  totalCount: number | null;
}

/** The four Relay pagination arguments. */
export interface ConnectionArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

/** True when a value already has connection shape and should pass through. */
export function isConnection(value: unknown): value is Connection<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Connection<unknown>).edges) &&
    typeof (value as Connection<unknown>).pageInfo === 'object'
  );
}

/**
 * Slice an in-memory array the way the Relay connection spec describes:
 * `after`/`before` narrow the window, then `first`/`last` trim it.
 *
 * `hasNextPage` and `hasPreviousPage` are reported against the *whole* set
 * rather than the direction being paged. The spec permits either, and always
 * answering the question a client actually asks — "is there more on this side?"
 * — beats returning a spec-legal `false` while paging forward.
 */
export function connectionFromArray<T>(
  items: readonly T[],
  args: ConnectionArgs = {},
): Connection<T> {
  const total = items.length;

  let start = 0;
  let end = total;

  if (typeof args.after === 'string') {
    const offset = cursorToOffset(args.after);
    if (offset >= 0) start = Math.max(start, Math.min(offset + 1, total));
  }
  if (typeof args.before === 'string') {
    const offset = cursorToOffset(args.before);
    if (offset >= 0) end = Math.min(end, Math.max(offset, 0));
  }
  if (end < start) end = start;

  if (typeof args.first === 'number') {
    if (args.first < 0) throw new Error('Argument "first" must not be negative.');
    end = Math.min(end, start + args.first);
  }
  if (typeof args.last === 'number') {
    if (args.last < 0) throw new Error('Argument "last" must not be negative.');
    start = Math.max(start, end - args.last);
  }

  const edges = items.slice(start, end).map((node, index) => ({
    node,
    cursor: offsetToCursor(start + index),
  }));

  return {
    edges,
    totalCount: total,
    pageInfo: {
      hasNextPage: end < total,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  };
}

/**
 * Build a connection from a page the data source already sliced.
 *
 * Use when the repository does the paging: supply the page, whether more exists
 * on either side, and how to derive each node's cursor.
 */
export function connectionFromSlice<T>(
  nodes: readonly T[],
  options: {
    cursorFor: (node: T, index: number) => string | number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
    totalCount?: number | null;
  },
): Connection<T> {
  const edges = nodes.map((node, index) => ({
    node,
    cursor: encodeCursor(options.cursorFor(node, index)),
  }));
  return {
    edges,
    totalCount: options.totalCount ?? null,
    pageInfo: {
      hasNextPage: options.hasNextPage ?? false,
      hasPreviousPage: options.hasPreviousPage ?? false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  };
}

/**
 * Coerce whatever a `@Connection` field returned into connection shape.
 *
 * Arrays are sliced against the incoming pagination arguments; anything already
 * shaped is passed through untouched.
 */
export function toConnection(value: unknown, args: ConnectionArgs): unknown {
  if (value === null || value === undefined) return value;
  if (isConnection(value)) return value;
  if (Array.isArray(value)) return connectionFromArray(value, args);
  return value;
}
