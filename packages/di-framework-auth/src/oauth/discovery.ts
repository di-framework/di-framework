import { AuthError } from '../errors.ts';
import { fetchJson } from '../tokens/jwks.ts';

/** OpenID Connect Discovery 1.0. */

export interface OidcMetadata extends Record<string, unknown> {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  response_modes_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  token_endpoint_auth_methods_supported?: string[];
}

export interface DiscoveryOptions {
  cacheTtlMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Permit `http://` for loopback issuers during development. */
  allowInsecureHttp?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Discovery {
  get(): Promise<OidcMetadata>;
  refresh(): Promise<OidcMetadata>;
}

const DEFAULTS = {
  cacheTtlMs: 60 * 60 * 1000,
  maxStaleMs: 24 * 60 * 60 * 1000,
  timeoutMs: 5000,
  maxBytes: 256 * 1024,
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * OIDC Discovery §4: the well-known segment is appended **after** the issuer's
 * path, not at the host root.
 *
 * This trips people up with tenant-scoped issuers — Entra's
 * `https://login.microsoftonline.com/{tenant}/v2.0` discovers at
 * `.../v2.0/.well-known/openid-configuration`, not at the domain root.
 */
export function wellKnownUrl(issuer: string): string {
  const trimmed = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  return `${trimmed}/.well-known/openid-configuration`;
}

function assertSecureUrl(value: unknown, what: string, allowInsecureHttp: boolean): string {
  if (typeof value !== 'string') {
    throw new AuthError(`Discovery document has no ${what}`, {
      code: 'discovery_failed',
      status: 502,
    });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError(`Discovery ${what} '${value}' is not a valid URL`, {
      code: 'discovery_failed',
      status: 502,
    });
  }
  if (url.protocol === 'https:') return value;
  if (url.protocol === 'http:' && allowInsecureHttp && LOOPBACK_HOSTS.has(url.hostname)) {
    return value;
  }
  throw new AuthError(`Discovery ${what} must use HTTPS; received '${value}'`, {
    code: 'discovery_failed',
    status: 502,
  });
}

export function validateMetadata(
  document: unknown,
  expectedIssuer: string,
  allowInsecureHttp = false,
): OidcMetadata {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new AuthError('Discovery document is not a JSON object', {
      code: 'discovery_failed',
      status: 502,
    });
  }
  const metadata = document as Record<string, unknown>;

  // OIDC Discovery §4.3: the `issuer` in the document MUST exactly equal the
  // issuer that was used to construct the discovery URL. This is the
  // impersonation defence, and it is a byte comparison — no trailing-slash
  // forgiveness, no case folding. Relaxing it is how an attacker who can
  // influence the discovery URL gets to name themselves as a trusted issuer.
  if (metadata.issuer !== expectedIssuer) {
    throw new AuthError(
      `Discovery issuer '${String(metadata.issuer)}' does not exactly match the requested issuer '${expectedIssuer}'`,
      { code: 'issuer_mismatch', status: 502 },
    );
  }

  assertSecureUrl(metadata.authorization_endpoint, 'authorization_endpoint', allowInsecureHttp);
  assertSecureUrl(metadata.token_endpoint, 'token_endpoint', allowInsecureHttp);
  assertSecureUrl(metadata.jwks_uri, 'jwks_uri', allowInsecureHttp);

  // RFC 9700 §2.1.1 makes PKCE mandatory for the authorization code grant. A
  // provider that cannot do S256 is one we decline to talk to rather than
  // silently downgrade with.
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new AuthError(
      `Provider '${expectedIssuer}' does not advertise support for PKCE S256, which is mandatory`,
      { code: 'discovery_failed', status: 502 },
    );
  }

  return metadata as OidcMetadata;
}

export function discovery(issuer: string, options: DiscoveryOptions = {}): Discovery {
  const config = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => Date.now());
  const url = wellKnownUrl(issuer);

  let cached: OidcMetadata | undefined;
  let cachedAt = 0;
  let inFlight: Promise<OidcMetadata> | undefined;

  const load = async (): Promise<OidcMetadata> => {
    inFlight ??= (async () => {
      try {
        const document = await fetchJson(url, {
          timeoutMs: config.timeoutMs,
          maxBytes: config.maxBytes,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        const metadata = validateMetadata(document, issuer, options.allowInsecureHttp === true);
        cached = metadata;
        cachedAt = now();
        return metadata;
      } catch (error) {
        // A provider outage should not take sign-in down for the whole cache
        // window — the endpoints we already know are still the right endpoints.
        if (cached && now() - cachedAt < config.maxStaleMs) return cached;
        throw error;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    async get() {
      if (cached && now() - cachedAt < config.cacheTtlMs) return cached;
      return load();
    },
    async refresh() {
      cachedAt = 0;
      return load();
    },
  };
}
