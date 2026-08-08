import { AuthError } from '../errors.ts';
import { createPrincipal, type Principal } from '../principal.ts';
import { authenticated, authFailed, noCredential } from '../result.ts';
import type { SignatureAlgorithm } from '../tokens/algorithms.ts';
import type { JwsHeader } from '../tokens/jws.ts';
import { type JwtClaims, verifyJwt } from '../tokens/jwt.ts';
import type { AuthStrategy } from '../types.ts';

/** RFC 6750 §2.1: `Authorization: Bearer <token>`, case-insensitive scheme. */
const BEARER_PATTERN = /^Bearer[ \t]+([\x21-\x7e]+)[ \t]*$/i;

export interface BearerTokenStrategyOptions {
  /**
   * Permitted signing algorithms. **Required** — there is no default, so a
   * verifier that accepts whatever the token claims cannot be written by
   * omission. See the note in `../tokens/jws.ts`.
   */
  algorithms: readonly SignatureAlgorithm[];
  key: CryptoKey | ((header: JwsHeader) => Promise<CryptoKey> | CryptoKey);
  issuer?: string | readonly string[];
  audience?: string | readonly string[];
  /** `realm` in the `WWW-Authenticate` challenge. */
  realm?: string;
  clockToleranceSeconds?: number;
  /** Map validated claims onto a principal. Defaults to a standard OIDC mapping. */
  toPrincipal?: (claims: JwtClaims, header: JwsHeader) => Principal;
  now?: () => number;
}

/** JWT bearer tokens. */
export function bearerTokenStrategy(options: BearerTokenStrategyOptions): AuthStrategy {
  const realm = options.realm ?? 'api';

  const toPrincipal =
    options.toPrincipal ??
    ((claims: JwtClaims): Principal => {
      const scope = claims.scope;
      return createPrincipal({
        sub: String(claims.sub ?? ''),
        method: 'bearer',
        authTime:
          typeof claims.auth_time === 'number'
            ? claims.auth_time
            : typeof claims.iat === 'number'
              ? claims.iat
              : Math.floor(Date.now() / 1000),
        ...(typeof claims.iss === 'string' ? { issuer: claims.iss } : {}),
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
        ...(Array.isArray(claims.amr) ? { amr: claims.amr as string[] } : {}),
        ...(typeof claims.acr === 'string' ? { acr: claims.acr } : {}),
        // Carried as data. This package does not interpret scopes.
        ...(typeof scope === 'string' ? { scope: scope.split(' ').filter(Boolean) } : {}),
        claims,
      });
    });

  return {
    name: 'bearer',

    async authenticate(context) {
      const header = context.request.headers.get('authorization');
      if (!header) return noCredential();

      const match = BEARER_PATTERN.exec(header);
      // A non-Bearer `Authorization` header belongs to another strategy; a
      // malformed *Bearer* header is this strategy's problem and is a failure.
      if (!match) {
        if (/^Bearer\b/i.test(header)) {
          return authFailed(
            'malformed_credential',
            'Authorization header is not a well-formed Bearer token',
            {
              challenge: `Bearer realm="${realm}", error="invalid_request"`,
            },
          );
        }
        return noCredential();
      }

      try {
        const { header: jwsHeader, claims } = await verifyJwt(match[1]!, {
          algorithms: options.algorithms,
          key: options.key,
          ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
          ...(options.audience !== undefined ? { audience: options.audience } : {}),
          ...(options.clockToleranceSeconds !== undefined
            ? { clockToleranceSeconds: options.clockToleranceSeconds }
            : {}),
          ...(options.now ? { now: options.now } : {}),
        });

        if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
          return authFailed('invalid_token', 'Bearer token has no sub claim', {
            challenge: `Bearer realm="${realm}", error="invalid_token"`,
          });
        }

        return authenticated(toPrincipal(claims, jwsHeader));
      } catch (error) {
        const code = error instanceof AuthError ? error.code : 'invalid_token';
        return authFailed(
          code === 'token_expired' ? 'token_expired' : 'invalid_token',
          error instanceof Error ? error.message : String(error),
          {
            // RFC 6750 §3.1 registers exactly three error codes. Anything more
            // specific here would leak why verification failed.
            challenge: `Bearer realm="${realm}", error="invalid_token"`,
          },
        );
      }
    },

    challenge() {
      return `Bearer realm="${realm}"`;
    },
  };
}
