import { describe, expect, it, spyOn } from 'bun:test';
import { base64UrlEncode } from '../src/crypto/base64url.ts';
import { concatBytes, sha256 } from '../src/crypto/hash.ts';
import { randomToken } from '../src/crypto/random.ts';
import { AuthError } from '../src/errors.ts';
import {
  memoryCredentialStore,
  memoryStateStore,
  memoryUserStore,
} from '../src/providers/memory.ts';
import * as algorithms from '../src/tokens/algorithms.ts';
import { p1363ToDer } from '../src/tokens/jws.ts';
import { parseAuthenticatorData, parseFlags } from '../src/webauthn/authenticator-data.ts';
import {
  asCborMap,
  CborError,
  cborBytes,
  cborInt,
  cborText,
  decodeCbor,
  decodeCborAt,
} from '../src/webauthn/cbor.ts';
import { normalizeOrigin, parseClientData, verifyClientData } from '../src/webauthn/client-data.ts';
import {
  COSE_ALG,
  DEFAULT_PUBKEY_CRED_PARAMS,
  importCoseKey,
  parseCoseKey,
  verifyCoseSignature,
} from '../src/webauthn/cose.ts';
import { webAuthnService } from '../src/webauthn/service.ts';
import type { WebAuthnConfig } from '../src/webauthn/types.ts';

/* -------------------------------------------------------------------------- */
/* CBOR                                                                       */
/* -------------------------------------------------------------------------- */

const bytes = (...values: number[]) => new Uint8Array(values);

