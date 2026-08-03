import { describe, expect, it } from 'bun:test';
import { open, openJson, seal, sealJson } from '../src/crypto/aead.ts';
import {
  Base64UrlError,
  base64UrlDecode,
  base64UrlEncode,
  isBase64Url,
} from '../src/crypto/base64url.ts';
import { timingSafeEqual, timingSafeEqualString } from '../src/crypto/compare.ts';
import { hashSecret, sha256 } from '../src/crypto/hash.ts';
import {
  deriveAesKey,
  hkdf,
  KDF_LABELS,
  MIN_SECRET_BYTES,
  toSecretBytes,
} from '../src/crypto/kdf.ts';
import { pbkdf2Hasher } from '../src/crypto/password-hasher.ts';
import { randomToken } from '../src/crypto/random.ts';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    }
  });

  it('matches RFC 4648 §10 vectors, unpadded', () => {
    const encode = (text: string) => base64UrlEncode(new TextEncoder().encode(text));
    expect(encode('')).toBe('');
    expect(encode('f')).toBe('Zg');
    expect(encode('fo')).toBe('Zm8');
    expect(encode('foo')).toBe('Zm9v');
    expect(encode('foob')).toBe('Zm9vYg');
    expect(encode('fooba')).toBe('Zm9vYmE');
    expect(encode('foobar')).toBe('Zm9vYmFy');
  });

  // A lenient decoder makes two distinct strings decode to the same bytes, which
  // is signature malleability: a token already matched against a replay cache can
  // be mutated into a different string that still verifies.
  it('rejects padding', () => {
    expect(() => base64UrlDecode('Zg==')).toThrow(Base64UrlError);
  });

  it('rejects standard-alphabet characters', () => {
    expect(() => base64UrlDecode('a+b/c')).toThrow(Base64UrlError);
  });

  it('rejects whitespace', () => {
    expect(() => base64UrlDecode('Zm9v YmFy')).toThrow(Base64UrlError);
    expect(() => base64UrlDecode('Zm9v\nYmFy')).toThrow(Base64UrlError);
  });

  it('rejects a length of 1 mod 4', () => {
    expect(() => base64UrlDecode('Zm9vY')).toThrow(Base64UrlError);
  });

  it('rejects non-canonical trailing bits', () => {
    // 'Zh' and 'Zg' would both decode to 0x66 under a lenient decoder.
    expect(base64UrlDecode('Zg')).toEqual(new Uint8Array([0x66]));
    expect(() => base64UrlDecode('Zh')).toThrow(Base64UrlError);
  });

  it('reports validity without throwing', () => {
    expect(isBase64Url('Zm9vYmFy')).toBe(true);
    expect(isBase64Url('Zm9vYmFy=')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('is correct for equal and unequal inputs', async () => {
    expect(await timingSafeEqualString('hunter2', 'hunter2')).toBe(true);
    expect(await timingSafeEqualString('hunter2', 'hunter3')).toBe(false);
    expect(await timingSafeEqualString('short', 'much longer value')).toBe(false);
    expect(await timingSafeEqualString('', '')).toBe(true);
  });

  it('compares bytes, not references', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(await timingSafeEqual(a, b)).toBe(true);
    expect(await timingSafeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
  });
});

describe('HKDF', () => {
  // RFC 5869 Test Case 1 uses an `info` of 0xf0f1…f9; our API takes a string
  // label, so this checks the properties that matter operationally instead.
  it('derives distinct keys for distinct labels', async () => {
    const secret = new Uint8Array(32).fill(7);
    const a = await hkdf(secret, KDF_LABELS.csrf);
    const b = await hkdf(secret, KDF_LABELS.hs256);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('is deterministic for the same secret and label', async () => {
    const secret = 'a'.repeat(32);
    expect(hex(await hkdf(secret, KDF_LABELS.csrf))).toBe(hex(await hkdf(secret, KDF_LABELS.csrf)));
  });

  it('rejects a secret below the minimum length', () => {
    expect(() => toSecretBytes('too short')).toThrow(RangeError);
    expect(() => toSecretBytes(new Uint8Array(MIN_SECRET_BYTES))).not.toThrow();
  });
});

describe('AES-256-GCM sealing', () => {
  const secret = 'x'.repeat(48);

  it('round-trips a value', async () => {
    const key = await deriveAesKey(secret, KDF_LABELS.cookieAead);
    const sealed = await seal(key, 'session', 'hello');
    expect(new TextDecoder().decode((await open(key, 'session', sealed))!)).toBe('hello');
  });

  it('binds the purpose, so a ciphertext cannot be replayed elsewhere', async () => {
    const key = await deriveAesKey(secret, KDF_LABELS.cookieAead);
    const sealed = await seal(key, 'session', 'hello');
    expect(await open(key, 'oauth', sealed)).toBeNull();
  });

  it('returns null for tampered ciphertext rather than throwing', async () => {
    const key = await deriveAesKey(secret, KDF_LABELS.cookieAead);
    const sealed = await seal(key, 'session', 'hello');
    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(await open(key, 'session', tampered)).toBeNull();
    expect(await open(key, 'session', 'garbage')).toBeNull();
    expect(await open(key, 'session', 'v2.abc')).toBeNull();
  });

  it('uses a fresh nonce per call', async () => {
    const key = await deriveAesKey(secret, KDF_LABELS.cookieAead);
    expect(await seal(key, 'p', 'same')).not.toBe(await seal(key, 'p', 'same'));
  });

  it('round-trips JSON', async () => {
    const key = await deriveAesKey(secret, KDF_LABELS.cookieAead);
    const sealed = await sealJson(key, 'p', { a: 1 });
    expect(await openJson<{ a: number }>(key, 'p', sealed)).toEqual({ a: 1 });
  });
});

describe('pbkdf2Hasher', () => {
  // 1_000 iterations keeps the suite fast; the shipped default is 600_000.
  const hasher = pbkdf2Hasher({ iterations: 1_000 });

  it('verifies a correct password and rejects a wrong one', async () => {
    const encoded = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery staple', encoded)).toBe(true);
    expect(await hasher.verify('Correct horse battery staple', encoded)).toBe(false);
  });

  it('salts, so identical passwords hash differently', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'));
  });

  it('encodes its parameters so they can be upgraded', async () => {
    const encoded = await hasher.hash('pw');
    expect(encoded.startsWith('$pbkdf2-sha256$i=1000$')).toBe(true);
    expect(encoded.split('$')).toHaveLength(5);
  });

  it('flags hashes produced with weaker parameters', async () => {
    const weak = await pbkdf2Hasher({ iterations: 1_000 }).hash('pw');
    expect(pbkdf2Hasher({ iterations: 10_000 }).needsRehash(weak)).toBe(true);
    expect(pbkdf2Hasher({ iterations: 1_000 }).needsRehash(weak)).toBe(false);
  });

  it('treats an unparseable or foreign hash as needing a rehash', () => {
    expect(hasher.needsRehash('$argon2id$v=19$m=65536,t=3,p=4$abc$def')).toBe(true);
    expect(hasher.needsRehash('not-a-hash')).toBe(true);
  });

  it('returns false rather than throwing for a malformed stored hash', async () => {
    expect(await hasher.verify('pw', 'garbage')).toBe(false);
    expect(await hasher.verify('pw', '$pbkdf2-sha256$i=0$a$b')).toBe(false);
  });

  it('applies NFKC normalisation so equivalent inputs match', async () => {
    // U+00E9 vs U+0065 U+0301 — the same character, typed two ways.
    const encoded = await hasher.hash('café');
    expect(await hasher.verify('café', encoded)).toBe(true);
  });

  it('burns comparable work on the no-such-user path', async () => {
    expect(await hasher.verifyDummy('anything')).toBe(false);
  });
});

describe('hashSecret', () => {
  it('is a plain SHA-256, not a password KDF', async () => {
    // High-entropy secrets have no dictionary to attack, so a slow KDF would only
    // add cost to every request. See the note in src/crypto/hash.ts.
    const token = randomToken(32);
    expect(await hashSecret(token)).toBe(base64UrlEncode(await sha256(token)));
  });

  it('is deterministic', async () => {
    expect(await hashSecret('abc')).toBe(await hashSecret('abc'));
    expect(await hashSecret('abc')).not.toBe(await hashSecret('abd'));
  });
});

describe('randomToken', () => {
  it('refuses entropy below the NIST SP 800-63B floor', () => {
    expect(() => randomToken(8)).toThrow(RangeError);
    expect(() => randomToken(16)).not.toThrow();
  });

  it('produces distinct values', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(seen.size).toBe(200);
  });
});

describe('optional Argon2id hashers', () => {
  // Bun's own Argon2id, available with no install step. The point of the adapter
  // is that swapping to it is a one-line change with no migration.
  it('round-trips through bunPasswordHasher on Bun', async () => {
    const { bunPasswordHasher } = await import('../src/adapters/argon2.ts');
    const hasher = bunPasswordHasher({ memoryCost: 1_024, timeCost: 1 });

    const encoded = await hasher.hash('correct horse battery staple');
    expect(encoded.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify('correct horse battery staple', encoded)).toBe(true);
    expect(await hasher.verify('wrong', encoded)).toBe(false);
    expect(await hasher.verifyDummy('anything')).toBe(false);
  });

  it('flags a PBKDF2 hash as needing an upgrade', async () => {
    const { bunPasswordHasher } = await import('../src/adapters/argon2.ts');
    const argon = bunPasswordHasher({ memoryCost: 1_024, timeCost: 1 });
    const legacy = await pbkdf2Hasher({ iterations: 1_000 }).hash('pw');

    expect(argon.needsRehash(legacy)).toBe(true);
    expect(argon.needsRehash(await argon.hash('pw'))).toBe(false);
    // And a foreign hash simply does not verify, rather than throwing.
    expect(await argon.verify('pw', legacy)).toBe(false);
  });
});
