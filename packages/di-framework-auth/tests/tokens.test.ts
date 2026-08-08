import { beforeAll, describe, expect, it } from 'bun:test';
import {
  base64UrlDecode,
  base64UrlEncode,
  base64UrlEncodeString,
} from '../src/crypto/base64url.ts';
import { AuthError } from '../src/errors.ts';
import { memoryKeyStore, memoryRefreshTokenStore } from '../src/providers/memory.ts';
import { isAlgorithmSupported } from '../src/tokens/algorithms.ts';
import {
  generateKeyPair,
  importHmacKey,
  importJwk,
  jwkThumbprint,
  toPublicJwk,
} from '../src/tokens/jwk.ts';
import { fetchJson } from '../src/tokens/jwks.ts';
import { derToP1363, p1363ToDer, signJws, verifyJws } from '../src/tokens/jws.ts';
import { decodeJwtUnsafe, signJwt, verifyJwt } from '../src/tokens/jwt.ts';
import { keyService } from '../src/tokens/keystore.ts';
import { refreshService } from '../src/tokens/refresh.ts';

const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

let es256Private: CryptoKey;
let es256Public: CryptoKey;
let hs256: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  es256Private = await importJwk(pair.privateJwk, 'ES256', 'sign');
  es256Public = await importJwk(pair.publicJwk, 'ES256', 'verify');
  hs256 = await importHmacKey('k'.repeat(32), 'HS256');
});

