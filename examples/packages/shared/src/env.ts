import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RequireEnvOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Ancestor walk root for {@code .env.secrets}. Required for file lookup when {@link env} is not {@code process.env}. */
  readonly startDir?: string;
}

export type RequireOpenAiApiKeyOptions = RequireEnvOptions;

/** Parse a dotenv-style file into a key/value map (quotes stripped). */
export function parseEnvFile(text: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

function findEnvSecretsFile(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env.secrets');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readEnvSecretsValue(startDir: string, key: string): string | undefined {
  const path = findEnvSecretsFile(startDir);
  if (!path) return undefined;
  const value = parseEnvFile(readFileSync(path, 'utf8'))[key]?.trim();
  return value || undefined;
}

/**
 * Fill missing {@code process.env} keys from a gitignored {@code .env.secrets}
 * file under {@link startDir} or an ancestor. Existing env wins.
 */
export function loadEnvSecrets(startDir: string): string | undefined {
  const path = findEnvSecretsFile(startDir);
  if (!path) return undefined;
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
  return path;
}

/** Resolve a required env var from {@link env} or ancestor {@code .env.secrets}. */
export function requireEnv(name: string, options: RequireEnvOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env[name]?.trim();
  if (configured) return configured;

  if (env === process.env) {
    loadEnvSecrets(options.startDir ?? process.cwd());
    const afterLoad = process.env[name]?.trim();
    if (afterLoad) return afterLoad;
  } else if (options.startDir !== undefined) {
    const fromFile = readEnvSecretsValue(options.startDir, name);
    if (fromFile) return fromFile;
  }

  throw new Error(`${name} is not set (export it or add it to .env.secrets)`);
}

/** Resolve {@code OPENAI_API_KEY} for live example paths. */
export function requireOpenAiApiKey(
  env: NodeJS.ProcessEnv = process.env,
  startDir?: string,
): string {
  return requireEnv('OPENAI_API_KEY', { env, startDir });
}
