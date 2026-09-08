import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineEnv, type Preset, type ResolvedEnvironment } from 'unenv';

const directory = dirname(fileURLToPath(import.meta.url));

/** Prefer compiled `.js` in published dist; fall back to `.ts` under bun tests. */
export function resolveRuntimeFile(fromDirectory: string, name: string): string {
  const compiled = join(fromDirectory, `${name}.js`);
  return existsSync(compiled) ? compiled : join(fromDirectory, `${name}.ts`);
}

function runtimeFile(name: string): string {
  return resolveRuntimeFile(directory, name);
}

export function wasmcloudUnenvPreset(
  fsPath = runtimeFile('fs'),
  processPath = runtimeFile('process'),
  modulePath = runtimeFile('module'),
  netPath = runtimeFile('net'),
  dgramPath = runtimeFile('dgram'),
  cryptoPath = runtimeFile('crypto'),
  httpPath = runtimeFile('http'),
): Preset {
  return {
    meta: { name: 'unenv:wasmcloud' },
    alias: {
      fs: fsPath,
      'node:fs': fsPath,
      process: processPath,
      'node:process': processPath,
      module: modulePath,
      'node:module': modulePath,
      net: netPath,
      'node:net': netPath,
      dgram: dgramPath,
      'node:dgram': dgramPath,
      crypto: cryptoPath,
      'node:crypto': cryptoPath,
      http: httpPath,
      'node:http': httpPath,
    },
    inject: {
      process: [processPath, 'default'],
      crypto: [cryptoPath, 'webcrypto'],
    },
  };
}

function withoutProcessPolyfill(polyfill: readonly string[]): string[] {
  return polyfill.filter((entry) => !entry.includes('polyfill/process'));
}

export function rolldownInject(
  inject: ResolvedEnvironment['inject'],
): Record<string, string | [string, string]> {
  const result: Record<string, string | [string, string]> = {};
  for (const [name, value] of Object.entries(inject)) {
    if (Array.isArray(value)) {
      const specifier = value[0];
      const exported = value[1];
      if (typeof specifier === 'string' && typeof exported === 'string') {
        result[name] = [specifier, exported];
      }
    } else if (typeof value === 'string') {
      result[name] = value;
    }
  }
  return result;
}

let cached: ResolvedEnvironment | undefined;

export function wasmcloudNodeEnv(): ResolvedEnvironment {
  if (cached !== undefined) return cached;
  const processPath = runtimeFile('process');
  const env = defineEnv({
    nodeCompat: true,
    resolve: true,
    presets: [wasmcloudUnenvPreset()],
  }).env;
  const cryptoPath = runtimeFile('crypto');
  cached = {
    alias: env.alias,
    inject: {
      ...env.inject,
      process: [processPath, 'default'],
      crypto: [cryptoPath, 'webcrypto'],
    },
    polyfill: withoutProcessPolyfill(env.polyfill),
    external: env.external,
  };
  return cached;
}
