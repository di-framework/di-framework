import type { ConfigKeyCase } from './types.ts';

/**
 * `DATABASE_HOST` → `databaseHost`, `host` → `host`.
 */
export function toCamelCase(segment: string): string {
  const lower = segment.toLowerCase();
  return lower.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function transformKeySegment(segment: string, keyCase: ConfigKeyCase): string {
  if (keyCase === 'preserve') return segment;
  if (keyCase === 'lower') return segment.toLowerCase();
  return toCamelCase(segment);
}

/**
 * Coerce common env string forms: booleans, integers, floats. Empty string stays `''`.
 */
export function coerceEnvValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;

  if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  // JSON object/array literals
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  return raw;
}
