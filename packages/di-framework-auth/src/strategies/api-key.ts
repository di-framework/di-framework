import { hashSecret } from '../crypto/hash.ts';
import { randomToken } from '../crypto/random.ts';
import { createPrincipal } from '../principal.ts';
import type { ApiKeyCredential, CredentialStore, UserStore } from '../providers/types.ts';
import { authenticated, authFailed, noCredential } from '../result.ts';
import type { AuthStrategy } from '../types.ts';

export interface ApiKeyStrategyOptions {
  credentials: CredentialStore;
  users?: UserStore;
  /** Header carrying the key. Default `x-api-key`. */
  headerName?: string;
  /** Also accept `Authorization: <prefix> <key>`. Default off. */
  authorizationScheme?: string;
  /** Record `lastUsedAt` on each use. Costs one write per request; default off. */
  trackUsage?: boolean;
  now?: () => number;
}

/**
 * Long-lived API keys for machine clients.
 *
 * Keys are 256-bit random values stored as their SHA-256 — the plaintext exists
 * exactly once, at creation, and is never recoverable. A password KDF would be
 * the wrong tool here for the reason set out in `../crypto/hash.ts`: there is no
 * dictionary to attack, and the cost would be paid on every single request.
 */
export function apiKeyStrategy(options: ApiKeyStrategyOptions): AuthStrategy {
  const headerName = (options.headerName ?? 'x-api-key').toLowerCase();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const scheme = options.authorizationScheme?.toLowerCase();

  const read = (request: Request): string | undefined => {
    const direct = request.headers.get(headerName);
    if (direct) return direct.trim();
    if (!scheme) return undefined;
    const authorization = request.headers.get('authorization');
    if (!authorization) return undefined;
    const separator = authorization.indexOf(' ');
    if (separator < 0) return undefined;
    if (authorization.slice(0, separator).toLowerCase() !== scheme) return undefined;
    return authorization.slice(separator + 1).trim();
  };

  return {
    name: 'api-key',

    async authenticate(context) {
      const key = read(context.request);
      if (!key) return noCredential();

      const credential = await options.credentials.findApiKey(await hashSecret(key));
      // One message for every rejection: a client that can distinguish "unknown
      // key" from "expired key" can enumerate which keys have ever existed.
      const invalid = () => authFailed('invalid_credentials', 'API key is not valid');

      if (!credential || credential.disabled) return invalid();
      if (credential.expiresAt !== undefined && credential.expiresAt <= now()) return invalid();

      if (options.users) {
        const user = await options.users.findById(credential.userId);
        if (!user || user.disabled) return invalid();
      }

      if (options.trackUsage) {
        await options.credentials.saveApiKey({ ...credential, lastUsedAt: now() });
      }

      return authenticated(
        createPrincipal({
          sub: credential.userId,
          method: 'api-key',
          authTime: credential.createdAt,
          ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
          claims: {
            apiKeyId: credential.id,
            ...(credential.label ? { label: credential.label } : {}),
          },
        }),
      );
    },
  };
}

export interface IssuedApiKey {
  /** Show this to the user once. It cannot be recovered afterwards. */
  key: string;
  credential: ApiKeyCredential;
}

/** Mint an API key. The returned plaintext is the only copy that will ever exist. */
export async function issueApiKey(
  credentials: CredentialStore,
  input: { userId: string; label?: string; expiresAt?: number; prefix?: string },
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<IssuedApiKey> {
  const secret = randomToken(32);
  // An optional prefix makes keys greppable in logs and scannable by secret
  // detectors, at no cost to entropy.
  const key = input.prefix ? `${input.prefix}_${secret}` : secret;

  const credential = await credentials.saveApiKey({
    kind: 'api-key',
    id: await hashSecret(key),
    userId: input.userId,
    createdAt: now(),
    ...(input.label ? { label: input.label } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });

  return { key, credential };
}