describe('CBOR decoder', () => {
  it('decodes the primitives WebAuthn uses', () => {
    expect(decodeCbor(bytes(0x00))).toBe(0);
    expect(decodeCbor(bytes(0x17))).toBe(23);
    expect(decodeCbor(bytes(0x18, 0x18))).toBe(24);
    expect(decodeCbor(bytes(0x20))).toBe(-1);
    expect(decodeCbor(bytes(0x38, 0x18))).toBe(-25); // COSE alg -25
    expect(decodeCbor(bytes(0x43, 0x01, 0x02, 0x03))).toEqual(bytes(1, 2, 3));
    expect(decodeCbor(bytes(0x63, 0x66, 0x6d, 0x74))).toBe('fmt');
    expect(decodeCbor(bytes(0x82, 0x01, 0x02))).toEqual([1, 2]);
    expect(decodeCbor(bytes(0xf4))).toBe(false);
    expect(decodeCbor(bytes(0xf5))).toBe(true);
  });

  it('decodes a map with canonical keys', () => {
    // {1: 2, 3: 4}
    const map = decodeCbor(bytes(0xa2, 0x01, 0x02, 0x03, 0x04));
    expect(map).toBeInstanceOf(Map);
    expect((map as Map<unknown, unknown>).get(1)).toBe(2);
  });

  // These limits are load-bearing: an attestation object arrives from an
  // untrusted client before any signature has been checked.
  it('rejects indefinite lengths', () => {
    expect(() => decodeCbor(bytes(0x5f, 0x41, 0x01, 0xff))).toThrow(/Indefinite-length/);
  });

  it('rejects non-canonical integer encodings', () => {
    // 0x18 0x05 encodes 5 in one byte where the immediate form exists.
    expect(() => decodeCbor(bytes(0x18, 0x05))).toThrow(/Non-canonical/);
    expect(() => decodeCbor(bytes(0x19, 0x00, 0x05))).toThrow(/Non-canonical/);
  });

  it('rejects duplicate map keys', () => {
    expect(() => decodeCbor(bytes(0xa2, 0x01, 0x02, 0x01, 0x03))).toThrow(/Duplicate/);
  });

  it('rejects map keys out of canonical order', () => {
    expect(() => decodeCbor(bytes(0xa2, 0x03, 0x04, 0x01, 0x02))).toThrow(/canonical order/);
  });

  it('rejects tags and floats', () => {
    expect(() => decodeCbor(bytes(0xc0, 0x00))).toThrow(/tags are not accepted/);
    expect(() => decodeCbor(bytes(0xfa, 0, 0, 0, 0))).toThrow(/floating-point/);
  });

  it('rejects a declared length that overruns the buffer', () => {
    expect(() => decodeCbor(bytes(0x58, 0xff, 0x01))).toThrow(/Truncated/);
  });

  it('rejects a depth bomb', () => {
    // 40 nested single-element arrays.
    const bomb = new Uint8Array(41).fill(0x81);
    bomb[40] = 0x00;
    expect(() => decodeCbor(bomb)).toThrow(/depth limit/);
  });

  it('rejects trailing data', () => {
    expect(() => decodeCbor(bytes(0x01, 0x02))).toThrow(CborError);
  });

  it('reports how many bytes an item consumed', () => {
    // Needed to find where a COSE key ends inside attested credential data.
    const buffer = bytes(0xa1, 0x01, 0x02, 0xff, 0xff);
    const { value, bytesRead } = decodeCborAt(buffer, 0);
    expect(bytesRead).toBe(3);
    expect((value as Map<unknown, unknown>).get(1)).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Authenticator data                                                         */
/* -------------------------------------------------------------------------- */

function buildAuthData(options: {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; coseKey: Uint8Array };
}): Uint8Array {
  const header = new Uint8Array(37);
  header.set(options.rpIdHash, 0);
  header[32] = options.flags;
  new DataView(header.buffer).setUint32(33, options.signCount, false);
  if (!options.attested) return header;

  const lengthBytes = new Uint8Array(2);
  new DataView(lengthBytes.buffer).setUint16(0, options.attested.credentialId.length, false);
  return concatBytes(
    header,
    options.attested.aaguid,
    lengthBytes,
    options.attested.credentialId,
    options.attested.coseKey,
  );
}

/** A canonical CBOR-encoded COSE_Key for a P-256 public key. */
function coseP256(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concatBytes(
    bytes(0xa5), // map(5)
    bytes(0x01, 0x02), // kty: 2 (EC2)
    bytes(0x03, 0x26), // alg: -7
    bytes(0x20, 0x01), // crv: 1 (P-256)
    bytes(0x21, 0x58, 0x20),
    x,
    bytes(0x22, 0x58, 0x20),
    y,
  );
}

describe('authenticator data', () => {
  it('parses flags', () => {
    const flags = parseFlags(0x01 | 0x04 | 0x08 | 0x10 | 0x40);
    expect(flags).toMatchObject({ up: true, uv: true, be: true, bs: true, at: true, ed: false });
  });

  it('parses a header-only structure', () => {
    const parsed = parseAuthenticatorData(
      buildAuthData({ rpIdHash: new Uint8Array(32).fill(1), flags: 0x05, signCount: 42 }),
    );
    expect(parsed.signCount).toBe(42);
    expect(parsed.flags.up).toBe(true);
    expect(parsed.flags.uv).toBe(true);
    expect(parsed.attestedCredentialData).toBeUndefined();
  });

  it('parses attested credential data, finding the end of the COSE key', () => {
    const credentialId = new Uint8Array(16).fill(9);
    const coseKey = coseP256(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3));
    const parsed = parseAuthenticatorData(
      buildAuthData({
        rpIdHash: new Uint8Array(32),
        flags: 0x41,
        signCount: 1,
        attested: { aaguid: new Uint8Array(16).fill(7), credentialId, coseKey },
      }),
    );

    expect(parsed.attestedCredentialData!.credentialId).toEqual(credentialId);
    expect(parsed.attestedCredentialData!.credentialPublicKey).toEqual(coseKey);
    expect(parsed.attestedCredentialData!.coseKey.alg).toBe(COSE_ALG.ES256);
    expect(parsed.attestedCredentialData!.aaguidHex).toBe('07'.repeat(16));
  });

  it('rejects a truncated structure', () => {
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow(AuthError);
  });

  it('rejects trailing bytes', () => {
    const valid = buildAuthData({ rpIdHash: new Uint8Array(32), flags: 0x01, signCount: 0 });
    expect(() => parseAuthenticatorData(concatBytes(valid, bytes(0)))).toThrow(/trailing bytes/);
  });

  it('rejects truncated attested credential data and oversized credential ids', () => {
    const header = buildAuthData({
      rpIdHash: new Uint8Array(32),
      flags: 0x40,
      signCount: 0,
    });
    expect(() => parseAuthenticatorData(header)).toThrow(/truncated/);

    const short = new Uint8Array(37 + 16 + 2);
    short.set(header, 0);
    short[32] = 0x40;
    new DataView(short.buffer).setUint16(37 + 16, 1024, false);
    expect(() => parseAuthenticatorData(short)).toThrow(/1023-byte maximum/);

    const truncatedId = new Uint8Array(37 + 16 + 2 + 4);
    truncatedId.set(header, 0);
    truncatedId[32] = 0x40;
    new DataView(truncatedId.buffer).setUint16(37 + 16, 32, false);
    expect(() => parseAuthenticatorData(truncatedId)).toThrow(/truncated inside the credential id/);
  });

  it('parses extension data when the ED flag is set', () => {
    const extensions = bytes(0xa0); // empty map
    const parsed = parseAuthenticatorData(
      concatBytes(
        buildAuthData({ rpIdHash: new Uint8Array(32).fill(1), flags: 0x80, signCount: 0 }),
        extensions,
      ),
    );
    expect(parsed.extensions).toBeInstanceOf(Map);
    expect(() =>
      parseAuthenticatorData(
        concatBytes(
          buildAuthData({ rpIdHash: new Uint8Array(32), flags: 0x80, signCount: 0 }),
          bytes(0x01),
        ),
      ),
    ).toThrow(/extension data is not a CBOR map/);
  });
});

describe('CBOR typed accessors', () => {
  it('reads and rejects typed map members', () => {
    expect(() => asCborMap(1, 'x')).toThrow(/not a CBOR map/);
    const map = new Map<unknown, unknown>([
      ['b', bytes(1, 2)],
      ['t', 'hi'],
      ['i', 7],
    ]);
    expect(cborBytes(map as never, 'b', 'b')).toEqual(bytes(1, 2));
    expect(() => cborBytes(map as never, 't', 't')).toThrow(/byte string/);
    expect(cborText(map as never, 't', 't')).toBe('hi');
    expect(() => cborText(map as never, 'b', 'b')).toThrow(/text string/);
    expect(cborInt(map as never, 'i', 'i')).toBe(7);
    expect(() => cborInt(map as never, 't', 't')).toThrow(/integer/);
  });
});

describe('COSE keys extended', () => {
  function coseOkp(x: Uint8Array): Uint8Array {
    return concatBytes(
      bytes(0xa4),
      bytes(0x01, 0x01), // kty: OKP
      bytes(0x03, 0x27), // alg: -8
      bytes(0x20, 0x06), // crv: Ed25519
      bytes(0x21, 0x58, 0x20),
      x,
    );
  }

  function coseRsa(n: Uint8Array, e: Uint8Array): Uint8Array {
    // alg -257 → CBOR negative int with 16-bit value 256 → 0x39 0x01 0x00
    const nHeader =
      n.length < 24
        ? bytes(0x20, 0x40 + n.length)
        : n.length < 256
          ? bytes(0x20, 0x58, n.length)
          : bytes(0x20, 0x59, (n.length >> 8) & 0xff, n.length & 0xff);
    return concatBytes(
      bytes(0xa4),
      bytes(0x01, 0x03), // kty: RSA
      bytes(0x03, 0x39, 0x01, 0x00), // alg: -257
      nHeader,
      n,
      bytes(0x21, 0x40 + e.length),
      e,
    );
  }

  it('parses OKP and RSA keys and rejects malformed ones', () => {
    const okp = parseCoseKey(coseOkp(new Uint8Array(32).fill(9)));
    expect(okp.kty).toBe(1);
    expect(okp.alg).toBe(COSE_ALG.EdDSA);
    expect(okp.x).toHaveLength(32);

    const rsa = parseCoseKey(coseRsa(new Uint8Array(256).fill(1), bytes(0x01, 0x00, 0x01)));
    expect(rsa.kty).toBe(3);
    expect(rsa.alg).toBe(COSE_ALG.RS256);
    expect(rsa.n).toHaveLength(256);

    expect(() => parseCoseKey(bytes(0xa2, 0x01, 0x18, 0x63, 0x03, 0x26))).toThrow(
      /Unsupported COSE key type/,
    );
    expect(() => parseCoseKey(concatBytes(bytes(0xa2, 0x01, 0x02, 0x03, 0x26)))).toThrow(/no crv/);
    expect(() => parseCoseKey(concatBytes(bytes(0xa2, 0x01, 0x01, 0x03, 0x27)))).toThrow(/no crv/);
  });

  it('imports ES256/RS256 keys and verifies signatures', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const cose = parseCoseKey(coseP256(decode(jwk.x!), decode(jwk.y!)));
    await expect(importCoseKey(cose)).resolves.toBeInstanceOf(CryptoKey);

    const data = new TextEncoder().encode('signed');
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data),
    );
    expect(await verifyCoseSignature(cose, p1363ToDer(raw), data)).toBe(true);
    expect(await verifyCoseSignature(cose, raw, data)).toBe(true);

    const shortCoords = concatBytes(
      bytes(0xa5),
      bytes(0x01, 0x02),
      bytes(0x03, 0x26),
      bytes(0x20, 0x01),
      bytes(0x21, 0x50),
      new Uint8Array(16).fill(1),
      bytes(0x22, 0x50),
      new Uint8Array(16).fill(2),
    );
    await expect(importCoseKey(parseCoseKey(shortCoords))).rejects.toThrow(/32 bytes/);

    const shortRsa = parseCoseKey(coseRsa(new Uint8Array(128).fill(1), bytes(0x01, 0x00, 0x01)));
    await expect(importCoseKey(shortRsa)).rejects.toThrow(/2048/);

    const rsaPair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const rsaJwk = (await crypto.subtle.exportKey('jwk', rsaPair.publicKey)) as JsonWebKey;
    const rsaCose = parseCoseKey(coseRsa(decode(rsaJwk.n!), decode(rsaJwk.e!)));
    const rsaSig = new Uint8Array(
      await crypto.subtle.sign('RSASSA-PKCS1-v1_5', rsaPair.privateKey, data),
    );
    expect(await verifyCoseSignature(rsaCose, rsaSig, data)).toBe(true);

    const ed = parseCoseKey(coseOkp(new Uint8Array(32).fill(3)));
    try {
      await importCoseKey(ed);
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
    }

    // ES256 requires EC2/P-256.
    const esOnOkp = parseCoseKey(
      concatBytes(
        bytes(0xa4),
        bytes(0x01, 0x01),
        bytes(0x03, 0x26),
        bytes(0x20, 0x06),
        bytes(0x21, 0x58, 0x20),
        new Uint8Array(32),
      ),
    );
    await expect(importCoseKey(esOnOkp)).rejects.toThrow(/requires an EC2 key on P-256/);

    // Real Ed25519 round-trip.
    const edPair = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const edJwk = (await crypto.subtle.exportKey('jwk', edPair.publicKey)) as JsonWebKey;
    const edCose = parseCoseKey(coseOkp(decode(edJwk.x!)));
    const edSig = new Uint8Array(await crypto.subtle.sign('Ed25519', edPair.privateKey, data));
    expect(await verifyCoseSignature(edCose, edSig, data)).toBe(true);

    const edWrongCurve = parseCoseKey(
      concatBytes(
        bytes(0xa4),
        bytes(0x01, 0x01),
        bytes(0x03, 0x27),
        bytes(0x20, 0x01),
        bytes(0x21, 0x58, 0x20),
        new Uint8Array(32),
      ),
    );
    await expect(importCoseKey(edWrongCurve)).rejects.toThrow(/requires an OKP key on Ed25519/);

    const unsupportedSpy = spyOn(algorithms, 'isAlgorithmSupported').mockResolvedValue(false);
    try {
      await expect(importCoseKey(edCose)).rejects.toThrow(/cannot verify Ed25519/);
    } finally {
      unsupportedSpy.mockRestore();
    }
  });
});

