import { dirname, extname, join } from 'node:path';
import { defineMetadata, getMetadata } from '@di-framework/core/container';

const WITH_PROFILE_KEY = 'di:config:with-profile';

let selectedProfiles: readonly string[] = [];

function assertProfileName(profile: string): string {
  if (!profile || profile !== profile.trim() || /[\\/]/.test(profile) || profile.includes('..')) {
    throw new Error(`Invalid config profile name: ${JSON.stringify(profile)}`);
  }
  return profile;
}

/** Currently selected profiles for file overlays (`{profile}.config.{ext}`). */
export function getSelectedProfiles(): readonly string[] {
  return selectedProfiles;
}

/** Replace the process-selected profiles used when a source does not set its own. */
export function setSelectedProfiles(...profiles: string[]): void {
  selectedProfiles = profiles.map(assertProfileName);
}

export function runWithProfiles<T>(profiles: readonly string[] | undefined, fn: () => T): T {
  if (profiles == null) return fn();
  const previous = selectedProfiles;
  selectedProfiles = profiles.map(assertProfileName);
  try {
    const result = fn();
    if (isThenable(result)) {
      return result.finally(() => {
        selectedProfiles = previous;
      }) as T;
    }
    selectedProfiles = previous;
    return result;
  } catch (error) {
    selectedProfiles = previous;
    throw error;
  }
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function storeWithProfiles(target: object, profiles: readonly string[]): void {
  defineMetadata(WITH_PROFILE_KEY, profiles.map(assertProfileName), target);
}

export function getWithProfiles(target: object): readonly string[] | undefined {
  return getMetadata(WITH_PROFILE_KEY, target) as readonly string[] | undefined;
}

/** `{dir}/{profile}.config{ext}` next to the base config file. */
export function profileConfigPath(file: string, profile: string): string {
  const extension = extname(file);
  return join(dirname(file), `${assertProfileName(profile)}.config${extension}`);
}