describe('JWK', () => {
  it('computes the RFC 7638 §3.1 thumbprint for the spec example key', async () => {
    const jwk = {
      kty: 'RSA',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
      e: 'AQAB',
      alg: 'RS256',
      kid: '2011-04-29',
    };
    expect(await jwkThumbprint(jwk)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('derives a stable kid from the public key', async () => {
    const pair = await generateKeyPair('ES256');
    expect(pair.kid).toBe(await jwkThumbprint(toPublicJwk(pair.publicJwk)));
  });

  it('strips private members when publishing', async () => {
    const pair = await generateKeyPair('ES256');
    expect(pair.privateJwk.d).toBeDefined();
    expect(toPublicJwk(pair.privateJwk).d).toBeUndefined();
  });

  it('refuses a JWK whose kty does not match the algorithm', async () => {
    const pair = await generateKeyPair('ES256');
    await expect(importJwk(pair.publicJwk, 'RS256', 'verify')).rejects.toThrow(AuthError);
  });

  it('refuses an HMAC key shorter than the digest', async () => {
    await expect(importHmacKey('short', 'HS256')).rejects.toThrow(AuthError);
  });

  it('refuses to generate a key pair for a symmetric algorithm', async () => {
    await expect(generateKeyPair('HS256')).rejects.toThrow(/use importHmacKey/);
  });

  it('generates an RSA key pair (RS256)', async () => {
    const pair = await generateKeyPair('RS256');
    expect(pair.privateJwk.kty).toBe('RSA');
    const signingKey = await importJwk(pair.privateJwk, 'RS256', 'sign');
    const verifyKey = await importJwk(pair.publicJwk, 'RS256', 'verify');
    expect(signingKey).toBeDefined();
    expect(verifyKey).toBeDefined();
  });

  it('surfaces the runtime WebCrypto failure as a clear error', async () => {
    const original = crypto.subtle.generateKey;
    // biome-ignore lint/suspicious/noExplicitAny: forcing the unsupported-algorithm branch.
    (crypto.subtle as any).generateKey = async () => {
      throw new Error('simulated unsupported algorithm');
    };
    try {
      await expect(generateKeyPair('PS512')).rejects.toThrow(/cannot generate/);
    } finally {
      crypto.subtle.generateKey = original;
    }
  });

  it('refuses a curve mismatch between the JWK and the requested algorithm', async () => {
    const p256 = await generateKeyPair('ES256');
    const wrongCurveJwk = { ...p256.publicJwk, crv: 'P-384' };
    await expect(importJwk(wrongCurveJwk, 'ES256', 'verify')).rejects.toThrow(
      /does not match algorithm/,
    );
  });

  it('refuses to import a shared secret for a non-symmetric algorithm', async () => {
    await expect(importHmacKey('k'.repeat(32), 'ES256')).rejects.toThrow(
      /is not a symmetric algorithm/,
    );
  });

  it('refuses a thumbprint whose kty declares a member that is missing', async () => {
    await expect(jwkThumbprint({ kty: 'EC', crv: 'P-256', x: 'abc' } as never)).rejects.toThrow(
      /missing required member/,
    );
  });
});

describe('isAlgorithmSupported', () => {
  it('probes a symmetric (HMAC) algorithm via importKey', async () => {
    expect(await isAlgorithmSupported('HS384')).toBe(true);
  });

  it('probes an RSA algorithm via generateKey with a 2048-bit modulus', async () => {
    expect(await isAlgorithmSupported('RS384')).toBe(true);
  });

  it('returns false rather than throwing when the WebCrypto call fails', async () => {
    const original = crypto.subtle.importKey;
    // biome-ignore lint/suspicious/noExplicitAny: forcing the catch-and-return-false branch.
    (crypto.subtle as any).importKey = async () => {
      throw new Error('simulated failure');
    };
    try {
      expect(await isAlgorithmSupported('HS512')).toBe(false);
    } finally {
      crypto.subtle.importKey = original;
    }
  });

  it('caches the result for a repeated call with the same algorithm', async () => {
    const first = isAlgorithmSupported('ES512');
    const second = isAlgorithmSupported('ES512');
    expect(first).toBe(second); // same in-flight/resolved promise, not just an equal boolean
    expect(await first).toBe(true);
  });
});

describe('ECDSA signature encoding', () => {
  it('round-trips DER and P1363', () => {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    expect(derToP1363(p1363ToDer(raw), 64)).toEqual(raw);
  });

  // The case that breaks naive implementations: DER integers are signed, so a
  // value whose high bit is set gains a 0x00 sign byte and the DER length changes.
  it('handles integers whose high bit is set', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0xff;
    raw[32] = 0xff;
    const der = p1363ToDer(raw);
    expect(der.length).toBe(72); // 0x30 len (0x02 33 0x00 …) × 2
    expect(derToP1363(der, 64)).toEqual(raw);
  });

  it('handles integers with leading zero bytes', () => {
    const raw = new Uint8Array(64);
    raw[31] = 0x01;
    raw[63] = 0x02;
    expect(derToP1363(p1363ToDer(raw), 64)).toEqual(raw);
  });

  it('rejects malformed DER', () => {
    expect(() => derToP1363(new Uint8Array([0x31, 0x02, 0x02, 0x00]), 64)).toThrow(AuthError);
    expect(() => derToP1363(new Uint8Array([0x30, 0x02, 0x03, 0x00]), 64)).toThrow(AuthError);
  });
});

describe('JWS verification refuses dangerous headers', () => {
  const payload = encode({ sub: 'u1' });

  const forge = (header: Record<string, unknown>, signature = 'AA') =>
    `${encode(header)}.${payload}.${signature}`;

  it('rejects alg: none', async () => {
    await expect(
      verifyJws(forge({ alg: 'none' }, ''), { algorithms: ['ES256'], key: es256Public }),
    ).rejects.toThrow(AuthError);
  });

  it('rejects an algorithm outside the allowlist', async () => {
    const token = await signJws('{}', { algorithm: 'ES256', key: es256Private });
    await expect(verifyJws(token, { algorithms: ['RS256'], key: es256Public })).rejects.toThrow(
      /not in the permitted set/,
    );
  });

  // The classic confusion attack: re-sign with the RSA/EC public key treated as
  // an HMAC secret. The allowlist stops it before any key is touched.
  it('rejects an HS256 token when only ES256 is permitted', async () => {
    const token = await signJws('{}', { algorithm: 'HS256', key: hs256 });
    await expect(verifyJws(token, { algorithms: ['ES256'], key: es256Public })).rejects.toThrow(
      AuthError,
    );
  });

  it('rejects a key whose algorithm disagrees with the header', async () => {
    const token = await signJws('{}', { algorithm: 'HS256', key: hs256 });
    await expect(
      verifyJws(token, { algorithms: ['HS256', 'ES256'], key: es256Public }),
    ).rejects.toThrow(/does not match JWS alg/);
  });

  it('rejects a header-embedded jwk, jku, or x5u', async () => {
    for (const member of ['jwk', 'jku', 'x5u']) {
      await expect(
        verifyJws(forge({ alg: 'ES256', [member]: {} }), {
          algorithms: ['ES256'],
          key: es256Public,
        }),
      ).rejects.toThrow(AuthError);
    }
  });

  it('rejects non-empty crit', async () => {
    await expect(
      verifyJws(forge({ alg: 'ES256', crit: ['exp'] }), {
        algorithms: ['ES256'],
        key: es256Public,
      }),
    ).rejects.toThrow(/critical parameters/);
  });

  it('rejects b64: false', async () => {
    await expect(
      verifyJws(forge({ alg: 'ES256', b64: false }), { algorithms: ['ES256'], key: es256Public }),
    ).rejects.toThrow(/b64=false/);
  });

  it('rejects the wrong number of segments', async () => {
    await expect(verifyJws('a.b', { algorithms: ['ES256'], key: es256Public })).rejects.toThrow(
      /expected 3 segments/,
    );
    await expect(
      verifyJws('a.b.c.d.e', { algorithms: ['ES256'], key: es256Public }),
    ).rejects.toThrow(/expected 3 segments/);
  });

  it('rejects a tampered payload', async () => {
    const token = await signJws('{"sub":"u1"}', { algorithm: 'ES256', key: es256Private });
    const [header, , signature] = token.split('.');
    const tampered = `${header}.${encode({ sub: 'admin' })}.${signature}`;
    await expect(verifyJws(tampered, { algorithms: ['ES256'], key: es256Public })).rejects.toThrow(
      AuthError,
    );
  });

  it('refuses an empty allowlist', async () => {
    const token = await signJws('{}', { algorithm: 'ES256', key: es256Private });
    await expect(verifyJws(token, { algorithms: [], key: es256Public })).rejects.toThrow(
      /non-empty algorithm allowlist/,
    );
  });

  it('rejects a header that decodes to something other than a JSON object', async () => {
    const headerB64 = base64UrlEncodeString(JSON.stringify(['not', 'an', 'object']));
    await expect(
      verifyJws(`${headerB64}.${payload}.AA`, { algorithms: ['ES256'], key: es256Public }),
    ).rejects.toThrow(/not a JSON object/);
  });

  it('rejects a signature segment that is not valid base64url', async () => {
    await expect(
      verifyJws(forge({ alg: 'ES256' }, '!!!not-base64url!!!'), {
        algorithms: ['ES256'],
        key: es256Public,
      }),
    ).rejects.toThrow(/signature is not valid base64url/);
  });

  // RFC 7515 mandates the raw P1363 form, but some producers emit DER. Accepted
  // after a strict re-encode rather than failing opaquely on the length check.
  it('accepts a DER-encoded ECDSA signature in place of raw P1363', async () => {
    const token = await signJws('{"sub":"u1"}', { algorithm: 'ES256', key: es256Private });
    const [header, body, rawSignatureB64] = token.split('.') as [string, string, string];
    const rawSignature = base64UrlDecode(rawSignatureB64);
    const derSignature = p1363ToDer(rawSignature);
    expect(derSignature.length).not.toBe(rawSignature.length);
    const derToken = `${header}.${body}.${base64UrlEncode(derSignature)}`;
    const { payload: verifiedPayload } = await verifyJws(derToken, {
      algorithms: ['ES256'],
      key: es256Public,
    });
    expect(new TextDecoder().decode(verifiedPayload)).toBe('{"sub":"u1"}');
  });
});

describe('derToP1363 edge cases', () => {
  it('parses the DER long-form length encoding for large signatures', () => {
    const intBytes = (fill: number) => new Uint8Array([0x00, ...Array(64).fill(fill)]);
    const r = intBytes(0xaa);
    const s = intBytes(0x55);
    const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
    const der = new Uint8Array([0x30, 0x81, body.length, ...body]);
    const p1363 = derToP1363(der, 128);
    expect(p1363.subarray(0, 64)).toEqual(new Uint8Array(64).fill(0xaa));
    expect(p1363.subarray(64)).toEqual(new Uint8Array(64).fill(0x55));
  });

  it('rejects a declared sequence length that disagrees with the buffer length', () => {
    const body = [0x02, 1, 0x01, 0x02, 1, 0x02];
    const der = new Uint8Array([0x30, body.length + 1, ...body]); // declares one byte too many
    expect(() => derToP1363(der, 2)).toThrow(/DER length mismatch/);
  });

  it('rejects an INTEGER with a zero-length value', () => {
    const der = new Uint8Array([0x30, 2, 0x02, 0x00]);
    expect(() => derToP1363(der, 2)).toThrow(/bad INTEGER length/);
  });

  it('rejects an INTEGER whose declared length exceeds the buffer', () => {
    const der = new Uint8Array([0x30, 2, 0x02, 10]);
    expect(() => derToP1363(der, 2)).toThrow(/bad INTEGER length/);
  });
});

describe('JWT claim validation', () => {
  // Built lazily: a describe body runs before beforeAll, so capturing the keys
  // here as consts would capture `undefined`.
  const signWith = () => ({ algorithm: 'ES256' as const, key: es256Private });
  const verifyWith = () => ({ algorithms: ['ES256'] as const, key: es256Public });

  it('accepts a well-formed token', async () => {
    const token = await signJwt(
      {},
      {
        ...signWith(),
        issuer: 'https://iss',
        audience: 'api',
        subject: 'u1',
        expiresInSeconds: 60,
      },
    );
    const { claims } = await verifyJwt(token, {
      ...verifyWith(),
      issuer: 'https://iss',
      audience: 'api',
    });
    expect(claims.sub).toBe('u1');
    expect(claims.jti).toBeDefined();
  });

  it('does not let custom claims override option-controlled claims', async () => {
    const token = await signJwt(
      {
        iss: 'https://attacker.example',
        aud: 'other-api',
        sub: 'other-user',
        exp: 99_999,
        nbf: 99_999,
        iat: 99_999,
      },
      {
        ...signWith(),
        issuer: 'https://issuer.example',
        audience: 'api',
        subject: 'u1',
        expiresInSeconds: 60,
        notBeforeSeconds: 10,
        now: () => 1_000,
      },
    );

    expect(decodeJwtUnsafe(token)).toMatchObject({
      iss: 'https://issuer.example',
      aud: 'api',
      sub: 'u1',
      exp: 1_060,
      nbf: 1_010,
      iat: 1_000,
    });
  });

  it('rejects an expired token', async () => {
    const token = await signJwt({}, { ...signWith(), expiresInSeconds: 60, now: () => 1_000 });
    await expect(verifyJwt(token, { ...verifyWith(), now: () => 100_000 })).rejects.toThrow(
      /expired/,
    );
  });

  it('rejects a token that is not yet valid', async () => {
    const token = await signJwt(
      {},
      { ...signWith(), expiresInSeconds: 600, notBeforeSeconds: 300, now: () => 1_000 },
    );
    await expect(verifyJwt(token, { ...verifyWith(), now: () => 1_100 })).rejects.toThrow(
      /not valid before/,
    );
  });

  it('rejects the wrong issuer and the wrong audience', async () => {
    const token = await signJwt(
      {},
      { ...signWith(), issuer: 'https://a', audience: 'api', expiresInSeconds: 60 },
    );
    await expect(verifyJwt(token, { ...verifyWith(), issuer: 'https://b' })).rejects.toThrow(
      /is not one of/,
    );
    await expect(verifyJwt(token, { ...verifyWith(), audience: 'other' })).rejects.toThrow(
      /does not include/,
    );
  });

  it('accepts a multi-valued aud that contains the expected value', async () => {
    const token = await signJwt(
      {},
      { ...signWith(), audience: ['api', 'admin'], expiresInSeconds: 60 },
    );
    await expect(verifyJwt(token, { ...verifyWith(), audience: 'admin' })).resolves.toBeDefined();
  });

  it('requires exp by default', async () => {
    const token = await signJwt({}, signWith());
    await expect(verifyJwt(token, verifyWith())).rejects.toThrow(/no exp claim/);
    await expect(
      verifyJwt(token, { ...verifyWith(), requireExpiry: false }),
    ).resolves.toBeDefined();
  });

  it('enforces maxTokenAge independently of exp', async () => {
    const token = await signJwt({}, { ...signWith(), expiresInSeconds: 86_400, now: () => 1_000 });
    await expect(
      verifyJwt(token, { ...verifyWith(), maxTokenAgeSeconds: 60, now: () => 5_000 }),
    ).rejects.toThrow(/older than/);
  });

  // A tolerance measured in hours is not skew compensation, it is a token that
  // outlives its own expiry.
  it('caps clock tolerance rather than clamping it', async () => {
    const token = await signJwt({}, { ...signWith(), expiresInSeconds: 60 });
    await expect(
      verifyJwt(token, { ...verifyWith(), clockToleranceSeconds: 3_600 }),
    ).rejects.toThrow(/must be between 0 and 300/);
  });

  it('rejects a payload that is not valid JSON', async () => {
    const token = await signJws('not json at all', signWith());
    await expect(verifyJwt(token, verifyWith())).rejects.toThrow(/not valid UTF-8 JSON/);
  });

  it('rejects a payload that is valid JSON but not an object', async () => {
    const token = await signJws('[1,2,3]', signWith());
    await expect(verifyJwt(token, verifyWith())).rejects.toThrow(/not a JSON object/);
  });

  it('rejects a subject mismatch', async () => {
    const token = await signJwt({}, { ...signWith(), subject: 'u1', expiresInSeconds: 60 });
    await expect(verifyJwt(token, { ...verifyWith(), subject: 'u2' })).rejects.toThrow(
      /does not match/,
    );
  });

  it('rejects a non-number iat', async () => {
    const token = await signJws(JSON.stringify({ iat: 'not-a-number', exp: 9_999_999_999 }), {
      ...signWith(),
    });
    await expect(verifyJwt(token, verifyWith())).rejects.toThrow(/iat is not a number/);
  });
});

describe('decodeJwtUnsafe', () => {
  const encodeSegment = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

  it('reads non-ASCII claims as the text that was signed', () => {
    // `atob` yields one character per byte, so a UTF-8 claim decoded that way
    // comes back mojibake — silently wrong rather than loudly broken.
    const claims = { sub: 'u1', name: 'Ada Lovelacé', iss: 'https://ünicode.example' };
    const token = `${encodeSegment({ alg: 'ES256' })}.${encodeSegment(claims)}.sig`;
    expect(decodeJwtUnsafe(token)).toEqual(claims);
  });

  it('rejects a payload that is not canonical base64url', () => {
    // Standard base64 decodes under `atob` but not under `verifyJws`. Accepting
    // it here would mean inspecting a token that could never be verified.
    const payload = encodeSegment({ sub: 'u1' });
    const standard = `${payload.replace(/-/g, '+').replace(/_/g, '/')}==`;
    if (standard !== `${payload}==`) {
      expect(() => decodeJwtUnsafe(`h.${standard}.sig`)).toThrow(/Malformed JWT payload/);
    }
    expect(() => decodeJwtUnsafe(`h.${payload}=.sig`)).toThrow(/Malformed JWT payload/);
    expect(() => decodeJwtUnsafe('only.two')).toThrow(/Malformed JWT/);
  });
});

describe('fetchJson body cap', () => {
  const call = (response: Response, maxBytes: number) =>
    fetchJson('https://idp.example/jwks', {
      timeoutMs: 1_000,
      maxBytes,
      fetch: (async () => response) as unknown as typeof fetch,
    });

  it('reads a document that fits', async () => {
    await expect(call(Response.json({ keys: [] }), 1_024)).resolves.toEqual({ keys: [] });
  });

  it('stops a stream once it exceeds the cap', async () => {
    // The cap must bite while reading. Buffering first and measuring afterwards
    // bounds nothing: the memory is already spent by the time it is checked.
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64));
      },
    });
    await expect(call(new Response(body), 128)).rejects.toThrow(
      /returned more than 128 bytes, over the 128 cap/,
    );
    // A few chunks of read-ahead are fine; an unbounded producer is not.
    expect(pulled).toBeLessThan(32);
  });

  it('refuses on a declared Content-Length before streaming', async () => {
    // The declared size is the cheapest signal available; reporting it rather
    // than a streamed count is how you can tell the short-circuit fired.
    const response = new Response('{}', { headers: { 'content-length': '9999' } });
    await expect(call(response, 128)).rejects.toThrow(/returned 9999 bytes, over the 128 cap/);
  });

  it('counts bytes, not characters', async () => {
    // Every '€' is three UTF-8 bytes, so a character count would put this
    // comfortably under a cap it actually blows through.
    const payload = JSON.stringify({ keys: [], pad: '€'.repeat(200) });
    expect(payload.length).toBeLessThan(300);
    await expect(call(new Response(payload), 300)).rejects.toThrow(/over the 300 cap/);
  });
});

