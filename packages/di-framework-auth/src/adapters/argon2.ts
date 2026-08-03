import { timingSafeEqualString } from '../crypto/compare.ts';
import type { PasswordHasher } from '../crypto/password-hasher.ts';

/**
 * Optional Argon2id password hashers.
 *
 * The zero-dependency default is PBKDF2-HMAC-SHA-256, because that is the only
 * password KDF the Web Cryptography API exposes. PBKDF2 is memory-cheap, so a
 * GPU attacker gets substantially better value against it than against Argon2id
 * — if your runtime offers a memory-hard KDF, use one.
 *
 * These are adapters in the sense `@di-framework/config`'s Zod adapter is: they
 * sit behind a structural interface and are loaded lazily, so importing the
 * package on a runtime that lacks them costs nothing.
 */

interface BunPasswordLike {
  hash(
    password: string,
    options?: { algorithm?: string; memoryCost?: number; timeCost?: number },
  ): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

interface NodeCryptoLike {
  scrypt(
    password: string,
    salt: string,
    keylen: number,
    options: { N?: number; r?: number; p?: number; maxmem?: number },
    callback: (error: Error | null, derived: Uint8Array) => void,
  ): void;
  randomBytes(size: number): { toString(encoding: string): string };
}

export interface BunPasswordOptions {
  /** Argon2id memory cost in KiB. Bun's default is 65536 (64 MiB). */
  memoryCost?: number;
  /** Argon2id iterations. Bun's default is 2. */
  timeCost?: number;
}

/**
 * Argon2id via `Bun.password`.
 *
 * Available with no install step on Bun, which is this repo's primary runtime.
 * Produces and consumes standard PHC strings, so a hash written by this hasher
 * is readable by any Argon2 implementation.
 */
export function bunPasswordHasher(options: BunPasswordOptions = {}): PasswordHasher {
  const bun = (globalThis as { Bun?: { password?: BunPasswordLike } }).Bun?.password;
  if (!bun) {
    throw new Error(
      'bunPasswordHasher() requires the Bun runtime. On Node, use nodeScryptHasher(); ' +
        'elsewhere, the default pbkdf2Hasher() works everywhere WebCrypto does.',
    );
  }

  const hashOptions = {
    algorithm: 'argon2id',
    ...(options.memoryCost !== undefined ? { memoryCost: options.memoryCost } : {}),
    ...(options.timeCost !== undefined ? { timeCost: options.timeCost } : {}),
  };

  return {
    id: 'argon2id',

    hash: (password) => bun.hash(password.normalize('NFKC'), hashOptions),

    async verify(password, encoded) {
      try {
        return await bun.verify(password.normalize('NFKC'), encoded);
      } catch {
        // A hash from a different family, or a malformed one. Not an error the
        // caller can act on — it is simply not a match.
        return false;
      }
    },

    needsRehash(encoded) {
      // Anything not already Argon2id should be upgraded, which is exactly what
      // makes migrating off pbkdf2Hasher a one-line change.
      if (!encoded.startsWith('$argon2id$')) return true;
      if (options.memoryCost === undefined) return false;
      const match = /\bm=(\d+)/.exec(encoded);
      return match ? Number(match[1]) < options.memoryCost : true;
    },

    async verifyDummy(password) {
      // Argon2 verification cost is dominated by the memory pass, so hashing a
      // throwaway value costs the same as verifying a real one.
      await bun.hash(password.normalize('NFKC'), hashOptions);
      return false;
    },
  };
}

export interface NodeScryptOptions {
  /** CPU/memory cost, a power of two. Default 2^17, per RFC 7914 §2 guidance for interactive use. */
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  keyLength?: number;
}

/**
 * scrypt via `node:crypto`.
 *
 * Memory-hard and NIST-recognised (SP 800-63B lists it among acceptable
 * verifiers), and available on Node without a native module. Encoded in the same
 * PHC-inspired shape the built-in PBKDF2 hasher uses.
 */
export function nodeScryptHasher(options: NodeScryptOptions = {}): PasswordHasher {
  const cost = options.cost ?? 2 ** 17;
  const blockSize = options.blockSize ?? 8;
  const parallelization = options.parallelization ?? 1;
  const keyLength = options.keyLength ?? 32;

  let module: Promise<NodeCryptoLike> | undefined;
  const load = (): Promise<NodeCryptoLike> => {
    module ??= import('node:crypto')
      .then((imported) => imported as unknown as NodeCryptoLike)
      .catch((cause) => {
        throw new Error(
          'nodeScryptHasher() requires node:crypto, which this runtime does not provide. ' +
            'Use pbkdf2Hasher() (WebCrypto, works everywhere) or bunPasswordHasher() on Bun.',
          { cause },
        );
      });
    return module;
  };

  const derive = async (
    password: string,
    salt: string,
    params: NodeScryptOptions,
  ): Promise<string> => {
    const crypto = await load();
    return new Promise((resolve, reject) => {
      crypto.scrypt(
        password.normalize('NFKC'),
        salt,
        params.keyLength ?? keyLength,
        {
          N: params.cost ?? cost,
          r: params.blockSize ?? blockSize,
          p: params.parallelization ?? parallelization,
          // The default maxmem (32 MiB) is below what N=2^17 needs.
          maxmem: 256 * 1024 * 1024,
        },
        (error, derived) => {
          if (error) reject(error);
          else resolve(Buffer.from(derived).toString('base64url'));
        },
      );
    });
  };

  const parse = (encoded: string) => {
    const parts = encoded.split('$');
    if (parts.length !== 5 || parts[1] !== 'scrypt') return null;
    const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2]!);
    if (!match) return null;
    return {
      cost: Number(match[1]),
      blockSize: Number(match[2]),
      parallelization: Number(match[3]),
      salt: parts[3]!,
      hash: parts[4]!,
    };
  };

  return {
    id: 'scrypt',

    async hash(password) {
      const crypto = await load();
      const salt = crypto.randomBytes(16).toString('base64url');
      const derived = await derive(password, salt, {});
      return `$scrypt$N=${cost},r=${blockSize},p=${parallelization}$${salt}$${derived}`;
    },

    async verify(password, encoded) {
      const parsed = parse(encoded);
      if (!parsed) return false;
      const derived = await derive(password, parsed.salt, {
        cost: parsed.cost,
        blockSize: parsed.blockSize,
        parallelization: parsed.parallelization,
      });
      return timingSafeEqualString(derived, parsed.hash);
    },

    needsRehash(encoded) {
      const parsed = parse(encoded);
      return !parsed || parsed.cost < cost;
    },

    async verifyDummy(password) {
      await derive(password, 'ZGktZnJhbWV3b3JrL2F1dGg', {});
      return false;
    },
  };
}
