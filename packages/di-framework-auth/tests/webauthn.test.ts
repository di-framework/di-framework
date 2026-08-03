import { describe, expect, it } from 'bun:test';
import { base64UrlEncode } from '../src/crypto/base64url.ts';
import { concatBytes, sha256 } from '../src/crypto/hash.ts';
import { randomToken } from '../src/crypto/random.ts';
import { AuthError } from '../src/errors.ts';
import {
  memoryCredentialStore,
  memoryStateStore,
  memoryUserStore,
} from '../src/providers/memory.ts';
import { p1363ToDer } from '../src/tokens/jws.ts';
import { parseAuthenticatorData, parseFlags } from '../src/webauthn/authenticator-data.ts';
import { CborError, decodeCbor, decodeCborAt } from '../src/webauthn/cbor.ts';
import { parseClientData, verifyClientData } from '../src/webauthn/client-data.ts';
import { COSE_ALG, DEFAULT_PUBKEY_CRED_PARAMS, parseCoseKey } from '../src/webauthn/cose.ts';
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
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, input.privateKey, signed),
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
});
