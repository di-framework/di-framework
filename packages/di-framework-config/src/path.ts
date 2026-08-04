/** Keys that must never be used as object property names from untrusted paths. */
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Default nesting limit for recursive object walks on untrusted config trees.
 * Prevents stack overflow / event-loop stalls on malicious or cyclic input.
 */
export const DEFAULT_MAX_OBJECT_DEPTH = 64;

function isSafeKey(key: string): boolean {
  return !DANGEROUS_KEYS.has(key);
}

function assertDepth(depth: number, maxDepth: number, label: string): void {
  if (depth > maxDepth) {
    throw new Error(`${label} exceeded max object depth of ${maxDepth}`);
  }
}

/**
 * Read a dotted path from a nested object.
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (!isSafeKey(part)) return undefined;
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Write a dotted path into a nested object (mutates `target`).
 */
export function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return;
  if (parts.some((part) => !isSafeKey(part))) return;

  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) continue;
    const next = cur[key];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = Object.create(null) as Record<string, unknown>;
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

/**
 * Deep-merge plain objects. Arrays and non-objects from `source` replace.
 * Later source wins for conflicting keys.
 *
 * Depth-bounded (default {@link DEFAULT_MAX_OBJECT_DEPTH}) and cycle-safe via a
 * visited set on the source object graph.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  maxDepth: number = DEFAULT_MAX_OBJECT_DEPTH,
): Record<string, unknown> {
  return deepMergeAt(target, source, 0, maxDepth, new WeakSet<object>());
}

function deepMergeAt(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  assertDepth(depth, maxDepth, 'deepMerge');
  if (seen.has(source)) {
    throw new Error('deepMerge detected a cyclic object graph');
  }
  seen.add(source);

  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (!isSafeKey(key)) continue;
    const existing = out[key];
    const valueIsPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value);
    const existingIsPlainObject =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing);

    if (valueIsPlainObject && existingIsPlainObject) {
      out[key] = deepMergeAt(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
        depth + 1,
        maxDepth,
        seen,
      );
    } else if (valueIsPlainObject) {
      // Clone nested plain objects so depth/cycle checks still apply when the
      // target has no object to merge into (do not attach source by reference).
      out[key] = deepMergeAt({}, value as Record<string, unknown>, depth + 1, maxDepth, seen);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Walk a nested object and yield `[dottedPath, value]` for every leaf and intermediate object.
 * Iterative (stack-based) with depth bound and cycle detection.
 */
export function flattenEntries(
  obj: Record<string, unknown>,
  prefix = '',
  maxDepth: number = DEFAULT_MAX_OBJECT_DEPTH,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  const stack: Array<{ obj: Record<string, unknown>; prefix: string; depth: number }> = [
    { obj, prefix, depth: 0 },
  ];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    assertDepth(frame.depth, maxDepth, 'flattenEntries');
    if (seen.has(frame.obj)) {
      throw new Error('flattenEntries detected a cyclic object graph');
    }
    seen.add(frame.obj);

    for (const [key, value] of Object.entries(frame.obj)) {
      if (!isSafeKey(key)) continue;
      const path = frame.prefix ? `${frame.prefix}.${key}` : key;
      entries.push([path, value]);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        stack.push({
          obj: value as Record<string, unknown>,
          prefix: path,
          depth: frame.depth + 1,
        });
      }
    }
  }
  return entries;
}
