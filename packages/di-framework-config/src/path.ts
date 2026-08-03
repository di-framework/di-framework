/**
 * Read a dotted path from a nested object.
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
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

  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) continue;
    const next = cur[key];
    if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cur[last] = value;
}

/**
 * Deep-merge plain objects. Arrays and non-objects from `source` replace.
 * Later source wins for conflicting keys.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Walk a nested object and yield `[dottedPath, value]` for every leaf and intermediate object.
 */
export function flattenEntries(
  obj: Record<string, unknown>,
  prefix = '',
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    entries.push([path, value]);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenEntries(value as Record<string, unknown>, path));
    }
  }
  return entries;
}
