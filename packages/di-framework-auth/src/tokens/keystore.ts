import { AuthError } from '../errors.ts';
import type { KeyStore, SigningKeyRecord } from '../providers/types.ts';
import { DEFAULT_ALGORITHM, type SignatureAlgorithm } from './algorithms.ts';
import { generateKeyPair, importJwk, type Jwk, type JwkSet, toPublicJwk } from './jwk.ts';
import type { JwsHeader } from './jws.ts';

/**
 * Signing-key lifecycle.
 *
 * Rotation has an overlap window rather than being a cutover: a new key starts
 * signing immediately, while the previous key keeps verifying until every token
 * it signed has expired. Without the overlap, rotating a key invalidates every
 * token in flight — which is the reason key rotation so often gets deferred
 * indefinitely.
 */

export interface KeyServiceOptions {
  store: KeyStore;
  algorithm?: SignatureAlgorithm;
  /**
   * How long a retired key stays in the JWKS after rotation. Must exceed the
   * longest access-token lifetime. Default 24 hours.
   */
  retirementSeconds?: number;
  now?: () => number;
}

export interface KeyService {
  /** The signing key, generating one on first use. */
  signingKey(): Promise<{ record: SigningKeyRecord; key: CryptoKey }>;
  /** Resolve a verification key for a JWS header, by `kid`. */
  verificationKey(header: JwsHeader): Promise<CryptoKey>;
  /** The public JWKS to publish at `/.well-known/jwks.json`. */
  publicJwks(): Promise<JwkSet>;
  /** Generate a new key, make it current, and retire the previous one. */
  rotate(): Promise<SigningKeyRecord>;
}

export function keyService(options: KeyServiceOptions): KeyService {
  const { store } = options;
  const algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
  const retirementSeconds = options.retirementSeconds ?? 24 * 60 * 60;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  // Imported CryptoKeys are cached per kid: importing is not free and this sits
  // on the hot path for every issued and verified token.
  const imported = new Map<string, Promise<CryptoKey>>();
  let bootstrapping: Promise<SigningKeyRecord> | undefined;

  const importFor = (record: SigningKeyRecord, usage: 'sign' | 'verify'): Promise<CryptoKey> => {
    const cacheKey = `${record.kid}:${usage}`;
    let key = imported.get(cacheKey);
    if (!key) {
      const jwk = (usage === 'sign' ? record.privateJwk : record.publicJwk) as Jwk;
      key = importJwk(jwk, record.algorithm as SignatureAlgorithm, usage);
      imported.set(cacheKey, key);
    }
    return key;
  };

  const create = async (): Promise<SigningKeyRecord> => {
    const generated = await generateKeyPair(algorithm);
    return store.save({
      kid: generated.kid,
      algorithm: generated.algorithm,
      privateJwk: generated.privateJwk as Record<string, unknown>,
      publicJwk: generated.publicJwk as Record<string, unknown>,
      createdAt: now(),
    });
  };

  return {
    async signingKey() {
      let record: SigningKeyRecord;
      try {
        record = await store.current();
      } catch {
        // First use: generate lazily. The DI container's `resolve` is
        // synchronous, so a key cannot be generated during registration — see
        // the note in `../register.ts`. Collapse concurrent bootstraps.
        bootstrapping ??= create().finally(() => {
          bootstrapping = undefined;
        });
        record = await bootstrapping;
      }
      return { record, key: await importFor(record, 'sign') };
    },

    async verificationKey(header) {
      if (!header.kid) {
        const record = await store.current();
        return importFor(record, 'verify');
      }
      const record = await store.find(header.kid);
      if (!record) {
        throw new AuthError(`No signing key with kid '${header.kid}'`, {
          code: 'invalid_signature',
        });
      }
      return importFor(record, 'verify');
    },

    async publicJwks() {
      const records = await store.all();
      return { keys: records.map((record) => toPublicJwk(record.publicJwk as Jwk)) };
    },

    async rotate() {
      const at = now();
      let previous: SigningKeyRecord | undefined;
      try {
        previous = await store.current();
      } catch {
        previous = undefined;
      }

      const next = await create();

      if (previous && previous.kid !== next.kid) {
        // Stops signing now, keeps verifying until every token it signed has
        // expired, then drops out of the JWKS.
        await store.save({
          ...previous,
          notAfter: at,
          expiresAt: at + retirementSeconds,
        });
      }

      return next;
    },
  };
}
