import { base64UrlDecode, base64UrlEncode } from '../crypto/base64url.ts';
import { concatBytes, sha256 } from '../crypto/hash.ts';
import { randomBytes, randomToken } from '../crypto/random.ts';
import { AuthError } from '../errors.ts';
import { createPrincipal } from '../principal.ts';
import type {
  CredentialStore,
  StateStore,
  UserStore,
  WebAuthnCredential,
} from '../providers/types.ts';
import { isAlgorithmSupported } from '../tokens/algorithms.ts';
import { parseAuthenticatorData, rpIdHashMatches } from './authenticator-data.ts';
import { asCborMap, type CborValue, decodeCbor } from './cbor.ts';
import { parseClientData, verifyClientData } from './client-data.ts';
import {
  COSE_ALG,
  type CoseAlgorithm,
  DEFAULT_PUBKEY_CRED_PARAMS,
  isSupportedCoseAlgorithm,
  parseCoseKey,
  verifyCoseSignature,
} from './cose.ts';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  VerifiedAuthentication,
  VerifiedRegistration,
  WebAuthnCeremony,
  WebAuthnConfig,
} from './types.ts';

/**
 * WebAuthn Level 3 registration and authentication ceremonies, implemented over
 * WebCrypto with no dependencies.
 */

export interface WebAuthnService {
  generateRegistrationOptions(input: {
    userId: string;
    username: string;
    displayName?: string;
    excludeCredentials?: ReadonlyArray<{ id: string; transports?: string[] }>;
    authenticatorAttachment?: 'platform' | 'cross-platform';
    extensions?: Record<string, unknown>;
  }): Promise<WebAuthnCeremony<PublicKeyCredentialCreationOptionsJSON>>;

  verifyRegistrationResponse(
    response: RegistrationResponseJSON,
    context: { challengeKey: string },
  ): Promise<VerifiedRegistration>;

  generateAuthenticationOptions(input?: {
    userId?: string;
    userVerification?: 'required' | 'preferred' | 'discouraged';
    extensions?: Record<string, unknown>;
  }): Promise<WebAuthnCeremony<PublicKeyCredentialRequestOptionsJSON>>;

  verifyAuthenticationResponse(
    response: AuthenticationResponseJSON,
    context: { challengeKey: string },
  ): Promise<VerifiedAuthentication>;
}

export interface WebAuthnServiceOptions {
  config: WebAuthnConfig;
  credentials: CredentialStore;
  state: StateStore;
  users: UserStore;
}

const REGISTRATION_PURPOSE = 'webauthn-registration';
const AUTHENTICATION_PURPOSE = 'webauthn-authentication';

interface CeremonyState extends Record<string, unknown> {
  challenge: string;
  userId?: string;
  userVerification?: string;
  allowCredentialIds?: string[];
}

function reject(
  message: string,
  code:
    | 'challenge_not_found'
    | 'origin_mismatch'
    | 'credential_exists'
    | 'credential_not_found'
    | 'clone_detected'
    | 'attestation_unsupported'
    | 'malformed_credential'
    | 'invalid_signature',
  status = 400,
): never {
  throw new AuthError(message, { code, status });
}