describe('keyService', () => {
  it('generates a signing key lazily on first use', async () => {
    const service = keyService({ store: memoryKeyStore() });
    const { record } = await service.signingKey();
    expect(record.kid).toBeDefined();
    expect(record.algorithm).toBe('ES256');
  });

  it('keeps retired keys verifiable after rotation', async () => {
    const store = memoryKeyStore();
    const service = keyService({ store });

    const first = await service.signingKey();
    const token = await signJwt(
      {},
      { algorithm: 'ES256', key: first.key, kid: first.record.kid, expiresInSeconds: 60 },
    );

    await service.rotate();
    const second = await service.signingKey();
    expect(second.record.kid).not.toBe(first.record.kid);

    // The old token still verifies against the retired key.
    const verified = await verifyJwt(token, {
      algorithms: ['ES256'],
      key: (header) => service.verificationKey(header),
    });
    expect(verified.header.kid).toBe(first.record.kid);

    // And both keys are still published.
    const jwks = await service.publicJwks();
    expect(jwks.keys.map((key) => key.kid).sort()).toEqual(
      [first.record.kid, second.record.kid].sort(),
    );
    expect(jwks.keys.every((key) => key.d === undefined)).toBe(true);
  });

  it('falls back to the current key when a header carries no kid', async () => {
    const service = keyService({ store: memoryKeyStore() });
    const { record } = await service.signingKey();
    const verificationKey = await service.verificationKey({ alg: 'ES256' });
    expect(verificationKey).toBeDefined();
    void record;
  });

  it('rejects verification against an unknown kid', async () => {
    const service = keyService({ store: memoryKeyStore() });
    await service.signingKey();
    await expect(service.verificationKey({ alg: 'ES256', kid: 'does-not-exist' })).rejects.toThrow(
      /No signing key with kid/,
    );
  });

  it('rotating with no prior key generates one without treating the store miss as a previous key', async () => {
    const service = keyService({ store: memoryKeyStore() });
    const record = await service.rotate();
    expect(record.kid).toBeDefined();
    // Nothing to retire: no `notAfter` should have been set on anything.
    const jwks = await service.publicJwks();
    expect(jwks.keys).toHaveLength(1);
  });
});

