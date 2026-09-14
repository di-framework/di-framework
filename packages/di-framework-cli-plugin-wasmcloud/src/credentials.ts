import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CommandFailure } from '@di-framework/cli-extension';
import type { WasmcloudDeps } from './deps';
import type { ControllerEndpoint } from './target';

export const DEPLOY_TOKEN_ENV = 'DI_FRAMEWORK_DEPLOY_TOKEN';
export const CREDENTIALS_VERSION = 1 as const;

export type StoredCredential = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  controller: ControllerEndpoint;
};

export type CredentialsFile = {
  version: typeof CREDENTIALS_VERSION;
  targets: Record<string, StoredCredential>;
};

export function loginRequired(target: string): CommandFailure {
  return new CommandFailure(
    'WASMCLOUD_LOGIN_REQUIRED',
    `No credentials for target "${target}". Run: di-framework wasmcloud login --target ${target}`,
    2,
    { target },
  );
}

export function readCredentialsFile(path: string): CredentialsFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CredentialsFile;
    if (parsed.version !== CREDENTIALS_VERSION || typeof parsed.targets !== 'object' || parsed.targets === null) {
      return { version: CREDENTIALS_VERSION, targets: {} };
    }
    return parsed;
  } catch {
    return { version: CREDENTIALS_VERSION, targets: {} };
  }
}

export function writeCredentialsFile(path: string, file: CredentialsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function storeCredential(path: string, target: string, credential: StoredCredential): void {
  const file = readCredentialsFile(path);
  file.targets[target] = credential;
  writeCredentialsFile(path, file);
}

export function deleteCredential(path: string, target: string): boolean {
  const file = readCredentialsFile(path);
  if (file.targets[target] === undefined) return false;
  delete file.targets[target];
  if (Object.keys(file.targets).length === 0) {
    try {
      rmSync(path);
    } catch {
      writeCredentialsFile(path, file);
    }
    return true;
  }
  writeCredentialsFile(path, file);
  return true;
}

export function resolveAccessToken(deps: WasmcloudDeps, target: string): string {
  const ci = deps.env[DEPLOY_TOKEN_ENV]?.trim();
  if (ci !== undefined && ci !== '') return ci;
  const stored = readCredentialsFile(deps.credentialsPath()).targets[target];
  if (stored?.accessToken !== undefined && stored.accessToken !== '') return stored.accessToken;
  throw loginRequired(target);
}