export function webAuthnService(options: WebAuthnServiceOptions): WebAuthnService {
  const { config, credentials, state, users } = options;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  const challengeBytes = config.challengeBytes ?? 32;
  const challengeTtl = config.challengeTtlSeconds ?? 300;
  const pubKeyCredParams = config.pubKeyCredParams ?? DEFAULT_PUBKEY_CRED_PARAMS;
  const supportedFormats = config.supportedAttestationFormats ?? ['none', 'packed'];
  const attestationPreference = config.attestation ?? 'none';
  const requireUv = config.requireUserVerification === true;
  const onClone = config.onCloneDetected ?? 'throw';

  if (challengeBytes < 16) {
    throw new RangeError(
      `WebAuthnConfig.challengeBytes must be at least 16 (WebAuthn L3 §13.4.3); received ${challengeBytes}`,
    );
  }
  for (const alg of pubKeyCredParams) {
    if (!isSupportedCoseAlgorithm(alg)) {
      throw new RangeError(`Unsupported COSE algorithm ${alg} in pubKeyCredParams`);
    }
  }
  // Warn at construction rather than at registration: a credential created with
  // an algorithm this runtime cannot verify is permanently unusable, and the
  // user only discovers that when they try to sign in. The probe is async and
  // this factory is not, so this reports rather than throws — registration
  // itself still fails closed, in `importCoseKey`.
  if (pubKeyCredParams.includes(COSE_ALG.EdDSA)) {
    void isAlgorithmSupported('EdDSA').then((supported) => {
      if (!supported)
        console.error(
          '[@di-framework/auth] WebAuthnConfig.pubKeyCredParams offers EdDSA (-8) but this ' +
            "runtime's WebCrypto cannot verify Ed25519. Credentials registered with it will be " +
            'permanently unusable. Remove -8 from pubKeyCredParams.',
        );
    });
  }

  const issueChallenge = async (
    purpose: string,
    data: Omit<CeremonyState, 'challenge'>,
  ): Promise<{ challenge: string; challengeKey: string; expiresAt: number }> => {
    const challenge = base64UrlEncode(randomBytes(challengeBytes));
    // The key is a separate opaque handle rather than the challenge itself, so
    // the value the client carries in a cookie is not the value the
    // authenticator signs over.
    const challengeKey = randomToken(32);
    const expiresAt = now() + challengeTtl;
    await state.put({
      purpose,
      key: challengeKey,
      data: { ...data, challenge } satisfies CeremonyState,
      expiresAt,
    });
    return { challenge, challengeKey, expiresAt };
  };

  const consumeChallenge = async (
    purpose: string,
    challengeKey: string,
  ): Promise<CeremonyState> => {
    // Single-use is enforced here, by the store's atomic consume. The challenge
    // comparison in `verifyClientData` is a separate check: consume proves
    // freshness, the comparison proves the authenticator signed *our* challenge.
    const entry = await state.consume<CeremonyState>(purpose, challengeKey);
    if (!entry) reject('Challenge expired or was already used', 'challenge_not_found');
    return entry.data;
  };

  return {
    async generateRegistrationOptions(input) {
      const user = await users.findById(input.userId);
      if (!user) reject(`No user '${input.userId}'`, 'credential_not_found', 404);

      // WebAuthn L3 §5.4.3 forbids personally identifying information in the
      // user handle. Deriving it here — rather than accepting one from the
      // caller — is what stops an email address ending up in it.
      let handle = user.webauthnUserHandle;
      if (!handle) {
        handle = randomToken(32);
        await users.update(user.id, { webauthnUserHandle: handle });
      }

      const { challenge, challengeKey, expiresAt } = await issueChallenge(REGISTRATION_PURPOSE, {
        userId: user.id,
      });

      const existing = input.excludeCredentials ?? (await credentials.listWebAuthn(user.id));

      return {
        challengeKey,
        expiresAt,
        options: {
          rp: { id: config.rpId, name: config.rpName },
          user: {
            id: handle,
            name: input.username,
            displayName: input.displayName ?? input.username,
          },
          challenge,
          pubKeyCredParams: pubKeyCredParams.map((alg) => ({ type: 'public-key' as const, alg })),
          timeout: config.registrationTimeoutMs ?? 300_000,
          excludeCredentials: existing.map((credential) => ({
            id: credential.id,
            type: 'public-key' as const,
            ...(credential.transports ? { transports: [...credential.transports] } : {}),
          })),
          authenticatorSelection: {
            residentKey: config.residentKey ?? 'preferred',
            userVerification: config.userVerification ?? 'preferred',
            ...(input.authenticatorAttachment
              ? { authenticatorAttachment: input.authenticatorAttachment }
              : {}),
          },
          attestation: attestationPreference,
          ...(input.extensions ? { extensions: input.extensions } : {}),
        },
      };
    },

    async verifyRegistrationResponse(response, context) {
      const ceremony = await consumeChallenge(REGISTRATION_PURPOSE, context.challengeKey);
      const userId = ceremony.userId;
      if (!userId) reject('Registration ceremony has no user', 'challenge_not_found');

      const clientData = parseClientData(base64UrlDecode(response.response.clientDataJSON));
      await verifyClientData(clientData, {
        type: 'webauthn.create',
        challenge: ceremony.challenge,
        origins: config.origins,
      });

      const attestationObject = asCborMap(
        decodeCbor(base64UrlDecode(response.response.attestationObject)),
        'attestationObject',
      );
      const fmt = attestationObject.get('fmt');
      const attStmt = attestationObject.get('attStmt');
      const authDataBytes = attestationObject.get('authData');
      if (typeof fmt !== 'string') reject('attestationObject has no fmt', 'malformed_credential');
      if (!(authDataBytes instanceof Uint8Array))
        reject('attestationObject has no authData', 'malformed_credential');
      if (!(attStmt instanceof Map))
        reject('attestationObject has no attStmt', 'malformed_credential');

      const authData = parseAuthenticatorData(authDataBytes);

      if (!(await rpIdHashMatches(authData.rpIdHash, config.rpId)))
        reject(
          `Authenticator data rpIdHash does not match rpId '${config.rpId}'`,
          'origin_mismatch',
        );
      if (!authData.flags.up) reject('User presence flag was not set', 'malformed_credential');
      if (requireUv && !authData.flags.uv)
        reject('User verification was required but not performed', 'malformed_credential');
      if (!authData.flags.at || !authData.attestedCredentialData)
        reject('Registration response carries no attested credential data', 'malformed_credential');
      // BS without BE is an impossible state per WebAuthn L3 §6.1.3.
      if (authData.flags.bs && !authData.flags.be)
        reject('Backup state is set without backup eligibility', 'malformed_credential');

      const attested = authData.attestedCredentialData;
      const coseKey = attested.coseKey;
      if (!pubKeyCredParams.includes(coseKey.alg as CoseAlgorithm))
        reject(
          `Credential algorithm ${coseKey.alg} was not among the offered algorithms`,
          'malformed_credential',
        );

      const clientDataHash = await sha256(clientData.bytes);
      const attestation = await verifyAttestationStatement({
        fmt,
        attStmt,
        authData,
        clientDataHash,
        coseKey,
        supportedFormats,
        attestationPreference,
        custom: config.verifyAttestation,
      });

      // WebAuthn L3 §7.1 step 27: the credential must not already be registered
      // to any user, not merely to this one.
      const alreadyRegistered = await credentials.findWebAuthn(attested.credentialIdBase64Url);
      if (alreadyRegistered) {
        reject('This credential is already registered', 'credential_exists', 409);
      }

      const credential: WebAuthnCredential = {
        kind: 'webauthn',
        id: attested.credentialIdBase64Url,
        userId,
        publicKeyCose: base64UrlEncode(attested.credentialPublicKey),
        algorithm: coseKey.alg,
        signCount: authData.signCount,
        backupEligible: authData.flags.be,
        backupState: authData.flags.bs,
        uvInitialized: authData.flags.uv,
        aaguid: attested.aaguidHex,
        attestationFormat: fmt,
        createdAt: now(),
        version: 0,
        ...(response.response.transports ? { transports: response.response.transports } : {}),
      };

      return { credential, attestation, flags: authData.flags };
    },

    async generateAuthenticationOptions(input = {}) {
      const allowCredentials = input.userId
        ? await credentials.listWebAuthn(input.userId)
        : undefined;

      const { challenge, challengeKey, expiresAt } = await issueChallenge(AUTHENTICATION_PURPOSE, {
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.userVerification ? { userVerification: input.userVerification } : {}),
        ...(allowCredentials ? { allowCredentialIds: allowCredentials.map((c) => c.id) } : {}),
      });

      return {
        challengeKey,
        expiresAt,
        options: {
          challenge,
          rpId: config.rpId,
          timeout: config.authenticationTimeoutMs ?? 60_000,
          userVerification: input.userVerification ?? config.userVerification ?? 'preferred',
          ...(allowCredentials
            ? {
                allowCredentials: allowCredentials
                  .filter((credential) => !credential.disabled)
                  .map((credential) => ({
                    id: credential.id,
                    type: 'public-key' as const,
                    ...(credential.transports ? { transports: [...credential.transports] } : {}),
                  })),
              }
            : {}),
          ...(input.extensions ? { extensions: input.extensions } : {}),
        },
      };
    },

    async verifyAuthenticationResponse(response, context) {
      const ceremony = await consumeChallenge(AUTHENTICATION_PURPOSE, context.challengeKey);

      const credential = await credentials.findWebAuthn(response.id);
      if (!credential) reject('Credential is not recognised', 'credential_not_found', 404);
      if (credential.disabled) reject('Credential is disabled', 'credential_not_found', 403);

      // WebAuthn L3 §7.2 step 5: when the ceremony named a credential set, the
      // response must come from that set.
      if (ceremony.allowCredentialIds && !ceremony.allowCredentialIds.includes(response.id)) {
        reject('Credential was not among those allowed for this ceremony', 'credential_not_found');
      }
      if (ceremony.userId && ceremony.userId !== credential.userId)
        reject(
          'Credential does not belong to the user who started this ceremony',
          'credential_not_found',
        );

      // Discoverable-credential flow: the client tells us who it is, and the
      // handle must agree with the credential's owner.
      if (response.response.userHandle) {
        const user = await users.findByWebAuthnHandle(response.response.userHandle);
        if (!user || user.id !== credential.userId)
          reject('User handle does not match the credential owner', 'credential_not_found');
      }

      const clientData = parseClientData(base64UrlDecode(response.response.clientDataJSON));
      await verifyClientData(clientData, {
        type: 'webauthn.get',
        challenge: ceremony.challenge,
        origins: config.origins,
      });

      const authDataBytes = base64UrlDecode(response.response.authenticatorData);
      const authData = parseAuthenticatorData(authDataBytes);

      if (!(await rpIdHashMatches(authData.rpIdHash, config.rpId))) {
        reject(
          `Authenticator data rpIdHash does not match rpId '${config.rpId}'`,
          'origin_mismatch',
        );
      }
      if (!authData.flags.up) reject('User presence flag was not set', 'malformed_credential');
      const uvRequired = requireUv || ceremony.userVerification === 'required';
      if (uvRequired && !authData.flags.uv) {
        reject('User verification was required but not performed', 'malformed_credential');
      }

      // BE is immutable for the life of a credential (L3 §6.1.3); a change means
      // a different authenticator or tampering.
      if (authData.flags.be !== credential.backupEligible) {
        reject('Backup eligibility changed, which is not permitted', 'malformed_credential');
      }
      if (authData.flags.bs && !authData.flags.be) {
        reject('Backup state is set without backup eligibility', 'malformed_credential');
      }
      const backupStateChanged = authData.flags.bs !== credential.backupState;

      const coseKey = parseCoseKey(base64UrlDecode(credential.publicKeyCose));
      const signedData = concatBytes(authDataBytes, await sha256(clientData.bytes));
      const signature = base64UrlDecode(response.response.signature);
      if (!(await verifyCoseSignature(coseKey, signature, signedData)))
        reject('Assertion signature is invalid', 'invalid_signature', 401);

      // Sign-count handling. A stored and received count of zero means the
      // authenticator does not implement a counter at all — which is the
      // *common* case for platform passkeys (iCloud Keychain, Google Password
      // Manager, Windows Hello) and must not be treated as an error.
      const signCountSupported = !(credential.signCount === 0 && authData.signCount === 0);
      let cloneWarning = false;
      if (signCountSupported && authData.signCount <= credential.signCount) {
        cloneWarning = true;
        if (onClone === 'throw')
          reject(
            `Sign count regressed (stored ${credential.signCount}, received ${authData.signCount}); ` +
              'the authenticator may have been cloned',
            'clone_detected',
            401,
          );
        console.warn(
          `[@di-framework/auth] Sign count regression on credential '${credential.id}' ` +
            `(stored ${credential.signCount}, received ${authData.signCount}).`,
        );
      }

      // Compare-and-swap. Without it, two concurrent replays of one assertion
      // both read the old count, both see an increment, and both are accepted.
      const swapped = await credentials.updateSignCount(
        credential.id,
        authData.signCount,
        credential.version,
        now(),
        authData.flags.bs,
      );
      if (!swapped) reject('Concurrent use of this credential was detected', 'clone_detected', 409);

      return {
        credentialId: credential.id,
        userId: credential.userId,
        newSignCount: authData.signCount,
        signCountSupported,
        cloneWarning,
        backupStateChanged,
        flags: authData.flags,
        principal: createPrincipal({
          sub: credential.userId,
          method: 'webauthn',
          // RFC 8176: `hwk` for a hardware key, `user` for user verification,
          // `mfa` because a verified passkey is two factors in one gesture.
          amr: authData.flags.uv ? ['hwk', 'user', 'mfa'] : ['hwk'],
          authTime: now(),
        }),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Attestation                                                                */
/* -------------------------------------------------------------------------- */

async function verifyAttestationStatement(input: {
  fmt: string;
  attStmt: Map<CborValue, CborValue>;
  authData: ReturnType<typeof parseAuthenticatorData>;
  clientDataHash: Uint8Array;
  coseKey: ReturnType<typeof parseCoseKey>;
  supportedFormats: readonly string[];
  attestationPreference: 'none' | 'indirect' | 'direct';
  custom: WebAuthnConfig['verifyAttestation'];
}): Promise<{ fmt: string; verified: boolean; trustPath: 'none' | 'self' | string }> {
  const { fmt, attStmt, authData, clientDataHash, coseKey } = input;

  if (input.custom) {
    const result = await input.custom({ fmt, attStmt, authData, clientDataHash });
    return { fmt, ...result };
  }

  if (!input.supportedFormats.includes(fmt)) {
    reject(
      `Attestation format '${fmt}' is not supported. v1 verifies 'none' and self-attested ` +
        "'packed' only; supply WebAuthnConfig.verifyAttestation to handle others.",
      'attestation_unsupported',
    );
  }

  if (fmt === 'none') {
    if (attStmt.size !== 0)
      reject("Format 'none' must carry an empty attStmt", 'malformed_credential');
    return { fmt, verified: false, trustPath: 'none' };
  }

  if (fmt === 'packed') {
    if (attStmt.has('x5c')) {
      // Full attestation requires FIDO Metadata Service integration, which is a
      // documented non-goal. Silently ignoring a statement the operator asked
      // for and believes is being checked would be worse than refusing.
      if (input.attestationPreference === 'direct') {
        reject(
          'Full attestation with an x5c certificate chain is not verified in v1. Supply ' +
            "WebAuthnConfig.verifyAttestation, or set attestation: 'none'.",
          'attestation_unsupported',
        );
      }
      // The browser returned more than was asked for. Ignore it rather than
      // failing a registration the caller never wanted attestation for.
      return { fmt, verified: false, trustPath: 'none' };
    }

    const alg = attStmt.get('alg');
    const sig = attStmt.get('sig');
    if (typeof alg !== 'number') reject("Packed attStmt has no 'alg'", 'malformed_credential');
    if (!(sig instanceof Uint8Array)) reject("Packed attStmt has no 'sig'", 'malformed_credential');
    if (alg !== coseKey.alg)
      reject('Self-attestation alg does not match the credential key', 'malformed_credential');

    // Self-attestation: the credential key signs its own registration. This
    // proves the authenticator holds the private key. It proves nothing about
    // the authenticator's make or model — that is the part we are not doing.
    const signedData = concatBytes(authData.bytes, clientDataHash);
    if (!(await verifyCoseSignature(coseKey, sig, signedData)))
      reject('Self-attestation signature is invalid', 'invalid_signature');
    return { fmt, verified: true, trustPath: 'self' };
  }

  return reject(`Unhandled attestation format '${fmt}'`, 'attestation_unsupported');
}
