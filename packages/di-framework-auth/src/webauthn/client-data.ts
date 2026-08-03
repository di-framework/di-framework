import { base64UrlDecode } from '../crypto/base64url.ts';
import { timingSafeEqual } from '../crypto/compare.ts';
import { strictDecoder } from '../crypto/webcrypto.ts';
import { AuthError } from '../errors.ts';

/** clientDataJSON parsing and validation (WebAuthn Level 3 §5.8.1, §7.1, §7.2). */

export interface ParsedClientData {
  type: string;
  /** base64url, exactly as the authenticator signed it. */
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
  topOrigin?: string;
  raw: string;
  bytes: Uint8Array;
}

export interface ClientDataExpectations {
  type: 'webauthn.create' | 'webauthn.get';
  /** The challenge we issued, base64url encoded. */
  challenge: string;
  /** Full origins, e.g. `https://app.example.com`. Compared exactly. */
  origins: readonly string[];
  allowCrossOrigin?: boolean;
  topOrigins?: readonly string[];
}

function reject(
  message: string,
  code: 'origin_mismatch' | 'malformed_credential' | 'challenge_not_found',
): never {
  throw new AuthError(message, { code, status: 400 });
}

export function parseClientData(bytes: Uint8Array): ParsedClientData {
  let raw: string;
  try {
    raw = strictDecoder().decode(bytes);
  } catch {
    reject('clientDataJSON is not valid UTF-8', 'malformed_credential');
  }
  // A BOM would make the bytes we hash differ from the bytes we parsed.
  if (raw.charCodeAt(0) === 0xfeff)
    reject('clientDataJSON starts with a BOM', 'malformed_credential');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject('clientDataJSON is not valid JSON', 'malformed_credential');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reject('clientDataJSON is not a JSON object', 'malformed_credential');
  }

  const data = parsed as Record<string, unknown>;
  if (typeof data['type'] !== 'string')
    reject('clientDataJSON has no type', 'malformed_credential');
  if (typeof data['challenge'] !== 'string')
    reject('clientDataJSON has no challenge', 'malformed_credential');
  if (typeof data['origin'] !== 'string')
    reject('clientDataJSON has no origin', 'malformed_credential');

  return {
    type: data['type'],
    challenge: data['challenge'],
    origin: data['origin'],
    ...(typeof data['crossOrigin'] === 'boolean' ? { crossOrigin: data['crossOrigin'] } : {}),
    ...(typeof data['topOrigin'] === 'string' ? { topOrigin: data['topOrigin'] } : {}),
    raw,
    bytes,
  };
}

/** Normalise an origin string by parsing and re-serialising it. */
export function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export async function verifyClientData(
  parsed: ParsedClientData,
  expected: ClientDataExpectations,
): Promise<void> {
  // Exact string equality. Accepting `webauthn.create` where `webauthn.get` is
  // expected would let a registration ceremony's signature be replayed as an
  // authentication assertion.
  if (parsed.type !== expected.type) {
    reject(
      `clientDataJSON type is '${parsed.type}', expected '${expected.type}'`,
      'malformed_credential',
    );
  }

  // Compare the decoded bytes, not the strings: a client that pads its base64url
  // would produce a different string for the same challenge.
  let actualChallenge: Uint8Array;
  let expectedChallenge: Uint8Array;
  try {
    actualChallenge = base64UrlDecode(parsed.challenge);
    expectedChallenge = base64UrlDecode(expected.challenge);
  } catch {
    reject('Challenge is not valid base64url', 'malformed_credential');
  }
  if (!(await timingSafeEqual(actualChallenge, expectedChallenge))) {
    reject('Challenge does not match the one issued', 'challenge_not_found');
  }

  // Exact origin match against a normalised allowlist.
  //
  // Never `endsWith`: `https://evil-example.com` ends with `example.com`.
  // Never `startsWith`: `https://example.com.attacker.net` starts with it.
  // Never a regex: the dots are the part that matters and they are metacharacters.
  const actualOrigin = normalizeOrigin(parsed.origin);
  if (!actualOrigin)
    reject(`clientDataJSON origin '${parsed.origin}' is not a valid URL`, 'origin_mismatch');
  const permitted = expected.origins
    .map(normalizeOrigin)
    .filter((value): value is string => value !== null);
  if (!permitted.includes(actualOrigin)) {
    reject(
      `clientDataJSON origin '${actualOrigin}' is not one of [${permitted.join(', ')}]`,
      'origin_mismatch',
    );
  }

  if (parsed.crossOrigin === true && expected.allowCrossOrigin !== true) {
    reject('Ceremony was performed in a cross-origin iframe', 'origin_mismatch');
  }

  if (parsed.topOrigin !== undefined) {
    const topOrigin = normalizeOrigin(parsed.topOrigin);
    const permittedTop = (expected.topOrigins ?? []).map(normalizeOrigin);
    if (!topOrigin || !permittedTop.includes(topOrigin)) {
      reject(`clientDataJSON topOrigin '${parsed.topOrigin}' is not permitted`, 'origin_mismatch');
    }
  }

  // `tokenBinding` is deprecated in Level 3 and deliberately ignored.
}
