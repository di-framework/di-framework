import type { Principal } from '../principal.ts';
import type { WebAuthnCredential } from '../providers/types.ts';
import type { AuthenticatorDataFlags, ParsedAuthenticatorData } from './authenticator-data.ts';
import type { CborValue } from './cbor.ts';
import type { CoseAlgorithm } from './cose.ts';

export interface WebAuthnConfig {
  /** Relying Party ID — a registrable domain suffix of the origin, e.g. `example.com`. */
  rpId: string;
  rpName: string;
  /** Full origins permitted to run ceremonies. Compared exactly. */
  origins: readonly string[];
  /** Challenge entropy. Default 32; WebAuthn L3 §13.4.3 sets the floor at 16. */
  challengeBytes?: number;
  /** Challenge lifetime in seconds. Default 300. */
  challengeTtlSeconds?: number;
  registrationTimeoutMs?: number;
  authenticationTimeoutMs?: number;
  /** Offered algorithms. Default `[-7, -257]`; see `DEFAULT_PUBKEY_CRED_PARAMS`. */
  pubKeyCredParams?: readonly CoseAlgorithm[];
  attestation?: 'none' | 'indirect' | 'direct';
  /** Formats accepted at verification. Default `['none', 'packed']`. */
  supportedAttestationFormats?: readonly string[];
  /** Ceremony *hint* sent to the client. */
  userVerification?: 'required' | 'preferred' | 'discouraged';
  residentKey?: 'required' | 'preferred' | 'discouraged';
  /**
   * Verification-time *enforcement* of the UV flag, independent of the hint
   * above. A `preferred` hint means the authenticator may skip user
   * verification, so relying on the hint alone to gate sensitive operations is a
   * common and quiet mistake.
   */
  requireUserVerification?: boolean;
  /** Response to a sign-count regression. Default `'throw'`. */
  onCloneDetected?: 'throw' | 'warn';
  /**
   * Full attestation verification, the seam for the documented non-goal.
   * Supplying this replaces the built-in `none`/`packed` handling entirely.
   */
  verifyAttestation?: (input: {
    fmt: string;
    attStmt: Map<CborValue, CborValue>;
    authData: ParsedAuthenticatorData;
    clientDataHash: Uint8Array;
  }) => Promise<{ verified: boolean; trustPath: string }>;
  now?: () => number;
}

export interface PublicKeyCredentialDescriptorJSON {
  id: string;
  type: 'public-key';
  transports?: string[];
}

export interface PublicKeyCredentialCreationOptionsJSON {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: {
    authenticatorAttachment?: 'platform' | 'cross-platform';
    residentKey?: 'required' | 'preferred' | 'discouraged';
    requireResidentKey?: boolean;
    userVerification?: 'required' | 'preferred' | 'discouraged';
  };
  attestation?: 'none' | 'indirect' | 'direct';
  extensions?: Record<string, unknown>;
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId: string;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: 'required' | 'preferred' | 'discouraged';
  extensions?: Record<string, unknown>;
}

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  authenticatorAttachment?: 'platform' | 'cross-platform';
  clientExtensionResults?: Record<string, unknown>;
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  authenticatorAttachment?: 'platform' | 'cross-platform';
  clientExtensionResults?: Record<string, unknown>;
}

export interface WebAuthnCeremony<T> {
  /** Feed straight to `PublicKeyCredential.parseCreationOptionsFromJSON()`. */
  options: T;
  /**
   * Opaque handle the client must return with the response. Carry it in a
   * short-lived `__Host-webauthn` cookie — the README shows the pattern.
   */
  challengeKey: string;
  expiresAt: number;
}

export interface VerifiedRegistration {
  /** Ready to persist via `CredentialStore.saveWebAuthn`. */
  credential: WebAuthnCredential;
  attestation: { fmt: string; verified: boolean; trustPath: 'none' | 'self' | string };
  flags: AuthenticatorDataFlags;
}

export interface VerifiedAuthentication {
  credentialId: string;
  userId: string;
  newSignCount: number;
  /** False when the authenticator does not implement a counter — the common case. */
  signCountSupported: boolean;
  cloneWarning: boolean;
  /** The passkey started or stopped syncing; you may want to re-verify the user. */
  backupStateChanged: boolean;
  flags: AuthenticatorDataFlags;
  principal: Principal;
}