describe('COSE keys', () => {
  it('parses a P-256 key', () => {
    const key = parseCoseKey(coseP256(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)));
    expect(key.kty).toBe(2);
    expect(key.alg).toBe(COSE_ALG.ES256);
    expect(key.x).toHaveLength(32);
  });

  // Registration-time algorithm choice is a one-way door for that credential:
  // offering an algorithm this runtime cannot verify creates a passkey the user
  // can register and never use.
  it('omits EdDSA from the default offered algorithms', () => {
    expect(DEFAULT_PUBKEY_CRED_PARAMS).toEqual([COSE_ALG.ES256, COSE_ALG.RS256]);
    expect(DEFAULT_PUBKEY_CRED_PARAMS).not.toContain(COSE_ALG.EdDSA);
  });
});

/* -------------------------------------------------------------------------- */
/* clientDataJSON                                                             */
/* -------------------------------------------------------------------------- */

describe('clientDataJSON', () => {
  const challenge = base64UrlEncode(new Uint8Array(32).fill(5));
  const build = (overrides: Record<string, unknown> = {}) =>
    parseClientData(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge,
          origin: 'https://app.example.com',
          ...overrides,
        }),
      ),
    );
  const expected = {
    type: 'webauthn.get' as const,
    challenge,
    origins: ['https://app.example.com'],
  };

  it('accepts a well-formed structure', async () => {
    await expect(verifyClientData(build(), expected)).resolves.toBeUndefined();
  });

  // Accepting the wrong ceremony type lets a registration signature be replayed
  // as an authentication assertion.
  it('rejects the wrong ceremony type', async () => {
    await expect(verifyClientData(build({ type: 'webauthn.create' }), expected)).rejects.toThrow(
      /type is 'webauthn.create'/,
    );
  });

  it('rejects a challenge that was not the one issued', async () => {
    await expect(
      verifyClientData(build({ challenge: base64UrlEncode(new Uint8Array(32).fill(6)) }), expected),
    ).rejects.toThrow(/Challenge does not match/);
  });

  // The bypasses a substring check would allow.
  it('matches the origin exactly', async () => {
    for (const origin of [
      'https://evil-app.example.com',
      'https://app.example.com.attacker.net',
      'http://app.example.com',
      'https://app.example.com:8443',
    ]) {
      await expect(verifyClientData(build({ origin }), expected)).rejects.toThrow(/is not one of/);
    }
  });

  it('rejects a cross-origin ceremony unless permitted', async () => {
    await expect(verifyClientData(build({ crossOrigin: true }), expected)).rejects.toThrow(
      /cross-origin iframe/,
    );
    await expect(
      verifyClientData(build({ crossOrigin: true }), { ...expected, allowCrossOrigin: true }),
    ).resolves.toBeUndefined();
  });

  it('rejects an unexpected topOrigin', async () => {
    await expect(
      verifyClientData(build({ topOrigin: 'https://embedder.example' }), expected),
    ).rejects.toThrow(/topOrigin/);
  });

  it('rejects malformed input', () => {
    expect(() => parseClientData(new TextEncoder().encode('not json'))).toThrow(AuthError);
    expect(() => parseClientData(new TextEncoder().encode('[]'))).toThrow(/not a JSON object/);
    expect(() => parseClientData(new TextEncoder().encode('{"type":"x"}'))).toThrow(/challenge/);
  });

  it('rejects invalid UTF-8, BOM, bad challenge encoding, and invalid origins', async () => {
    expect(() => parseClientData(bytes(0xff, 0xfe))).toThrow(/UTF-8/);
    expect(() =>
      parseClientData(concatBytes(bytes(0xef, 0xbb, 0xbf), new TextEncoder().encode('{}'))),
    ).toThrow(/BOM/);

    await expect(verifyClientData(build({ challenge: 'not!base64url' }), expected)).rejects.toThrow(
      /base64url/,
    );

    await expect(verifyClientData(build({ origin: 'not a url' }), expected)).rejects.toThrow(
      /not a valid URL/,
    );

    expect(normalizeOrigin(':::')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Ceremonies                                                                 */
/* -------------------------------------------------------------------------- */

const RP_ID = 'example.com';
const ORIGIN = 'https://app.example.com';

async function buildService(overrides: Partial<WebAuthnConfig> = {}) {
  const users = memoryUserStore();
  const credentials = memoryCredentialStore();
  const state = memoryStateStore();
  const user = await users.create({
    id: 'u1',
    identifier: 'ada@example.com',
    createdAt: 0,
    webauthnUserHandle: randomToken(32),
  });
  const config: WebAuthnConfig = {
    rpId: RP_ID,
    rpName: 'Example',
    origins: [ORIGIN],
    ...overrides,
  };
  return {
    users,
    credentials,
    state,
    user,
    service: webAuthnService({ config, credentials, state, users }),
  };
}

/** Produce a real ES256 assertion the way an authenticator would. */
async function signAssertion(input: {
  privateKey: CryptoKey;
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
}): Promise<Uint8Array> {
  const signed = concatBytes(input.authData, await sha256(input.clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      input.privateKey,
      signed as BufferSource,
    ),
  );
  // Authenticators emit DER, which is the encoding this package must convert.
  return p1363ToDer(raw);
}

describe('WebAuthn registration options', () => {
  it('never puts personally identifying information in the user handle', async () => {
    const { service, user } = await buildService();
    const ceremony = await service.generateRegistrationOptions({
      userId: 'u1',
      username: 'ada@example.com',
    });
    // WebAuthn L3 §5.4.3 forbids PII here. The API takes a userId and derives
    // the handle itself, so a caller cannot pass an email by mistake.
    expect(ceremony.options.user.id).toBe(user.webauthnUserHandle!);
    expect(ceremony.options.user.id).not.toContain('ada');
    expect(ceremony.options.user.name).toBe('ada@example.com');
  });

  it('offers only algorithms this runtime can verify', async () => {
    const { service } = await buildService();
    const ceremony = await service.generateRegistrationOptions({ userId: 'u1', username: 'ada' });
    expect(ceremony.options.pubKeyCredParams.map((entry) => entry.alg)).toEqual([-7, -257]);
  });

  it('refuses a challenge below the spec minimum', async () => {
    await expect(buildService({ challengeBytes: 8 })).rejects.toThrow(/at least 16/);
  });
});

describe('WebAuthn authentication', () => {
  async function register() {
    const context = await buildService();
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

    const credentialId = crypto.getRandomValues(new Uint8Array(32));
    await context.credentials.saveWebAuthn({
      kind: 'webauthn',
      id: base64UrlEncode(credentialId),
      userId: 'u1',
      publicKeyCose: base64UrlEncode(coseP256(decode(jwk.x!), decode(jwk.y!))),
      algorithm: COSE_ALG.ES256,
      signCount: 5,
      backupEligible: false,
      backupState: false,
      uvInitialized: true,
      createdAt: 0,
      version: 0,
    });
    return { ...context, pair, credentialId };
  }

  async function assertion(
    context: Awaited<ReturnType<typeof register>>,
    options: { signCount: number; flags?: number; challenge?: string },
  ) {
    const ceremony = await context.service.generateAuthenticationOptions({ userId: 'u1' });
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge ?? ceremony.options.challenge,
        origin: ORIGIN,
      }),
    );
    const authData = buildAuthData({
      rpIdHash: await sha256(RP_ID),
      flags: options.flags ?? 0x05,
      signCount: options.signCount,
    });
    const signature = await signAssertion({
      privateKey: context.pair.privateKey,
      authData,
      clientDataJSON,
    });

    return {
      challengeKey: ceremony.challengeKey,
      response: {
        id: base64UrlEncode(context.credentialId),
        rawId: base64UrlEncode(context.credentialId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: base64UrlEncode(clientDataJSON),
          authenticatorData: base64UrlEncode(authData),
          signature: base64UrlEncode(signature),
        },
      },
    };
  }

  it('verifies a genuine assertion and converts the DER signature', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, { signCount: 6 });
    const verified = await context.service.verifyAuthenticationResponse(response, { challengeKey });

    expect(verified.userId).toBe('u1');
    expect(verified.newSignCount).toBe(6);
    expect(verified.signCountSupported).toBe(true);
    expect(verified.cloneWarning).toBe(false);
    expect(verified.principal.method).toBe('webauthn');
    expect(verified.principal.amr).toEqual(['hwk', 'user', 'mfa']);
  });

  it('rejects a replayed challenge', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, { signCount: 6 });
    await context.service.verifyAuthenticationResponse(response, { challengeKey });
    // The challenge was consumed; the very same response must not work twice.
    await expect(
      context.service.verifyAuthenticationResponse(response, { challengeKey }),
    ).rejects.toThrow(/expired or was already used/);
  });

  it('rejects a challenge the client did not receive from us', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, {
      signCount: 6,
      challenge: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))),
    });
    await expect(
      context.service.verifyAuthenticationResponse(response, { challengeKey }),
    ).rejects.toThrow(/Challenge does not match/);
  });

  // The spec says a regression SHOULD be treated as a cloned authenticator.
  it('detects a sign-count regression', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, { signCount: 4 });
    await expect(
      context.service.verifyAuthenticationResponse(response, { challengeKey }),
    ).rejects.toThrow(/may have been cloned/);
  });

  // The common case for platform passkeys — iCloud Keychain, Google Password
  // Manager, and Windows Hello do not implement a counter.
  it('accepts a stored and received count of zero', async () => {
    const context = await register();
    await context.credentials.updateSignCount(base64UrlEncode(context.credentialId), 0, 0, 0);
    const { challengeKey, response } = await assertion(context, { signCount: 0 });
    const verified = await context.service.verifyAuthenticationResponse(response, { challengeKey });
    expect(verified.signCountSupported).toBe(false);
    expect(verified.cloneWarning).toBe(false);
  });

  // Backup eligibility is immutable for the life of a credential (L3 §6.1.3).
  it('rejects a change in backup eligibility', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, {
      signCount: 6,
      flags: 0x05 | 0x08,
    });
    await expect(
      context.service.verifyAuthenticationResponse(response, { challengeKey }),
    ).rejects.toThrow(/Backup eligibility changed/);
  });

  it('rejects an assertion signed for a different origin', async () => {
    const context = await register();
    const ceremony = await context.service.generateAuthenticationOptions({ userId: 'u1' });
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: ceremony.options.challenge,
        origin: 'https://evil.example.com',
      }),
    );
    const authData = buildAuthData({ rpIdHash: await sha256(RP_ID), flags: 0x05, signCount: 6 });
    const signature = await signAssertion({
      privateKey: context.pair.privateKey,
      authData,
      clientDataJSON,
    });

    await expect(
      context.service.verifyAuthenticationResponse(
        {
          id: base64UrlEncode(context.credentialId),
          rawId: base64UrlEncode(context.credentialId),
          type: 'public-key',
          response: {
            clientDataJSON: base64UrlEncode(clientDataJSON),
            authenticatorData: base64UrlEncode(authData),
            signature: base64UrlEncode(signature),
          },
        },
        { challengeKey: ceremony.challengeKey },
      ),
    ).rejects.toThrow(/is not one of/);
  });

  it('rejects an assertion for an unknown credential', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, { signCount: 6 });
    await expect(
      context.service.verifyAuthenticationResponse(
        { ...response, id: base64UrlEncode(new Uint8Array(32).fill(0xaa)) },
        { challengeKey },
      ),
    ).rejects.toThrow(/not recognised/);
  });

  it('rejects a credential outside the set the ceremony allowed', async () => {
    const context = await register();
    // A second credential belonging to a different user: it exists, so the
    // lookup succeeds, and only the allow-list check can reject it.
    const otherId = base64UrlEncode(new Uint8Array(32).fill(0xbb));
    await context.credentials.saveWebAuthn({
      kind: 'webauthn',
      id: otherId,
      userId: 'u2',
      publicKeyCose: base64UrlEncode(coseP256(new Uint8Array(32), new Uint8Array(32))),
      algorithm: COSE_ALG.ES256,
      signCount: 0,
      backupEligible: false,
      backupState: false,
      uvInitialized: false,
      createdAt: 0,
      version: 0,
    });

    const { challengeKey, response } = await assertion(context, { signCount: 6 });
    await expect(
      context.service.verifyAuthenticationResponse({ ...response, id: otherId }, { challengeKey }),
    ).rejects.toThrow(/not among those allowed/);
  });

  it('rejects a tampered signature', async () => {
    const context = await register();
    const { challengeKey, response } = await assertion(context, { signCount: 6 });
    const tampered = {
      ...response,
      response: { ...response.response, signature: base64UrlEncode(new Uint8Array(70).fill(1)) },
    };
    await expect(
      context.service.verifyAuthenticationResponse(tampered, { challengeKey }),
    ).rejects.toThrow(AuthError);
  });

  it('covers remaining authentication branches', async () => {
    const context = await register();

    // Disabled credential.
    await context.credentials.saveWebAuthn({
      ...(await context.credentials.findWebAuthn(base64UrlEncode(context.credentialId)))!,
      disabled: true,
    });
    {
      const { challengeKey, response } = await assertion(context, { signCount: 6 });
      await expect(
        context.service.verifyAuthenticationResponse(response, { challengeKey }),
      ).rejects.toThrow(/disabled/);
    }
    await context.credentials.saveWebAuthn({
      ...(await context.credentials.findWebAuthn(base64UrlEncode(context.credentialId)))!,
      disabled: false,
    });

    // User-handle mismatch on discoverable flow.
    {
      const ceremony = await context.service.generateAuthenticationOptions();
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x05,
        signCount: 6,
      });
      const signature = await signAssertion({
        privateKey: context.pair.privateKey,
        authData,
        clientDataJSON,
      });
      await expect(
        context.service.verifyAuthenticationResponse(
          {
            id: base64UrlEncode(context.credentialId),
            rawId: base64UrlEncode(context.credentialId),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(signature),
              userHandle: 'unknown-handle',
            },
          },
          { challengeKey: ceremony.challengeKey },
        ),
      ).rejects.toThrow(/User handle/);
    }

    // Wrong rpId hash.
    {
      const { challengeKey, response } = await assertion(context, { signCount: 6 });
      const badAuth = buildAuthData({
        rpIdHash: new Uint8Array(32).fill(9),
        flags: 0x05,
        signCount: 6,
      });
      await expect(
        context.service.verifyAuthenticationResponse(
          {
            ...response,
            response: { ...response.response, authenticatorData: base64UrlEncode(badAuth) },
          },
          { challengeKey },
        ),
      ).rejects.toThrow(/rpIdHash/);
    }

    // Missing UP.
    {
      const { challengeKey, response } = await assertion(context, {
        signCount: 6,
        flags: 0x00,
      });
      await expect(
        context.service.verifyAuthenticationResponse(response, { challengeKey }),
      ).rejects.toThrow(/User presence/);
    }

    // UV required.
    {
      const uvService = await buildService({ requireUserVerification: true });
      const jwk = (await crypto.subtle.exportKey('jwk', context.pair.publicKey)) as JsonWebKey;
      const decode = (value: string) =>
        Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      await uvService.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(context.credentialId),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(coseP256(decode(jwk.x!), decode(jwk.y!))),
        algorithm: COSE_ALG.ES256,
        signCount: 5,
        backupEligible: false,
        backupState: false,
        uvInitialized: true,
        createdAt: 0,
        version: 0,
      });
      const ceremony = await uvService.service.generateAuthenticationOptions({ userId: 'u1' });
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x01,
        signCount: 6,
      });
      const signature = await signAssertion({
        privateKey: context.pair.privateKey,
        authData,
        clientDataJSON,
      });
      await expect(
        uvService.service.verifyAuthenticationResponse(
          {
            id: base64UrlEncode(context.credentialId),
            rawId: base64UrlEncode(context.credentialId),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(signature),
            },
          },
          { challengeKey: ceremony.challengeKey },
        ),
      ).rejects.toThrow(/User verification was required/);
    }

    // Clone warning without throw.
    {
      const warn = await buildService({ onCloneDetected: 'warn' });
      const jwk = (await crypto.subtle.exportKey('jwk', context.pair.publicKey)) as JsonWebKey;
      const decode = (value: string) =>
        Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      await warn.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(context.credentialId),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(coseP256(decode(jwk.x!), decode(jwk.y!))),
        algorithm: COSE_ALG.ES256,
        signCount: 5,
        backupEligible: false,
        backupState: false,
        uvInitialized: true,
        createdAt: 0,
        version: 0,
      });
      const silence = console.warn;
      console.warn = () => undefined;
      try {
        const ceremony = await warn.service.generateAuthenticationOptions({ userId: 'u1' });
        const clientDataJSON = new TextEncoder().encode(
          JSON.stringify({
            type: 'webauthn.get',
            challenge: ceremony.options.challenge,
            origin: ORIGIN,
          }),
        );
        const authData = buildAuthData({
          rpIdHash: await sha256(RP_ID),
          flags: 0x05,
          signCount: 4,
        });
        const signature = await signAssertion({
          privateKey: context.pair.privateKey,
          authData,
          clientDataJSON,
        });
        const verified = await warn.service.verifyAuthenticationResponse(
          {
            id: base64UrlEncode(context.credentialId),
            rawId: base64UrlEncode(context.credentialId),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(signature),
            },
          },
          { challengeKey: ceremony.challengeKey },
        );
        expect(verified.cloneWarning).toBe(true);
      } finally {
        console.warn = silence;
      }
    }

    // BS without BE (eligibility matches stored false).
    {
      const beContext = await register();
      const { challengeKey, response } = await assertion(beContext, {
        signCount: 6,
        flags: 0x05 | 0x10, // UP+UV+BS without BE
      });
      await expect(
        beContext.service.verifyAuthenticationResponse(response, { challengeKey }),
      ).rejects.toThrow(/Backup state is set without backup eligibility/);
    }
  });
});

