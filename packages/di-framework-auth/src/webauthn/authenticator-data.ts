import { base64UrlEncode } from '../crypto/base64url.ts';
import { timingSafeEqual } from '../crypto/compare.ts';
import { sha256 } from '../crypto/hash.ts';
import { AuthError } from '../errors.ts';
import { type CborValue, decodeCborAt } from './cbor.ts';
import { type CoseKey, parseCoseKey } from './cose.ts';

/** Authenticator data parsing (WebAuthn Level 3 §6.1). */

export interface AuthenticatorDataFlags {
  /** User Present — the user interacted with the authenticator. */
  up: boolean;
  /** User Verified — a PIN, biometric, or equivalent was checked. */
  uv: boolean;
  /** Backup Eligible — the credential may be synced. Immutable per credential. */
  be: boolean;
  /** Backup State — the credential currently is backed up. May change over time. */
  bs: boolean;
  /** Attested credential data is present. */
  at: boolean;
  /** Extension data is present. */
  ed: boolean;
  raw: number;
}

export interface AttestedCredentialData {
  aaguid: Uint8Array;
  aaguidHex: string;
  credentialId: Uint8Array;
  credentialIdBase64Url: string;
  credentialPublicKey: Uint8Array;
  coseKey: CoseKey;
}

export interface ParsedAuthenticatorData {
  rpIdHash: Uint8Array;
  flags: AuthenticatorDataFlags;
  signCount: number;
  attestedCredentialData?: AttestedCredentialData;
  extensions?: Map<CborValue, CborValue>;
  bytes: Uint8Array;
}

/** rpIdHash(32) ‖ flags(1) ‖ signCount(4). */
const HEADER_BYTES = 37;
const AAGUID_BYTES = 16;
/** WebAuthn L3 §5.1: a credential id is at most 1023 bytes. */
const MAX_CREDENTIAL_ID_BYTES = 1023;

function malformed(message: string): never {
  throw new AuthError(message, { code: 'malformed_credential', status: 400 });
}

export function parseFlags(byte: number): AuthenticatorDataFlags {
  return {
    up: (byte & 0x01) !== 0,
    uv: (byte & 0x04) !== 0,
    be: (byte & 0x08) !== 0,
    bs: (byte & 0x10) !== 0,
    at: (byte & 0x40) !== 0,
    ed: (byte & 0x80) !== 0,
    raw: byte,
  };
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function parseAuthenticatorData(bytes: Uint8Array): ParsedAuthenticatorData {
  if (bytes.length < HEADER_BYTES) {
    malformed(`Authenticator data is ${bytes.length} bytes; at least ${HEADER_BYTES} are required`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rpIdHash = bytes.slice(0, 32);
  const flags = parseFlags(bytes[32]!);
  const signCount = view.getUint32(33, false);

  let offset = HEADER_BYTES;
  let attestedCredentialData: AttestedCredentialData | undefined;

  if (flags.at) {
    if (bytes.length < offset + AAGUID_BYTES + 2)
      malformed('Authenticator data claims attested credential data but is truncated');
    const aaguid = bytes.slice(offset, offset + AAGUID_BYTES);
    offset += AAGUID_BYTES;

    const credentialIdLength = view.getUint16(offset, false);
    offset += 2;
    if (credentialIdLength > MAX_CREDENTIAL_ID_BYTES)
      malformed(
        `Credential id length ${credentialIdLength} exceeds the ${MAX_CREDENTIAL_ID_BYTES}-byte maximum`,
      );
    if (bytes.length < offset + credentialIdLength)
      malformed('Authenticator data is truncated inside the credential id');
    const credentialId = bytes.slice(offset, offset + credentialIdLength);
    offset += credentialIdLength;

    // The COSE key is variable-length CBOR with no length prefix, so the only
    // way to find its end — and therefore where extension data begins — is to
    // decode it and ask how many bytes it consumed.
    const { value: _key, bytesRead } = decodeCborAt(bytes, offset);
    const credentialPublicKey = bytes.slice(offset, offset + bytesRead);
    offset += bytesRead;

    attestedCredentialData = {
      aaguid,
      aaguidHex: toHex(aaguid),
      credentialId,
      credentialIdBase64Url: base64UrlEncode(credentialId),
      credentialPublicKey,
      coseKey: parseCoseKey(credentialPublicKey),
    };
  }

  let extensions: Map<CborValue, CborValue> | undefined;
  if (flags.ed) {
    const { value, bytesRead } = decodeCborAt(bytes, offset);
    if (!(value instanceof Map)) malformed('Authenticator extension data is not a CBOR map');
    extensions = value;
    offset += bytesRead;
  }

  if (offset !== bytes.length) {
    // Unread bytes mean this structure can be interpreted two ways, and the
    // signature covers all of them.
    malformed(`Authenticator data has ${bytes.length - offset} trailing bytes`);
  }

  return {
    rpIdHash,
    flags,
    signCount,
    ...(attestedCredentialData ? { attestedCredentialData } : {}),
    ...(extensions ? { extensions } : {}),
    bytes,
  };
}

/** Constant-time comparison of the rpIdHash against SHA-256 of the expected RP ID. */
export async function rpIdHashMatches(rpIdHash: Uint8Array, rpId: string): Promise<boolean> {
  return timingSafeEqual(rpIdHash, await sha256(rpId));
}
