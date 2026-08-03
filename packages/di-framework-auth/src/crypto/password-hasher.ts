import { base64UrlDecode, base64UrlEncode } from './base64url.ts';
import { timingSafeEqual } from './compare.ts';
import { randomBytes } from './random.ts';
import { buf, subtle } from './webcrypto.ts';

/**
 * Password hashing provider.
 *
 * The default implementation is PBKDF2-HMAC-SHA-256, because it is the only
 * password KDF available from the Web Crypto API and this package carries no
 * runtime dependencies. PBKDF2 is memory-cheap, so a GPU attacker gets better
 * value against it than against Argon2id — if you run on Bun or Node, prefer
 * `bunPasswordHasher()` / `nodeScryptHasher()` from `@di-framework/auth`'s
 * adapters. See the README's "Choosing a password hasher" section.
 */
export interface PasswordHasher {
  /** Stable identifier, recorded so a stored hash can be traced to its producer. */
  readonly id: string;
  /** Hash a plaintext password into a self-describing encoded string. */
  hash(password: string): Promise<string>;
  /** Verify a plaintext password against an encoded string. Never throws on mismatch. */
  verify(password: string, encoded: string): Promise<boolean>;
  /** True when `encoded` was produced with weaker parameters than the current ones. */
  needsRehash(encoded: string): boolean;
  /**
   * Burn the same amount of work as a real verification, for the case where no
   * user was found. Without this, a missing account returns measurably faster
   * than a wrong password and the login endpoint becomes a user-enumeration
   * oracle.
   */
  verifyDummy(password: string): Promise<false>;
}

/**
 * PBKDF2 iteration count.
 *
 * NIST SP 800-132 §5.2 says only "as large as can be tolerated"; OWASP's 2024
 * Password Storage Cheat Sheet gives 600,000 for PBKDF2-HMAC-SHA-256. That is
 * roughly 200–400 ms on current server hardware, which is why login throttling
 * (see `../throttle.ts`) is not optional — this is expensive enough to be a
 * denial-of-service vector if left unbounded.
 */
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;

/** SP 800-132 §5.1 requires a salt of at least 128 bits. */
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM_ID = 'pbkdf2-sha256';

export interface Pbkdf2Options {
  iterations?: number;
  /**
   * Apply Unicode NFKC normalisation before hashing (recommended by NIST
   * SP 800-63B §5.1.1.2 so that visually identical passwords typed on different
   * keyboards match).
   *
   * This is a one-way door: it must be applied identically at registration and
   * verification forever. Changing it invalidates every stored hash, which is
   * why it is baked into the `pbkdf2-sha256` identifier rather than being a
   * per-call flag.
   */
  normalize?: boolean;
}

interface ParsedHash {
  algorithm: string;
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/** `$pbkdf2-sha256$i=600000$<salt>$<hash>` — PHC-inspired, so parameters travel with the hash. */
function encode(iterations: number, salt: Uint8Array, hash: Uint8Array): string {
  return `$${ALGORITHM_ID}$i=${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  // ['', algorithm, params, salt, hash]
  if (parts.length !== 5 || parts[0] !== '') return null;
  const [, algorithm, params, saltPart, hashPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM_ID) return null;

  const match = /^i=(\d+)$/.exec(params);
  if (!match) return null;
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return null;

  try {
    return {
      algorithm,
      iterations,
      salt: base64UrlDecode(saltPart),
      hash: base64UrlDecode(hashPart),
    };
  } catch {
    return null;
  }
}

function prepare(password: string, normalize: boolean): Uint8Array {
  return new TextEncoder().encode(normalize ? password.normalize('NFKC') : password);
}

async function derive(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', buf(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** PBKDF2-HMAC-SHA-256 hasher (NIST SP 800-132). The zero-dependency default. */
export function pbkdf2Hasher(options: Pbkdf2Options = {}): PasswordHasher {
  const iterations = options.iterations ?? PBKDF2_DEFAULT_ITERATIONS;
  const normalize = options.normalize !== false;

  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError(
      `pbkdf2Hasher iterations must be a positive integer, received ${iterations}`,
    );
  }

  return {
    id: ALGORITHM_ID,

    async hash(password) {
      const salt = randomBytes(SALT_BYTES);
      const derived = await derive(prepare(password, normalize), salt, iterations);
      return encode(iterations, salt, derived);
    },

    async verify(password, encoded) {
      const parsed = parse(encoded);
      if (!parsed) return false;
      const derived = await derive(prepare(password, normalize), parsed.salt, parsed.iterations);
      return timingSafeEqual(derived, parsed.hash);
    },

    needsRehash(encoded) {
      const parsed = parse(encoded);
      // An unparseable or foreign hash always needs replacing.
      if (!parsed) return true;
      return parsed.iterations < iterations;
    },

    async verifyDummy(password) {
      await derive(prepare(password, normalize), DUMMY_SALT, iterations);
      return false;
    },
  };
}

/**
 * A fixed salt for the dummy verification path. It is not a secret: its only job
 * is to make the no-such-user branch cost the same as the wrong-password branch.
 */
const DUMMY_SALT = new Uint8Array([
  0x64, 0x69, 0x2d, 0x66, 0x72, 0x61, 0x6d, 0x65, 0x77, 0x6f, 0x72, 0x6b, 0x2f, 0x61, 0x75, 0x74,
]);

/** Expose the encoding helpers so adapters can produce compatible strings. */
export const pbkdf2Internals = { encode, parse } as const;