describe('WebAuthn registration ceremony', () => {
  function cborText(value: string): Uint8Array {
    const encoded = new TextEncoder().encode(value);
    return concatBytes(bytes(0x60 + encoded.length), encoded);
  }

  function cborBstr(value: Uint8Array): Uint8Array {
    if (value.length < 24) return concatBytes(bytes(0x40 + value.length), value);
    if (value.length < 256) return concatBytes(bytes(0x58, value.length), value);
    return concatBytes(bytes(0x59, (value.length >> 8) & 0xff, value.length & 0xff), value);
  }

  function attestationObject(fmt: string, attStmt: Uint8Array, authData: Uint8Array): Uint8Array {
    // Canonical text-key order by length: fmt(3), attStmt(7), authData(8).
    return concatBytes(
      bytes(0xa3),
      cborText('fmt'),
      cborText(fmt),
      cborText('attStmt'),
      attStmt,
      cborText('authData'),
      cborBstr(authData),
    );
  }

  async function registrationResponse(input: {
    service: Awaited<ReturnType<typeof buildService>>['service'];
    challenge: string;
    challengeKey: string;
    privateKey: CryptoKey;
    publicCose: Uint8Array;
    credentialId: Uint8Array;
    fmt?: string;
    attStmt?: Uint8Array;
    flags?: number;
    transports?: string[];
  }) {
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: input.challenge,
        origin: ORIGIN,
      }),
    );
    const authData = buildAuthData({
      rpIdHash: await sha256(RP_ID),
      flags: input.flags ?? 0x41,
      signCount: 0,
      attested: {
        aaguid: new Uint8Array(16),
        credentialId: input.credentialId,
        coseKey: input.publicCose,
      },
    });
    const attStmt = input.attStmt ?? bytes(0xa0);
    const attestation = attestationObject(input.fmt ?? 'none', attStmt, authData);
    return {
      challengeKey: input.challengeKey,
      response: {
        id: base64UrlEncode(input.credentialId),
        rawId: base64UrlEncode(input.credentialId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: base64UrlEncode(clientDataJSON),
          attestationObject: base64UrlEncode(attestation),
          ...(input.transports ? { transports: input.transports as never } : {}),
        },
      },
    };
  }

  it('registers a none-attestation credential end-to-end', async () => {
    const context = await buildService();
    // Force the handle-creation path.
    await context.users.update('u1', { webauthnUserHandle: undefined });
    await context.credentials.saveWebAuthn({
      kind: 'webauthn',
      id: 'existing',
      userId: 'u1',
      publicKeyCose: base64UrlEncode(coseP256(new Uint8Array(32), new Uint8Array(32))),
      algorithm: COSE_ALG.ES256,
      signCount: 0,
      backupEligible: false,
      backupState: false,
      uvInitialized: false,
      createdAt: 0,
      version: 0,
      transports: ['usb'],
    });

    const ceremony = await context.service.generateRegistrationOptions({
      userId: 'u1',
      username: 'ada',
      displayName: 'Ada',
      authenticatorAttachment: 'platform',
      extensions: { credProps: true },
    });
    expect(ceremony.options.excludeCredentials?.[0]?.transports).toEqual(['usb']);
    expect(ceremony.options.authenticatorSelection!.authenticatorAttachment).toBe('platform');

    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const credentialId = crypto.getRandomValues(new Uint8Array(16));
    const publicCose = coseP256(decode(jwk.x!), decode(jwk.y!));

    const { challengeKey, response } = await registrationResponse({
      service: context.service,
      challenge: ceremony.options.challenge,
      challengeKey: ceremony.challengeKey,
      privateKey: pair.privateKey,
      publicCose,
      credentialId,
      transports: ['internal'],
    });

    const verified = await context.service.verifyRegistrationResponse(response, { challengeKey });
    expect(verified.credential.id).toBe(base64UrlEncode(credentialId));
    expect(verified.attestation.fmt).toBe('none');
  });

  it('rejects registration error branches and verifies packed self-attestation', async () => {
    const context = await buildService();
    await expect(
      context.service.generateRegistrationOptions({ userId: 'missing', username: 'x' }),
    ).rejects.toThrow(/No user/);

    expect(() =>
      webAuthnService({
        config: {
          rpId: RP_ID,
          rpName: 'Example',
          origins: [ORIGIN],
          pubKeyCredParams: [999 as never],
        },
        credentials: context.credentials,
        state: context.state,
        users: context.users,
      }),
    ).toThrow(/Unsupported COSE algorithm/);

    const silence = console.error;
    console.error = () => undefined;
    try {
      webAuthnService({
        config: {
          rpId: RP_ID,
          rpName: 'Example',
          origins: [ORIGIN],
          pubKeyCredParams: [COSE_ALG.ES256, COSE_ALG.EdDSA],
        },
        credentials: context.credentials,
        state: context.state,
        users: context.users,
      });
    } finally {
      console.error = silence;
    }

    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const publicCose = coseP256(decode(jwk.x!), decode(jwk.y!));
    const credentialId = crypto.getRandomValues(new Uint8Array(16));

    const ceremony = await context.service.generateRegistrationOptions({
      userId: 'u1',
      username: 'ada',
    });

    // Packed self-attestation.
    {
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x41,
        signCount: 0,
        attested: {
          aaguid: new Uint8Array(16),
          credentialId,
          coseKey: publicCose,
        },
      });
      const clientDataHash = await sha256(clientDataJSON);
      const signed = concatBytes(authData, clientDataHash);
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          signed as BufferSource,
        ),
      );
      const sig = p1363ToDer(raw);
      const attStmt = concatBytes(
        bytes(0xa2),
        cborText('alg'),
        bytes(0x26), // -7
        cborText('sig'),
        cborBstr(sig),
      );
      const verified = await context.service.verifyRegistrationResponse(
        {
          id: base64UrlEncode(credentialId),
          rawId: base64UrlEncode(credentialId),
          type: 'public-key',
          response: {
            clientDataJSON: base64UrlEncode(clientDataJSON),
            attestationObject: base64UrlEncode(attestationObject('packed', attStmt, authData)),
          },
        },
        { challengeKey: ceremony.challengeKey },
      );
      expect(verified.attestation.trustPath).toBe('self');
    }

    // Custom attestation hook.
    {
      const custom = await buildService({
        verifyAttestation: async () => ({ verified: true, trustPath: 'custom' }),
      });
      const c = await custom.service.generateRegistrationOptions({ userId: 'u1', username: 'ada' });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const { challengeKey, response } = await registrationResponse({
        service: custom.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        fmt: 'android-safetynet',
        attStmt: bytes(0xa0),
      });
      const verified = await custom.service.verifyRegistrationResponse(response, { challengeKey });
      expect(verified.attestation.trustPath).toBe('custom');
    }

    // Unsupported format, none with non-empty attStmt, packed x5c paths, duplicate credential.
    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const badFmt = await registrationResponse({
        service: context.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        fmt: 'tpm',
        attStmt: bytes(0xa0),
      });
      await expect(
        context.service.verifyRegistrationResponse(badFmt.response, {
          challengeKey: badFmt.challengeKey,
        }),
      ).rejects.toThrow(/not supported/);
    }

    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const nonempty = await registrationResponse({
        service: context.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        attStmt: concatBytes(bytes(0xa1), cborText('x'), bytes(0x01)),
      });
      await expect(
        context.service.verifyRegistrationResponse(nonempty.response, {
          challengeKey: nonempty.challengeKey,
        }),
      ).rejects.toThrow(/empty attStmt/);
    }

    {
      const direct = await buildService({ attestation: 'direct' });
      const c = await direct.service.generateRegistrationOptions({ userId: 'u1', username: 'ada' });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const x5c = concatBytes(
        bytes(0xa1),
        cborText('x5c'),
        bytes(0x81),
        cborBstr(new Uint8Array(8)),
      );
      const packed = await registrationResponse({
        service: direct.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        fmt: 'packed',
        attStmt: x5c,
      });
      await expect(
        direct.service.verifyRegistrationResponse(packed.response, {
          challengeKey: packed.challengeKey,
        }),
      ).rejects.toThrow(/x5c certificate chain/);
    }

    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const x5c = concatBytes(
        bytes(0xa1),
        cborText('x5c'),
        bytes(0x81),
        cborBstr(new Uint8Array(8)),
      );
      const packed = await registrationResponse({
        service: context.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        fmt: 'packed',
        attStmt: x5c,
      });
      const verified = await context.service.verifyRegistrationResponse(packed.response, {
        challengeKey: packed.challengeKey,
      });
      expect(verified.attestation.verified).toBe(false);
    }

    // Duplicate credential id.
    {
      await context.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(credentialId),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(publicCose),
        algorithm: COSE_ALG.ES256,
        signCount: 0,
        backupEligible: false,
        backupState: false,
        uvInitialized: false,
        createdAt: 0,
        version: 0,
      });
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const { challengeKey, response } = await registrationResponse({
        service: context.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId,
      });
      await expect(
        context.service.verifyRegistrationResponse(response, { challengeKey }),
      ).rejects.toThrow(/already registered/);
    }

    // UV required + BS without BE + missing AT.
    {
      const uv = await buildService({ requireUserVerification: true });
      const c = await uv.service.generateRegistrationOptions({ userId: 'u1', username: 'ada' });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const noUv = await registrationResponse({
        service: uv.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        flags: 0x41,
      });
      await expect(
        uv.service.verifyRegistrationResponse(noUv.response, { challengeKey: noUv.challengeKey }),
      ).rejects.toThrow(/User verification was required/);
    }
  });

  it('covers remaining registration and authentication residuals', async () => {
    const context = await buildService();
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const decode = (value: string) =>
      Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const publicCose = coseP256(decode(jwk.x!), decode(jwk.y!));

    // Warn when EdDSA is offered but WebCrypto cannot verify it.
    {
      const spy = spyOn(algorithms, 'isAlgorithmSupported').mockResolvedValue(false);
      const errors: unknown[] = [];
      const silence = console.error;
      console.error = (...args) => {
        errors.push(args[0]);
      };
      try {
        webAuthnService({
          config: {
            rpId: RP_ID,
            rpName: 'Example',
            origins: [ORIGIN],
            pubKeyCredParams: [COSE_ALG.ES256, COSE_ALG.EdDSA],
          },
          credentials: context.credentials,
          state: context.state,
          users: context.users,
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(errors.some((entry) => String(entry).includes('EdDSA'))).toBe(true);
      } finally {
        console.error = silence;
        spy.mockRestore();
      }
    }

    // Build a CBOR attestation object that omits authData entirely.
    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const incomplete = concatBytes(
        bytes(0xa2),
        cborText('fmt'),
        cborText('none'),
        cborText('attStmt'),
        bytes(0xa0),
      );
      await expect(
        context.service.verifyRegistrationResponse(
          {
            id: 'x',
            rawId: 'x',
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: 'webauthn.create',
                    challenge: c.options.challenge,
                    origin: ORIGIN,
                  }),
                ),
              ),
              attestationObject: base64UrlEncode(incomplete),
            },
          },
          { challengeKey: c.challengeKey },
        ),
      ).rejects.toThrow(/no authData/);
    }

    // Wrong rpId hash on registration.
    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const { challengeKey, response } = await registrationResponse({
        service: context.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
      });
      // Rebuild with bad rpIdHash.
      const badAuth = buildAuthData({
        rpIdHash: new Uint8Array(32).fill(3),
        flags: 0x41,
        signCount: 0,
        attested: { aaguid: new Uint8Array(16), credentialId: id, coseKey: publicCose },
      });
      const clientDataJSON = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: c.options.challenge,
            origin: ORIGIN,
          }),
        ),
      );
      await expect(
        context.service.verifyRegistrationResponse(
          {
            ...response,
            response: {
              clientDataJSON,
              attestationObject: base64UrlEncode(attestationObject('none', bytes(0xa0), badAuth)),
            },
          },
          { challengeKey },
        ),
      ).rejects.toThrow(/rpIdHash/);
    }

    // No AT flag / no attested credential data.
    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const bare = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x01,
        signCount: 0,
      });
      await expect(
        context.service.verifyRegistrationResponse(
          {
            id: 'x',
            rawId: 'x',
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: 'webauthn.create',
                    challenge: c.options.challenge,
                    origin: ORIGIN,
                  }),
                ),
              ),
              attestationObject: base64UrlEncode(attestationObject('none', bytes(0xa0), bare)),
            },
          },
          { challengeKey: c.challengeKey },
        ),
      ).rejects.toThrow(/no attested credential data/);
    }

    // BS without BE at registration.
    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const { challengeKey, response } = await registrationResponse({
        service: context.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        flags: 0x41 | 0x10, // AT+UP+BS without BE
      });
      await expect(
        context.service.verifyRegistrationResponse(response, { challengeKey }),
      ).rejects.toThrow(/Backup state is set without backup eligibility/);
    }

    // Algorithm not among offered params.
    {
      const limited = await buildService({ pubKeyCredParams: [COSE_ALG.ES256] });
      // Craft an RS256 COSE key inside attested data.
      const rsaN = new Uint8Array(256).fill(1);
      const rsaCose = concatBytes(
        bytes(0xa4),
        bytes(0x01, 0x03),
        bytes(0x03, 0x39, 0x01, 0x00),
        bytes(0x20, 0x59, 0x01, 0x00),
        rsaN,
        bytes(0x21, 0x43, 0x01, 0x00, 0x01),
      );
      const c = await limited.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x41,
        signCount: 0,
        attested: { aaguid: new Uint8Array(16), credentialId: id, coseKey: rsaCose },
      });
      await expect(
        limited.service.verifyRegistrationResponse(
          {
            id: base64UrlEncode(id),
            rawId: base64UrlEncode(id),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: 'webauthn.create',
                    challenge: c.options.challenge,
                    origin: ORIGIN,
                  }),
                ),
              ),
              attestationObject: base64UrlEncode(attestationObject('none', bytes(0xa0), authData)),
            },
          },
          { challengeKey: c.challengeKey },
        ),
      ).rejects.toThrow(/not among the offered algorithms/);
    }

    // Packed alg mismatch + invalid self-attestation signature + unhandled format.
    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x41,
        signCount: 0,
        attested: { aaguid: new Uint8Array(16), credentialId: id, coseKey: publicCose },
      });
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: c.options.challenge,
          origin: ORIGIN,
        }),
      );
      const wrongAlg = concatBytes(
        bytes(0xa2),
        cborText('alg'),
        bytes(0x39, 0x01, 0x00), // -257
        cborText('sig'),
        cborBstr(new Uint8Array(64)),
      );
      await expect(
        context.service.verifyRegistrationResponse(
          {
            id: base64UrlEncode(id),
            rawId: base64UrlEncode(id),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              attestationObject: base64UrlEncode(attestationObject('packed', wrongAlg, authData)),
            },
          },
          { challengeKey: c.challengeKey },
        ),
      ).rejects.toThrow(/Self-attestation alg does not match/);
    }

    {
      const c = await context.service.generateRegistrationOptions({
        userId: 'u1',
        username: 'ada',
      });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x41,
        signCount: 0,
        attested: { aaguid: new Uint8Array(16), credentialId: id, coseKey: publicCose },
      });
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: c.options.challenge,
          origin: ORIGIN,
        }),
      );
      const badSig = concatBytes(
        bytes(0xa2),
        cborText('alg'),
        bytes(0x26),
        cborText('sig'),
        cborBstr(new Uint8Array(64).fill(7)),
      );
      await expect(
        context.service.verifyRegistrationResponse(
          {
            id: base64UrlEncode(id),
            rawId: base64UrlEncode(id),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              attestationObject: base64UrlEncode(attestationObject('packed', badSig, authData)),
            },
          },
          { challengeKey: c.challengeKey },
        ),
      ).rejects.toThrow(/Self-attestation signature is invalid|Assertion signature|invalid/);
    }

    {
      const tpm = await buildService({
        supportedAttestationFormats: ['none', 'packed', 'tpm'],
      });
      const c = await tpm.service.generateRegistrationOptions({ userId: 'u1', username: 'ada' });
      const id = crypto.getRandomValues(new Uint8Array(16));
      const { challengeKey, response } = await registrationResponse({
        service: tpm.service,
        challenge: c.options.challenge,
        challengeKey: c.challengeKey,
        privateKey: pair.privateKey,
        publicCose,
        credentialId: id,
        fmt: 'tpm',
      });
      await expect(
        tpm.service.verifyRegistrationResponse(response, { challengeKey }),
      ).rejects.toThrow(/Unhandled attestation format/);
    }

    // Auth: userId mismatch, matching userHandle, invalid signature, concurrent CAS miss.
    {
      const auth = await buildService();
      await auth.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(new Uint8Array(32).fill(1)),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(publicCose),
        algorithm: COSE_ALG.ES256,
        signCount: 1,
        backupEligible: false,
        backupState: false,
        uvInitialized: true,
        createdAt: 0,
        version: 0,
      });

      const credentials = {
        ...auth.credentials,
        async findWebAuthn(id: string) {
          const found = await auth.credentials.findWebAuthn(id);
          return found ? { ...found, userId: 'other-user' } : null;
        },
        listWebAuthn: auth.credentials.listWebAuthn.bind(auth.credentials),
        updateSignCount: auth.credentials.updateSignCount.bind(auth.credentials),
        saveWebAuthn: auth.credentials.saveWebAuthn.bind(auth.credentials),
      };
      const mismatched = webAuthnService({
        config: { rpId: RP_ID, rpName: 'Example', origins: [ORIGIN] },
        credentials: credentials as never,
        state: auth.state,
        users: auth.users,
      });
      const ceremony = await mismatched.generateAuthenticationOptions({ userId: 'u1' });
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x05,
        signCount: 2,
      });
      const signature = await signAssertion({
        privateKey: pair.privateKey,
        authData,
        clientDataJSON,
      });
      await expect(
        mismatched.verifyAuthenticationResponse(
          {
            id: base64UrlEncode(new Uint8Array(32).fill(1)),
            rawId: base64UrlEncode(new Uint8Array(32).fill(1)),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(signature),
            },
          },
          { challengeKey: ceremony.challengeKey },
        ),
      ).rejects.toThrow(/does not belong to the user/);
    }

    {
      const auth = await buildService();
      const credentialId = crypto.getRandomValues(new Uint8Array(32));
      await auth.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(credentialId),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(publicCose),
        algorithm: COSE_ALG.ES256,
        signCount: 1,
        backupEligible: false,
        backupState: false,
        uvInitialized: true,
        createdAt: 0,
        version: 0,
      });
      const handle = auth.user.webauthnUserHandle!;
      const ceremony = await auth.service.generateAuthenticationOptions();
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x05,
        signCount: 2,
      });
      const signature = await signAssertion({
        privateKey: pair.privateKey,
        authData,
        clientDataJSON,
      });
      const verified = await auth.service.verifyAuthenticationResponse(
        {
          id: base64UrlEncode(credentialId),
          rawId: base64UrlEncode(credentialId),
          type: 'public-key',
          response: {
            clientDataJSON: base64UrlEncode(clientDataJSON),
            authenticatorData: base64UrlEncode(authData),
            signature: base64UrlEncode(signature),
            userHandle: handle,
          },
        },
        { challengeKey: ceremony.challengeKey },
      );
      expect(verified.userId).toBe('u1');
    }

    {
      const auth = await buildService();
      const credentialId = crypto.getRandomValues(new Uint8Array(32));
      await auth.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(credentialId),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(publicCose),
        algorithm: COSE_ALG.ES256,
        signCount: 1,
        backupEligible: false,
        backupState: false,
        uvInitialized: true,
        createdAt: 0,
        version: 0,
      });
      const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const ceremony = await auth.service.generateAuthenticationOptions({ userId: 'u1' });
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x05,
        signCount: 2,
      });
      const signature = await signAssertion({
        privateKey: other.privateKey,
        authData,
        clientDataJSON,
      });
      await expect(
        auth.service.verifyAuthenticationResponse(
          {
            id: base64UrlEncode(credentialId),
            rawId: base64UrlEncode(credentialId),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(signature),
            },
          },
          { challengeKey: ceremony.challengeKey },
        ),
      ).rejects.toThrow(/Assertion signature is invalid/);
    }

    {
      const auth = await buildService();
      const credentialId = crypto.getRandomValues(new Uint8Array(32));
      await auth.credentials.saveWebAuthn({
        kind: 'webauthn',
        id: base64UrlEncode(credentialId),
        userId: 'u1',
        publicKeyCose: base64UrlEncode(publicCose),
        algorithm: COSE_ALG.ES256,
        signCount: 1,
        backupEligible: false,
        backupState: false,
        uvInitialized: true,
        createdAt: 0,
        version: 0,
      });
      const credentials = {
        ...auth.credentials,
        findWebAuthn: auth.credentials.findWebAuthn.bind(auth.credentials),
        listWebAuthn: auth.credentials.listWebAuthn.bind(auth.credentials),
        saveWebAuthn: auth.credentials.saveWebAuthn.bind(auth.credentials),
        updateSignCount: async () => false,
      };
      const concurrent = webAuthnService({
        config: { rpId: RP_ID, rpName: 'Example', origins: [ORIGIN] },
        credentials: credentials as never,
        state: auth.state,
        users: auth.users,
      });
      const ceremony = await concurrent.generateAuthenticationOptions({ userId: 'u1' });
      const clientDataJSON = new TextEncoder().encode(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: ceremony.options.challenge,
          origin: ORIGIN,
        }),
      );
      const authData = buildAuthData({
        rpIdHash: await sha256(RP_ID),
        flags: 0x05,
        signCount: 2,
      });
      const signature = await signAssertion({
        privateKey: pair.privateKey,
        authData,
        clientDataJSON,
      });
      await expect(
        concurrent.verifyAuthenticationResponse(
          {
            id: base64UrlEncode(credentialId),
            rawId: base64UrlEncode(credentialId),
            type: 'public-key',
            response: {
              clientDataJSON: base64UrlEncode(clientDataJSON),
              authenticatorData: base64UrlEncode(authData),
              signature: base64UrlEncode(signature),
            },
          },
          { challengeKey: ceremony.challengeKey },
        ),
      ).rejects.toThrow(/Concurrent use/);
    }
  });
});
