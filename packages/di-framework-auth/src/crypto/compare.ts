import { randomBytes } from './random.ts';
import { buf, type KeyUsage, subtle } from './webcrypto.ts';

/**
 * Length-independent, timing-safe equality.
 *
 * WebCrypto has no `timingSafeEqual`, and a hand-written constant-time XOR loop
 * is not actually constant-time in JavaScript: the JIT is free to specialise,
 * bounds-check elimination is data-dependent, and string comparison hits the
 * engine's interning fast paths. Instead we HMAC both inputs under a random
 * per-process key and compare the resulting 32-byte digests. An attacker cannot
 * predict the digests, so digest-comparison timing leaks nothing about the
 * inputs — and unlike a XOR loop this also hides the *length* of the operands.
 *
 * The key is generated lazily on first use and never leaves the process.
 */

const KEY_USAGES: readonly KeyUsage[] = ['sign'];

let blindingKey: Promise<CryptoKey> | undefined;

function getBlindingKey(): Promise<CryptoKey> {
  blindingKey ??= subtle.importKey(
    'raw',
    buf(randomBytes(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    KEY_USAGES as KeyUsage[],
  );
  return blindingKey;
}

async function blind(data: Uint8Array): Promise<Uint8Array> {
  const key = await getBlindingKey();
  return new Uint8Array(await subtle.sign('HMAC', key, buf(data)));
}

/** Timing-safe comparison of two byte strings. */
export async function timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const [da, db] = await Promise.all([blind(a), blind(b)]);
  // Both digests are always 32 bytes, so this loop is genuinely fixed-length.
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

/** Timing-safe comparison of two strings, compared as UTF-8. */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
