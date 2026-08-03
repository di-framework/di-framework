import { strictDecoder } from '../crypto/webcrypto.ts';
import { AuthError } from '../errors.ts';
import { isSignatureAlgorithm, type SignatureAlgorithm } from './algorithms.ts';
import { importJwk, type Jwk, type JwkSet } from './jwk.ts';
import type { JwsHeader } from './jws.ts';

/**
 * Remote JWKS resolution (RFC 7517 §5), for verifying tokens signed by someone
 * else — an OIDC provider, another service.
 *
 * Three behaviours worth being explicit about:
 *
 * - **In-flight de-duplication.** A cold cache plus a burst of traffic must not
 *   produce a burst of identical fetches at the provider.
 * - **Stale-on-error.** A provider outage should not take down token
 *   verification for tokens signed by keys we already hold.
 * - **Bounded refresh on unknown `kid`.** A rotated key must be picked up
 *   quickly, but an attacker sending random `kid` values must not be able to
 *   drive unbounded outbound requests, so refreshes are rate-limited.
 */

export interface RemoteJwksOptions {
  /** Successful responses are reused for this long. Default 10 minutes. */
  cacheTtlMs?: number;
  /** How long a cached document may be served after a failed refresh. Default 24 hours. */
  maxStaleMs?: number;
  /** Minimum gap between refreshes triggered by an unknown `kid`. Default 30 seconds. */
  minRefreshIntervalMs?: number;
  timeoutMs?: number;
  /** Response body cap, to bound memory. Default 256 KiB. */
  maxBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RemoteJwks {
  /** Resolve a verification key for a JWS header. */
  getKey(header: JwsHeader): Promise<CryptoKey>;
  /** Force a refresh, ignoring the TTL. */
  refresh(): Promise<JwkSet>;
  /** The cached document, fetching if necessary. */
  get(): Promise<JwkSet>;
}

const DEFAULTS = {
  cacheTtlMs: 10 * 60 * 1000,
  maxStaleMs: 24 * 60 * 60 * 1000,
  minRefreshIntervalMs: 30 * 1000,
  timeoutMs: 5000,
  maxBytes: 256 * 1024,
};

function assertJwkSet(value: unknown): asserts value is JwkSet {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as { keys?: unknown }).keys)
  ) {
    throw new AuthError('JWKS response is not a JSON object with a "keys" array', {
      code: 'discovery_failed',
      status: 502,
    });
  }
}

function tooLarge(url: string, bytes: number | string, cap: number): AuthError {
  return new AuthError(`GET ${url} returned ${bytes} bytes, over the ${cap} cap`, {
    code: 'discovery_failed',
    status: 502,
  });
}

/**
 * Read the body as UTF-8 text, refusing to hold more than `maxBytes` of it.
 *
 * The cap has to be enforced *while* reading. `await response.text()` buffers
 * the whole body first, so checking afterwards bounds nothing — a hostile or
 * broken endpoint could stream gigabytes before the check ever runs. The count
 * is in bytes, not characters: a multi-byte UTF-8 document has fewer characters
 * than bytes, so a character comparison silently raises the real cap.
 */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(url, declared, maxBytes);
  }

  const body = response.body;
  // Not every Response has a readable stream — notably ones synthesised in
  // tests — so fall back to buffering, where the byte length is still exact.
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw tooLarge(url, bytes.byteLength, maxBytes);
    return strictDecoder().decode(bytes);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge(url, `more than ${maxBytes}`, maxBytes);
      chunks.push(value);
    }
  } finally {
    // Releasing before cancel would make cancel() throw; cancelling is what
    // actually stops an oversized transfer at the socket.
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return strictDecoder().decode(joined);
}

export async function fetchJson(
  url: string,
  options: { timeoutMs: number; maxBytes: number; fetch?: typeof fetch },
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) {
      throw new AuthError(`GET ${url} returned ${response.status}`, {
        code: 'discovery_failed',
        status: 502,
      });
    }

    const text = await readCapped(response, options.maxBytes, url);
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new AuthError(`GET ${url} did not return valid JSON`, {
        code: 'discovery_failed',
        status: 502,
        cause,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export function remoteJwks(uri: string, options: RemoteJwksOptions = {}): RemoteJwks {
  const config = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => Date.now());

  let cached: JwkSet | undefined;
  let cachedAt = 0;
  let inFlight: Promise<JwkSet> | undefined;
  let lastRefreshAttempt = 0;

  const load = async (): Promise<JwkSet> => {
    // Collapse concurrent misses into one request.
    inFlight ??= (async () => {
      try {
        lastRefreshAttempt = now();
        const document = await fetchJson(uri, {
          timeoutMs: config.timeoutMs,
          maxBytes: config.maxBytes,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        assertJwkSet(document);
        cached = document;
        cachedAt = now();
        return document;
      } catch (error) {
        // Serve a stale document rather than failing every verification during a
        // provider outage — the keys we already hold are still the right keys.
        if (cached && now() - cachedAt < config.maxStaleMs) return cached;
        throw error;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const get = async (): Promise<JwkSet> => {
    if (cached && now() - cachedAt < config.cacheTtlMs) return cached;
    return load();
  };

  const select = (set: JwkSet, header: JwsHeader): Jwk | undefined => {
    const candidates = set.keys.filter((key) => {
      if (key.use !== undefined && key.use !== 'sig') return false;
      if (key.alg !== undefined && key.alg !== header.alg) return false;
      return true;
    });
    if (header.kid !== undefined) return candidates.find((key) => key.kid === header.kid);
    // No `kid`: unambiguous only when exactly one key could have signed this.
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  return {
    get,
    async refresh() {
      cachedAt = 0;
      return load();
    },
    async getKey(header) {
      if (!isSignatureAlgorithm(header.alg)) {
        throw new AuthError(`Unsupported JWS alg '${String(header.alg)}'`, {
          code: 'invalid_algorithm',
        });
      }

      let set = await get();
      let jwk = select(set, header);

      // An unknown `kid` usually means the provider rotated. Refresh once, but
      // rate-limited so a stream of forged `kid`s cannot be turned into a
      // request amplifier pointed at the provider.
      if (!jwk && now() - lastRefreshAttempt > config.minRefreshIntervalMs) {
        set = await this.refresh();
        jwk = select(set, header);
      }

      if (!jwk) {
        throw new AuthError(
          `No JWKS key matched kid '${header.kid ?? '(none)'}' for alg '${header.alg}'`,
          { code: 'invalid_signature' },
        );
      }

      return importJwk(jwk, header.alg as SignatureAlgorithm, 'verify');
    },
  };
}
