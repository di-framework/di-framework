/** WebAuthn Level 3 ceremonies. Dependency-free; subpathed for tree-shaking. */

export {
  type AttestedCredentialData,
  type AuthenticatorDataFlags,
  type ParsedAuthenticatorData,
  parseAuthenticatorData,
  parseFlags,
  rpIdHashMatches,
} from './src/webauthn/authenticator-data.ts';
export {
  asCborMap,
  type CborDecodeOptions,
  CborError,
  type CborValue,
  cborBytes,
  cborInt,
  cborText,
  decodeCbor,
  decodeCborAt,
} from './src/webauthn/cbor.ts';
export {
  type ClientDataExpectations,
  normalizeOrigin,
  type ParsedClientData,
  parseClientData,
  verifyClientData,
} from './src/webauthn/client-data.ts';
export {
  COSE_ALG,
  type CoseAlgorithm,
  type CoseKey,
  DEFAULT_PUBKEY_CRED_PARAMS,
  importCoseKey,
  isSupportedCoseAlgorithm,
  parseCoseKey,
  verifyCoseSignature,
} from './src/webauthn/cose.ts';
export {
  type WebAuthnService,
  type WebAuthnServiceOptions,
  webAuthnService,
} from './src/webauthn/service.ts';
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  VerifiedAuthentication,
  VerifiedRegistration,
  WebAuthnCeremony,
  WebAuthnConfig,
} from './src/webauthn/types.ts';
