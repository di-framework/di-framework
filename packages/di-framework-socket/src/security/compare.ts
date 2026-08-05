import { randomBytes } from './bytes.ts';
import { buf, type KeyUsage, subtle } from './webcrypto.ts';

/**
 * Length-independent, timing-safe equality via HMAC blinding.
 *
 * Same rationale as `@di-framework/auth`: a hand-rolled XOR loop is not
 * reliably constant-time under a JS JIT.
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
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}