describe('refresh tokens', () => {
  const service = () => refreshService({ store: memoryRefreshTokenStore() });

  it('rotates on every use', async () => {
    const refresh = service();
    const issued = await refresh.issue({ subject: 'u1' });
    const rotated = await refresh.rotate(issued.token);
    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.record.familyId).toBe(issued.record.familyId);
    expect(rotated.principal.sub).toBe('u1');
  });

  // The theft response: the legitimate client and an attacker cannot be told
  // apart, and only one of them can hold the current token, so nobody keeps it.
  it('revokes the whole family when a spent token is replayed', async () => {
    const store = memoryRefreshTokenStore();
    let reused = 0;
    const refresh = refreshService({ store, onReuseDetected: () => void reused++ });

    const first = await refresh.issue({ subject: 'u1' });
    const second = await refresh.rotate(first.token);

    await expect(refresh.rotate(first.token)).rejects.toThrow(/replayed; family revoked/);
    expect(reused).toBe(1);

    // The successor is gone too — that is what "family revoked" means.
    await expect(refresh.rotate(second.token)).rejects.toThrow(/not recognised/);
  });

  it('lets exactly one of two concurrent rotations win', async () => {
    const refresh = service();
    const issued = await refresh.issue({ subject: 'u1' });

    const results = await Promise.allSettled([
      refresh.rotate(issued.token),
      refresh.rotate(issued.token),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects an expired token', async () => {
    let clock = 1_000;
    const refresh = refreshService({
      store: memoryRefreshTokenStore({ now: () => clock }),
      ttlSeconds: 60,
      now: () => clock,
    });
    const issued = await refresh.issue({ subject: 'u1' });
    clock = 10_000;
    await expect(refresh.rotate(issued.token)).rejects.toThrow(/expired/);
  });

  it('revokes the family on explicit revoke', async () => {
    const refresh = service();
    const issued = await refresh.issue({ subject: 'u1' });
    await refresh.revoke(issued.token);
    await expect(refresh.rotate(issued.token)).rejects.toThrow(/not recognised/);
  });

  // The service pre-checks expiry against its own clock before ever touching
  // the store, then relies on the store's atomic compare-and-swap for the
  // real decision. If the store's clock (independently configurable, e.g. a
  // different replica) has already moved past expiry by the time the swap
  // runs, the store reports 'expired' even though the service's own
  // pre-check passed.
  it('surfaces a store-level expiry reported during the atomic rotate', async () => {
    let storeClock = 1_000;
    const store = memoryRefreshTokenStore({ now: () => storeClock });
    const refresh = refreshService({ store, ttlSeconds: 60, now: () => 1_000 });
    const issued = await refresh.issue({ subject: 'u1' });

    storeClock = 10_000;
    await expect(refresh.rotate(issued.token)).rejects.toThrow(/expired/);
  });

  it('surfaces a store-level not-found and revokeAllForSubject', async () => {
    const store = memoryRefreshTokenStore();
    const refresh = refreshService({ store });
    const issued = await refresh.issue({ subject: 'u1' });
    const original = store.rotate.bind(store);
    store.rotate = async () => ({ outcome: 'not-found' });
    await expect(refresh.rotate(issued.token)).rejects.toThrow(/not recognised/);
    store.rotate = original;

    expect(await refresh.revokeAllForSubject('u1')).toBeGreaterThanOrEqual(0);
    const again = await refresh.issue({ subject: 'u1' });
    expect(await refresh.revokeAllForSubject('u1')).toBeGreaterThanOrEqual(1);
    await expect(refresh.rotate(again.token)).rejects.toThrow(/not recognised/);
  });
});

describe('remoteJwks', () => {
  it('covers fetchJson and remoteJwks edge paths', async () => {
    const { remoteJwks } = await import('../src/tokens/jwks.ts');
    const pair = await generateKeyPair('ES256');
    const pub = toPublicJwk(pair.publicJwk);
    pub.kid = pair.kid;
    pub.use = 'sig';
    pub.alg = 'ES256';

    let clock = 1_000;
    let fetches = 0;
    let documents: unknown[] = [{ keys: [pub] }];
    const fetchImpl = (async () => {
      fetches++;
      const next = documents.shift() ?? { keys: [pub] };
      if (next instanceof Response) return next;
      return Response.json(next);
    }) as unknown as typeof fetch;

    const jwks = remoteJwks('https://idp.example/jwks', {
      fetch: fetchImpl,
      now: () => clock,
      cacheTtlMs: 1_000,
      minRefreshIntervalMs: 50,
      maxStaleMs: 10_000,
    });

    const key = await jwks.getKey({ alg: 'ES256', kid: pair.kid });
    expect(key).toBeInstanceOf(CryptoKey);
    expect(fetches).toBe(1);

    // Cache hit.
    await jwks.getKey({ alg: 'ES256', kid: pair.kid });
    expect(fetches).toBe(1);

    // Force refresh.
    await jwks.refresh();
    expect(fetches).toBe(2);

    // Stale-on-error.
    clock = 5_000;
    documents = [new Response('boom', { status: 500 })];
    await expect(jwks.refresh()).resolves.toMatchObject({ keys: [expect.any(Object)] });

    // Invalid JWKS shape.
    documents = [{ notKeys: true }];
    clock = 100_000;
    const cold = remoteJwks('https://idp.example/jwks', {
      fetch: fetchImpl,
      now: () => clock,
    });
    await expect(cold.get()).rejects.toThrow(/keys/);

    // Invalid JSON.
    documents = [
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ];
    await expect(
      fetchJson('https://idp.example/jwks', {
        timeoutMs: 1_000,
        maxBytes: 1_024,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/valid JSON/);

    // Body-less Response falls back to arrayBuffer.
    documents = [];
    await expect(
      fetchJson('https://idp.example/jwks', {
        timeoutMs: 1_000,
        maxBytes: 1_024,
        fetch: (async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: null,
            arrayBuffer: async () => new TextEncoder().encode('{"keys":[]}').buffer,
          }) as unknown as Response) as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ keys: [] });

    // Oversized body without a stream.
    await expect(
      fetchJson('https://idp.example/jwks', {
        timeoutMs: 1_000,
        maxBytes: 4,
        fetch: (async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: null,
            arrayBuffer: async () => new TextEncoder().encode('{"keys":[]}').buffer,
          }) as unknown as Response) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/over the 4 cap/);

    // Unknown kid triggers a rate-limited refresh; unsupported alg; no match.
    const rotating = remoteJwks('https://idp.example/jwks', {
      fetch: (async () => Response.json({ keys: [pub] })) as unknown as typeof fetch,
      now: () => clock,
      minRefreshIntervalMs: 1,
    });
    await rotating.getKey({ alg: 'ES256', kid: pair.kid });
    clock += 10;
    await expect(rotating.getKey({ alg: 'ES256', kid: 'missing' })).rejects.toThrow(/No JWKS key/);
    await expect(rotating.getKey({ alg: 'none' as never })).rejects.toThrow(/Unsupported JWS alg/);

    // Filter by use/alg and unambiguous single candidate without kid.
    const only = remoteJwks('https://idp.example/jwks', {
      fetch: (async () =>
        Response.json({
          keys: [{ ...pub, use: 'enc' }, { ...pub, alg: 'RS256' }, pub],
        })) as unknown as typeof fetch,
    });
    await expect(only.getKey({ alg: 'ES256' })).resolves.toBeInstanceOf(CryptoKey);
  });
});

describe('JWS payload decode failure after a valid signature', () => {
  it('rejects a payload that is not valid base64url once the signature verifies', async () => {
    const header = encode({ alg: 'HS256' });
    const badPayload = '+++'; // '+' is not base64url
    const signingInput = `${header}.${badPayload}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', hs256, new TextEncoder().encode(signingInput)),
    );
    const token = `${signingInput}.${base64UrlEncode(signature)}`;
    await expect(verifyJws(token, { algorithms: ['HS256'], key: hs256 })).rejects.toThrow(
      /payload is not valid base64url/,
    );
  });

  it('rejects a non-array crit header', async () => {
    await expect(
      verifyJws(`${encode({ alg: 'ES256', crit: 'exp' })}.${encode({ sub: 'u1' })}.AA`, {
        algorithms: ['ES256'],
        key: es256Public,
      }),
    ).rejects.toThrow(/critical parameters/);
  });

  it('accepts an empty crit array', async () => {
    const token = await signJws('{}', {
      algorithm: 'HS256',
      key: hs256,
      header: { crit: [] },
    });
    await expect(verifyJws(token, { algorithms: ['HS256'], key: hs256 })).resolves.toMatchObject({
      header: { crit: [] },
    });
  });
});
